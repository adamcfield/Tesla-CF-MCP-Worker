/**
 * Reverse geocoding via OpenStreetMap Nominatim (free; no key) so drives get
 * human place names ("Dizengoff St, Tel Aviv") instead of "Unknown".
 *
 * Nominatim usage policy compliance: identifying User-Agent, ≤1 req/s (we do
 * at most two lookups per drive close — far under), and results are cached in
 * D1 by ~110 m grid (3-decimal lat/lon rounding) so repeat locations (home,
 * work) never re-query.
 */

import { Env } from "./types";

const UA = "tesla-cf-mcp-worker/1.0 (personal vehicle logger; github.com/adamcfield/Tesla-CF-MCP-Worker)";

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
      `SELECT label FROM geocode_cache WHERE lat_r = ?1 AND lon_r = ?2`,
    )
      .bind(latR, lonR)
      .first<{ label: string }>();
    if (cached) return cached.label;

    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&accept-language=en`;
    const resp = await fetch(url, { headers: { "user-agent": UA } });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { address?: Record<string, string>; display_name?: string };
    const label = body.address
      ? shortLabel(body.address, (body.display_name ?? "").split(",").slice(0, 2).join(",").trim())
      : null;
    if (label) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO geocode_cache (lat_r, lon_r, label, created_ts) VALUES (?1, ?2, ?3, ?4)`,
      )
        .bind(latR, lonR, label, Math.floor(Date.now() / 1000))
        .run();
    }
    return label;
  } catch {
    return null; // geocoding must never break drive finalization
  }
}
