/**
 * Posted-speed-limit lookup so speeding is measured against the ACTUAL legal
 * limit per road, not a flat 120 km/h line (which both misses urban speeding
 * and penalises legal highway cruising).
 *
 * Source: OSM `maxspeed` tags via a single batched Overpass query over the
 * drive's bounding box on close, snapping each ~110 m grid cell to the nearest
 * road node. Results (including "no limit found" as a negative cache) live in
 * the road_segments D1 table keyed on the same 3-decimal grid as geocode.ts,
 * so repeat roads never re-query. Best-effort: on any Overpass failure/timeout
 * the drive keeps the flat-limit fallback and records speed_limit_source="none".
 */

import { haversineMeters, num } from "./store";
import { Env } from "./types";

const roundCoord = (n: number): number => Math.round(n * 1000) / 1000;
const NEG = -1; // negative-cache sentinel: "looked up, no maxspeed near here"

/** Parse an OSM maxspeed tag to km/h. Handles "50", "50 mph", and IL:* zones. */
export function parseMaxspeed(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "none") return null;
  // Israeli implicit zone tags (Survey-of-Israel / OSM IL defaults).
  if (s.includes("urban")) return 50;
  if (s.includes("rural")) return 80;
  if (s.includes("motorway")) return 110;
  const m = /^(\d+(?:\.\d+)?)\s*(mph)?/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2] === "mph" ? Math.round(n * 1.609344) : n;
}

interface Way {
  maxspeed: number;
  nodes: Array<{ lat: number; lon: number }>;
}

/** Fetches ways with a maxspeed tag inside a bbox from Overpass (best-effort). */
async function fetchWays(bbox: { s: number; w: number; n: number; e: number }): Promise<Way[]> {
  const q =
    `[out:json][timeout:20];way["maxspeed"](${bbox.s},${bbox.w},${bbox.n},${bbox.e});out geom;`;
  const resp = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "User-Agent": "tesla-cf-mcp-worker/1.0" },
    body: "data=" + encodeURIComponent(q),
    signal: AbortSignal.timeout(9000),
  });
  if (!resp.ok) throw new Error(`overpass ${resp.status}`);
  const data = (await resp.json()) as { elements?: Array<{ tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }> }> };
  const ways: Way[] = [];
  for (const el of data.elements ?? []) {
    const ms = parseMaxspeed(el.tags?.maxspeed);
    if (ms === null || !Array.isArray(el.geometry)) continue;
    ways.push({ maxspeed: ms, nodes: el.geometry });
  }
  return ways;
}

/**
 * Returns a per-sample posted limit (km/h) aligned to `samples`, plus the
 * source. Cache-first by grid cell; one Overpass call fills all misses.
 */
export async function postedLimitsForSamples(
  env: Env,
  samples: Array<{ lat: number | null; lon: number | null }>,
): Promise<{ limits: Array<number | null>; source: "osm" | "partial" | "none" }> {
  const pts = samples.map((s) => ({ lat: num(s.lat), lon: num(s.lon) }));
  const valid = pts.filter((p): p is { lat: number; lon: number } => p.lat !== null && p.lon !== null);
  if (valid.length === 0) return { limits: samples.map(() => null), source: "none" };

  // Unique grid cells for this drive.
  const cells = new Map<string, { lat_r: number; lon_r: number }>();
  for (const p of valid) {
    const lat_r = roundCoord(p.lat);
    const lon_r = roundCoord(p.lon);
    cells.set(`${lat_r},${lon_r}`, { lat_r, lon_r });
  }

  // Cache lookup.
  const cellLimit = new Map<string, number | null>(); // key -> kmh (or null for negative)
  const missing: Array<{ lat_r: number; lon_r: number }> = [];
  for (const [key, c] of cells) {
    const row = await env.DB.prepare(
      `SELECT maxspeed_kmh FROM road_segments WHERE lat_r = ?1 AND lon_r = ?2`,
    ).bind(c.lat_r, c.lon_r).first<{ maxspeed_kmh: number }>().catch(() => null);
    if (row) cellLimit.set(key, row.maxspeed_kmh === NEG ? null : row.maxspeed_kmh);
    else missing.push(c);
  }

  let hadFetchError = false;
  if (missing.length > 0) {
    // One Overpass query over the drive bbox (padded), then snap each missing
    // cell to the nearest road node within 60 m.
    const lats = valid.map((p) => p.lat);
    const lons = valid.map((p) => p.lon);
    const pad = 0.003;
    const bbox = { s: Math.min(...lats) - pad, w: Math.min(...lons) - pad, n: Math.max(...lats) + pad, e: Math.max(...lons) + pad };
    let ways: Way[] = [];
    try {
      ways = await fetchWays(bbox);
    } catch {
      hadFetchError = true;
    }
    if (!hadFetchError) {
      for (const c of missing) {
        let best: { d: number; ms: number } | null = null;
        for (const w of ways) {
          for (const nd of w.nodes) {
            const d = haversineMeters(c.lat_r, c.lon_r, nd.lat, nd.lon);
            if (d <= 60 && (best === null || d < best.d)) best = { d, ms: w.maxspeed };
          }
        }
        const key = `${c.lat_r},${c.lon_r}`;
        cellLimit.set(key, best?.ms ?? null);
        // Cache (negative cache uses NEG so we don't re-query dead cells).
        await env.DB.prepare(
          `INSERT OR REPLACE INTO road_segments (lat_r, lon_r, maxspeed_kmh, created_ts) VALUES (?1,?2,?3,?4)`,
        ).bind(c.lat_r, c.lon_r, best?.ms ?? NEG, Math.floor(Date.now() / 1000)).run().catch(() => {});
      }
    }
  }

  const limits = pts.map((p) => {
    if (p.lat === null || p.lon === null) return null;
    const key = `${roundCoord(p.lat)},${roundCoord(p.lon)}`;
    return cellLimit.has(key) ? cellLimit.get(key)! : null;
  });
  const anyLimit = limits.some((l) => l !== null);
  const source = hadFetchError && !anyLimit ? "none" : anyLimit ? (hadFetchError ? "partial" : "osm") : "none";
  return { limits, source };
}
