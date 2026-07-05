/**
 * GovMap (Israeli national map, מפ"י / govmap.gov.il) integration.
 *
 * Two capabilities, both usable anonymously (no token, no API key — the
 * GOVMAP_API_KEY secret is retained only for a possible future licensed/
 * high-volume path and is NOT required here):
 *
 *   1. Tile proxy  — GovMap's basemap CDN (basemaps.govmap.gov.il) enforces a
 *      Referer allow-list; only Referer https://www.govmap.gov.il/ returns 200.
 *      Browsers can't forge Referer, so tiles MUST be fetched server-side. This
 *      worker sets the Referer and streams the tile back with a wildcard CORS
 *      header and a long edge cache, so Leaflet loads them like any XYZ layer.
 *
 *      GovMap re-platformed onto GeoServer/GeoWebCache: basemaps are now
 *      standard EPSG:3857 XYZ (256px, top-left origin) — no ITM/Proj4Leaflet
 *      needed. Despite the "/tms/" path segment, ortho is NOT y-flipped.
 *
 *   2. Forward geocode (address text → lat/lon) — GovMap's own search service
 *      is markedly better than Nominatim for Israeli addresses. Returns WKT
 *      POINT in EPSG:3857 metres, converted here to WGS84. Falls back to OSM
 *      Nominatim if GovMap is unreachable or returns nothing.
 *
 * Reverse geocoding (lat/lon → street address) stays on Nominatim (geocode.ts):
 * GovMap has no clean anonymous point→address endpoint (its open reverse route
 * returns cadastral parcels, not human addresses).
 *
 * All endpoint facts live-verified 2026-07-05. These are undocumented internal
 * endpoints — cached aggressively, kept low-volume, with fallbacks — not a
 * licensed API. The date-stamped tile folders rotate; they're pinned here in
 * one place, and every tile request fails over to Esri automatically.
 */

import { Env } from "./types";

/** Basemap layers we expose, each mapped to its upstream GovMap CDN template. */
const TILE_UPSTREAM: Record<string, (z: string, x: string, y: string) => string> = {
  // Unversioned alias is the more stable default (vs streets_and_buildings_12_2025).
  streets: (z, x, y) =>
    `https://basemaps.govmap.gov.il/backgroundMaps/streets_and_buildings/${z}/${x}/${y}.png`,
  // Orthophoto / aerial. Standard XYZ despite the /tms/ folder name (do NOT y-flip).
  ortho: (z, x, y) => `https://basemaps.govmap.gov.il/tms/orto2025me_update/${z}/${x}/${y}.jpg`,
  // Street/label overlay drawn on top of ortho for a "hybrid" view.
  labels: (z, x, y) =>
    `https://basemaps.govmap.gov.il/backgroundMaps/labels_and_line_12_2025/${z}/${x}/${y}.png`,
};

/**
 * Per-request failover when GovMap is down or a date-stamped folder rotated:
 * Esri's free hotlink-permitted world layers (note the {z}/{y}/{x} order).
 * `labels` has no standalone Esri equivalent — a transparent miss is fine
 * (the overlay just disappears; the ortho underneath still renders).
 */
