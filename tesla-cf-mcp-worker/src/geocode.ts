/**
 * Reverse geocoding via OpenStreetMap Nominatim (free; no key) so drives get
 * human place names ("Dizengoff St, Tel Aviv") instead of "Unknown".
 *
 * Nominatim usage policy compliance: identifying User-Agent, ≤1 req/s (we do
 * at most two lookups per drive close — far under), and results are cached in
 * D1 by ~110 m grid (3-decimal lat/lon rounding) so repeat locations (home,
 * work) never re-query.
 *
 * Hardening: every lookup carries a hard timeout (a slow upstream must never
 * stall drive finalization), and FAILED lookups are negative-cached for a day
 * (label='') so an outage doesn't re-hit Nominatim on every close/backfill.
 */

import { Env } from "./types";

const UA = "tesla-cf-mcp-worker/1.0 (personal vehicle logger; github.com/adamcfield/Tesla-CF-MCP-Worker)";

const TIMEOUT_MS = 4000;
const NEGATIVE_TTL_S = 86400; // retry failed lookups after a day

const roundCoord = (n: number): number => Math.round(n * 1000) / 1000;

/** Short, human label from a Nominatim address object: "road, locality". */
function shortLabel(addr: Record<string, string>, fallback: string): string {
  const road = addr.road ?? addr.pedestrian ?? addr.suburb ?? addr.neighbourhood;
  const locality = addr.city ?? addr.town ?? addr.village ?? addr.municipality ?? addr.county;
  const parts = [road, locality].filter(Boolean);
  return parts.length ? parts.join(", ") : fallback;
}

export async function reverseGeocode(env: Env, lat: number, lon: number): Promise<string | null> {
  const latR = roundCoord(lat);
  const lonR = roundCoord(lon);
  try {
    const cached = await env.DB.prepare(
      `SELECT label, created_ts FROM geocode_cache WHERE lat_r = ?1 AND lon_r = ?2`,
    )
      .bind(latR, lonR)
      .first<{ label: string; created_ts: number | null }>();
    if (cached) {
      if (cached.label !== "") return cached.label;
      // Negative-cache hit: a recent failed lookup — don't re-query yet.
      const age = Math.floor(Date.now() / 1000) - (cached.created_ts ?? 0);
      if (age < NEGATIVE_TTL_S) return null;
    }

    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&accept-language=en`;
    const resp = await fetch(url, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
      await cachePut(env, latR, lonR, ""); // negative-cache the failure
      return null;
    }
    const body = (await resp.json()) as { address?: Record<string, string>; display_name?: string };
    const label = body.address
      ? shortLabel(body.address, (body.display_name ?? "").split(",").slice(0, 2).join(",").trim())
      : null;
    await cachePut(env, latR, lonR, label ?? "");
    return label;
  } catch {
    // Timeout / network error: negative-cache so a dead upstream can't stall
    // every subsequent drive close during the outage.
    await cachePut(env, latR, lonR, "").catch(() => {});
    return null;
  }
}

async function cachePut(env: Env, latR: number, lonR: number, label: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO geocode_cache (lat_r, lon_r, label, created_ts) VALUES (?1, ?2, ?3, ?4)`,
  )
    .bind(latR, lonR, label, Math.floor(Date.now() / 1000))
    .run();
}
