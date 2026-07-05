/**
 * Thin Leaflet wrapper (free OSM tiles, no API key) replacing the design
 * mockup's "map tiles here" / "route map tiles here" placeholders with real
 * maps. Leaflet itself is loaded once from a CDN in index.html.
 */

let activeMaps = [];

export function destroyMaps() {
  for (const m of activeMaps) {
    try { m.remove(); } catch { /* already gone */ }
  }
  activeMaps = [];
}

function track(map) {
  activeMaps.push(map);
  return map;
}

const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTR = "&copy; OpenStreetMap contributors";

function baseMap(el, opts = {}) {
  const map = L.map(el, {
    zoomControl: false,
    attributionControl: true,
    scrollWheelZoom: false,
    ...opts,
  });
  L.tileLayer(TILE_URL, { attribution: TILE_ATTR, maxZoom: 19 }).addTo(map);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  return track(map);
}

/** Single marker at the vehicle's current location. */
export function renderPointMap(el, lat, lon, popupText) {
  const map = baseMap(el).setView([lat, lon], 15);
  const marker = L.circleMarker([lat, lon], {
    radius: 8, color: "#2E62E8", fillColor: "#2E62E8", fillOpacity: 1, weight: 3,
  }).addTo(map);
  if (popupText) marker.bindPopup(popupText);
  return map;
}

/** A single drive's GPS path with start/end markers. */
export function renderRouteMap(el, path) {
  const pts = path.filter((p) => p.lat != null && p.lon != null).map((p) => [p.lat, p.lon]);
  if (pts.length === 0) return null;
  const map = baseMap(el);
  const line = L.polyline(pts, { color: "#2E62E8", weight: 4, opacity: 0.85 }).addTo(map);
  L.circleMarker(pts[0], { radius: 6, color: "#2E62E8", fillColor: "#fff", fillOpacity: 1, weight: 3 }).addTo(map);
  L.circleMarker(pts[pts.length - 1], { radius: 6, color: "#2E62E8", fillColor: "#2E62E8", fillOpacity: 1, weight: 3 }).addTo(map);
  map.fitBounds(line.getBounds(), { padding: [24, 24] });
  return map;
}

/** Lifetime map: one polyline per drive, opacity weighted by how often that route recurs. */
export function renderLifetimeMap(el, drivePaths) {
  const map = baseMap(el);
  const allPts = [];
  const counts = new Map();
  const rounded = (p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;

  for (const path of drivePaths) {
    for (const p of path) counts.set(rounded(p), (counts.get(rounded(p)) ?? 0) + 1);
  }
  const maxCount = Math.max(1, ...counts.values());

  for (const path of drivePaths) {
    if (path.length < 2) continue;
    const avgCount = path.reduce((s, p) => s + (counts.get(rounded(p)) ?? 1), 0) / path.length;
    const opacity = 0.25 + 0.6 * (avgCount / maxCount);
    L.polyline(path, { color: "#2E62E8", weight: 2.5, opacity: Math.min(0.9, opacity) }).addTo(map);
    allPts.push(...path);
  }

  if (allPts.length > 0) {
    map.fitBounds(L.latLngBounds(allPts), { padding: [24, 24] });
  } else {
    map.setView([20, 0], 2);
  }
  return map;
}