const TILE_FALLBACK: Partial<Record<string, (z: string, x: string, y: string) => string>> = {
  streets: (z, x, y) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`,
  ortho: (z, x, y) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
};

const CONTENT_TYPE: Record<string, string> = {
  streets: "image/png",
  ortho: "image/jpeg",
  labels: "image/png",
};

/** EPSG:3857 Web Mercator metres → WGS84 [lat, lon]. */
export function mercToLatLon(x: number, y: number): [number, number] {
  const R = 6378137;
  const lon = ((x / R) * 180) / Math.PI;
  const lat = ((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180) / Math.PI;
  return [lat, lon];
}

/** Parse a WKT `POINT(x y)` string into [x, y] numbers, or null if malformed. */
function parseWktPoint(wkt: string): [number, number] | null {
  const m = /POINT\s*\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i.exec(wkt);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/**
 * GET /govtiles/:layer/:z/:x/:y.(png|jpg)
 * Streams a GovMap basemap tile with the required Referer, wildcard CORS, and a
 * one-day immutable cache. Path segments are strictly validated (layer allow-
 * list + integer z/x/y) so the upstream URL can never be attacker-controlled.
 */
export async function handleGovTile(pathParts: string[]): Promise<Response> {
  // pathParts = ["govtiles", layer, z, x, "y.png"]
  const layer = pathParts[1];
  const z = pathParts[2];
  const x = pathParts[3];
  const y = (pathParts[4] ?? "").replace(/\.(png|jpg|jpeg)$/i, "");

  const build = layer ? TILE_UPSTREAM[layer] : undefined;
  const intOk = (s: string | undefined): s is string => !!s && /^\d{1,2}$/.test(s);
  const coordOk = (s: string | undefined): s is string => !!s && /^\d{1,7}$/.test(s);
  if (!layer || !build || !intOk(z) || !coordOk(x) || !coordOk(y)) {
    return new Response("bad tile request", { status: 400 });
  }

  const url = build(z, x, y);
  let upstream: Response | null = null;
  try {
    upstream = await fetch(url, {
      headers: { Referer: "https://www.govmap.gov.il/", "User-Agent": "Mozilla/5.0 (tesla-dashboard tile proxy)" },
      // Cloudflare edge cache — repeated tiles are served without re-hitting GovMap.
      cf: { cacheEverything: true, cacheTtl: 86400 },
      signal: AbortSignal.timeout(6000),
    });
  } catch {
    upstream = null;
  }

  // GovMap serves an HTML page (HTTP 200) for tiles outside Israel's extent,
  // and its date-stamped folders rotate over time. On ANY non-image outcome,
  // fail over to the Esri world layer so the map never goes blank; if there's
  // no fallback for this layer, return a clean miss (never HTML-as-image).
  const upstreamType = upstream?.headers.get("content-type") || "";
  if (!upstream || !upstream.ok || !/^image\//i.test(upstreamType)) {
    const fallback = TILE_FALLBACK[layer];
    if (fallback) {
      try {
        const alt = await fetch(fallback(z, x, y), {
          cf: { cacheEverything: true, cacheTtl: 86400 },
          signal: AbortSignal.timeout(6000),
        });
        const altType = alt.headers.get("content-type") || "";
        if (alt.ok && /^image\//i.test(altType)) {
          return new Response(alt.body, {
            status: 200,
            headers: {
              "content-type": altType,
              "cache-control": "public, max-age=86400, immutable",
              "access-control-allow-origin": "*",
              "x-tile-source": "esri-fallback",
            },
          });
        }
      } catch {
        /* fall through to the miss */
      }
    }
    return new Response(null, {
      status: upstream && !upstream.ok ? upstream.status : 404,
      headers: { "access-control-allow-origin": "*" },
    });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstreamType || CONTENT_TYPE[layer] || "image/png",
      "cache-control": "public, max-age=86400, immutable",
      "access-control-allow-origin": "*",
    },
  });
}

/**
 * Health probe: fetches one known Tel-Aviv tile + a one-word autocomplete with
 * short timeouts. Reported on /health (authorized callers) so a GovMap folder
 * rotation or outage shows as a red check instead of a silently blank map.
 */
export async function probeGovmap(): Promise<{ tiles: boolean; geocode: boolean }> {
  const out = { tiles: false, geocode: false };
  try {
    const t = await fetch(TILE_UPSTREAM.streets!("13", "4887", "3322"), {
      headers: { Referer: "https://www.govmap.gov.il/", "User-Agent": "Mozilla/5.0 (health probe)" },
      cf: { cacheEverything: true, cacheTtl: 300 },
      signal: AbortSignal.timeout(4000),
    });
    out.tiles = t.ok && /^image\//i.test(t.headers.get("content-type") || "");
  } catch {
    /* stays false */
  }
  try {
    const g = await fetch("https://www.govmap.gov.il/api/search-service/autocomplete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ searchText: "תל אביב", language: "he", isAccurate: false, maxResults: 1 }),
      signal: AbortSignal.timeout(4000),
    });
    out.geocode = g.ok;
  } catch {
    /* stays false */
  }
  return out;
}

export interface GeocodeHit {
  label: string;
  lat: number;
  lon: number;
  type?: string;
  source: "govmap" | "nominatim";
}

/**
 * GET /geocode?q=…&lang=he|en
 * Forward-geocode an address string to coordinates via GovMap's search service,
 * falling back to OSM Nominatim. Always returns { query, results: GeocodeHit[] }.
 * Results are cached in D1 for 30 days by normalized query so repeat searches
 * (and any future autocomplete UI) don't hammer the undocumented upstream.
 */
export async function handleGeocode(env: Env, q: string, lang: string): Promise<GeocodeHit[]> {
  const language = lang === "en" ? "en" : "he";
  const qNorm = q.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);

  try {
    const cached = await env.DB.prepare(
      `SELECT results, created_ts FROM fwd_geocode_cache WHERE q_norm = ?1 AND lang = ?2`,
    )
      .bind(qNorm, language)
      .first<{ results: string; created_ts: number }>();
    if (cached && Math.floor(Date.now() / 1000) - cached.created_ts < 30 * 86400) {
      return JSON.parse(cached.results) as GeocodeHit[];
    }
  } catch {
    /* cache is best-effort */
  }

  let hits: GeocodeHit[] = [];
  try {
    hits = await govmapAutocomplete(q, language);
  } catch {
    /* fall through to Nominatim */
  }
  if (!hits.length) {
    try {
      hits = await nominatimForward(q);
    } catch {
      hits = [];
    }
  }
  if (hits.length) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO fwd_geocode_cache (q_norm, lang, results, created_ts) VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(qNorm, language, JSON.stringify(hits), Math.floor(Date.now() / 1000))
      .run()
      .catch(() => {});
  }
  return hits;
}

async function govmapAutocomplete(q: string, language: string): Promise<GeocodeHit[]> {
  const resp = await fetch("https://www.govmap.gov.il/api/search-service/autocomplete", {
    method: "POST",
    headers: { "content-type": "application/json", "User-Agent": "Mozilla/5.0 (tesla-dashboard)" },
    body: JSON.stringify({ searchText: q, language, isAccurate: false, maxResults: 10 }),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`govmap ${resp.status}`);
  const data = (await resp.json()) as { results?: Array<{ text?: string; type?: string; shape?: string }> };
  const out: GeocodeHit[] = [];
  for (const r of data.results ?? []) {
    if (!r.shape) continue;
    const merc = parseWktPoint(r.shape);
    if (!merc) continue;
    const [lat, lon] = mercToLatLon(merc[0], merc[1]);
    out.push({ label: r.text ?? q, lat, lon, type: r.type, source: "govmap" });
  }
  return out;
}

async function nominatimForward(q: string): Promise<GeocodeHit[]> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "10");
  const resp = await fetch(url.toString(), {
    headers: { "User-Agent": "tesla-cf-mcp-worker/1.0 (github; self-hosted Tesla logger)", "Accept-Language": "he,en" },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`nominatim ${resp.status}`);
  const data = (await resp.json()) as Array<{ display_name?: string; lat?: string; lon?: string; type?: string }>;
  return data
    .filter((r) => r.lat && r.lon)
    .map((r) => ({
      label: r.display_name ?? q,
      lat: Number(r.lat),
      lon: Number(r.lon),
      type: r.type,
      source: "nominatim" as const,
    }));
}
