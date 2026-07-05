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
 * one place. If GovMap locks them down, swap TILE_UPSTREAM to Esri/CARTO.
 */

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
  const upstream = await fetch(url, {
    headers: { Referer: "https://www.govmap.gov.il/", "User-Agent": "Mozilla/5.0 (tesla-dashboard tile proxy)" },
    // Cloudflare edge cache — repeated tiles are served without re-hitting GovMap.
    cf: { cacheEverything: true, cacheTtl: 86400 },
  });

  // GovMap serves an HTML page (HTTP 200) for tiles outside Israel's extent.
  // Reject any non-image response so Leaflet gets a clean miss (blank tile)
  // rather than trying to paint an HTML body as an image.
  const upstreamType = upstream.headers.get("content-type") || "";
  if (!upstream.ok || !/^image\//i.test(upstreamType)) {
    return new Response(null, {
      status: upstream.ok ? 404 : upstream.status,
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
 */
export async function handleGeocode(q: string, lang: string): Promise<GeocodeHit[]> {
  const language = lang === "en" ? "en" : "he";
  try {
    const hits = await govmapAutocomplete(q, language);
    if (hits.length) return hits;
  } catch {
    /* fall through to Nominatim */
  }
  try {
    return await nominatimForward(q);
  } catch {
    return [];
  }
}

async function govmapAutocomplete(q: string, language: string): Promise<GeocodeHit[]> {
  const resp = await fetch("https://www.govmap.gov.il/api/search-service/autocomplete", {
    method: "POST",
    headers: { "content-type": "application/json", "User-Agent": "Mozilla/5.0 (tesla-dashboard)" },
    body: JSON.stringify({ searchText: q, language, isAccurate: false, maxResults: 10 }),
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
