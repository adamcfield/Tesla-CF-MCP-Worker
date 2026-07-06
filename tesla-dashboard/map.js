/**
 * Thin Leaflet wrapper replacing the design mockup's "map tiles here"
 * placeholders with real maps. Leaflet itself is loaded once from a CDN in
 * index.html.
 *
 * Basemap: GovMap (Israeli national map, מפ"י) proxied through the worker's
 * /govtiles route — the tile CDN enforces a Referer allow-list the browser
 * can't satisfy, so the worker fetches server-side. GovMap basemaps are
 * standard EPSG:3857 XYZ, so no custom CRS/Proj4Leaflet is needed. OSM is kept
 * as a selectable fallback (and covers anything outside Israel's tile extent).
 */

import { workerOrigin } from "./api.js";

let activeMaps = [];
let activeReplays = []; // stop() callbacks for in-flight replay animations

export function destroyMaps() {
  for (const stop of activeReplays) {
    try { stop(); } catch { /* already stopped */ }
  }
  activeReplays = [];
  for (const m of activeMaps) {
    try { m.remove(); } catch { /* already gone */ }
  }
  activeMaps = [];
}

function track(map) {
  activeMaps.push(map);
  return map;
}

/** Re-measure all live maps after a container resize (e.g. the fullscreen toggle). */
export function invalidateMaps() {
  for (const m of activeMaps) {
    try { m.invalidateSize(); } catch { /* map already gone */ }
  }
}

const GOVMAP_ATTR = '&copy; <a href="https://www.govmap.gov.il/">מפ"י / GovMap</a>';
const OSM_ATTR = "&copy; OpenStreetMap contributors";
const CARTO_ATTR = "&copy; OpenStreetMap &copy; CARTO";

/** Whether the app shell is currently in dark theme — maps pick a matching basemap. */
function isDark() {
  return document.querySelector("[data-tm-root]")?.getAttribute("data-theme") === "dark";
}

/** Route/marker blue: the accent is too dark to read on the CARTO dark basemap. */
function routeColor() {
  return isDark() ? "#5B8CFF" : "#2E62E8";
}

/** GovMap basemap layers, proxied through the worker's Referer-satisfying route. */
function govmapLayers() {
  const base = workerOrigin();
  const streets = L.tileLayer(`${base}/govtiles/streets/{z}/{x}/{y}.png`, {
    attribution: GOVMAP_ATTR, maxNativeZoom: 19, maxZoom: 20, tileSize: 256,
  });
  // Aerial "hybrid": orthophoto with the street/label overlay on top.
  const ortho = L.tileLayer(`${base}/govtiles/ortho/{z}/{x}/{y}.jpg`, {
    attribution: GOVMAP_ATTR, maxNativeZoom: 20, maxZoom: 21, tileSize: 256,
  });
  const labels = L.tileLayer(`${base}/govtiles/labels/{z}/{x}/{y}.png`, {
    maxNativeZoom: 19, maxZoom: 21, tileSize: 256,
  });
  const aerial = L.layerGroup([ortho, labels]);
  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: OSM_ATTR, maxZoom: 19,
  });
  const dark = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: CARTO_ATTR, maxZoom: 20,
  });
  return { streets, aerial, osm, dark };
}

function baseMap(el, opts = {}) {
  const map = L.map(el, {
    zoomControl: false,
    attributionControl: true,
    scrollWheelZoom: false,
    ...opts,
  });
  const { streets, aerial, osm, dark } = govmapLayers();
  // Dark theme defaults to the CARTO dark basemap; light keeps GovMap streets.
  (isDark() ? dark : streets).addTo(map);
  L.control
    .layers(
      { 'GovMap מפ"י': streets, "GovMap Aerial": aerial, OpenStreetMap: osm, "Dark (CARTO)": dark },
      {},
      { position: "topright", collapsed: true },
    )
    .addTo(map);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  return track(map);
}

/** Single marker at the vehicle's current location. */
export function renderPointMap(el, lat, lon, popupText) {
  const map = baseMap(el).setView([lat, lon], 15);
  const c = routeColor();
  const marker = L.circleMarker([lat, lon], {
    radius: 8, color: c, fillColor: c, fillOpacity: 1, weight: 3,
  }).addTo(map);
  if (popupText) marker.bindPopup(popupText);
  return map;
}

/** A single drive's GPS path with start/end markers. */
export function renderRouteMap(el, path) {
  const pts = path.filter((p) => p.lat != null && p.lon != null).map((p) => [p.lat, p.lon]);
  if (pts.length === 0) return null;
  const map = baseMap(el);
  const c = routeColor();
  const line = L.polyline(pts, { color: c, weight: 4, opacity: 0.85 }).addTo(map);
  L.circleMarker(pts[0], { radius: 6, color: c, fillColor: "#fff", fillOpacity: 1, weight: 3 }).addTo(map);
  L.circleMarker(pts[pts.length - 1], { radius: 6, color: c, fillColor: c, fillOpacity: 1, weight: 3 }).addTo(map);
  map.fitBounds(line.getBounds(), { padding: [24, 24] });
  return map;
}

/**
 * Drive replay: wires a play/pause button to a marker that travels the path,
 * with real per-point timestamps compressed to ~20 s of wall time (so a 40-min
 * drive replays proportionally — motorway stretches sweep, jams crawl).
 * The rAF loop registers a stop() with destroyMaps, so navigating away cancels
 * the animation frame instead of leaking it against a removed map.
 */
export function attachReplay(map, path, btn) {
  if (!map || !btn) return;
  const pts = path.filter((p) => p.lat != null && p.lon != null && p.ts != null);
  if (pts.length < 2) { btn.style.display = "none"; return; }
  const t0 = pts[0].ts;
  const span = Math.max(1, pts[pts.length - 1].ts - t0);
  const DURATION_MS = 20000;
  const c = routeColor();
  const marker = L.circleMarker([pts[0].lat, pts[0].lon], {
    radius: 7, color: "#fff", weight: 2.5, fillColor: c, fillOpacity: 1,
  });

  let raf = null, playing = false, progress = 0, lastFrame = null, cursor = 1;

  const setBtn = () => {
    btn.textContent = playing ? "❚❚" : "▶";
    btn.title = playing ? "Pause replay" : "Replay drive";
  };
  const posAt = (frac) => {
    const target = t0 + frac * span;
    if (target < pts[cursor - 1].ts) cursor = 1; // restarted from the top
    while (cursor < pts.length - 1 && pts[cursor].ts < target) cursor++;
    const a = pts[cursor - 1], b = pts[cursor];
    const f = Math.max(0, Math.min(1, (target - a.ts) / Math.max(1, b.ts - a.ts)));
    return [a.lat + (b.lat - a.lat) * f, a.lon + (b.lon - a.lon) * f];
  };
  const frame = (now) => {
    raf = null;
    if (!playing) return;
    if (lastFrame != null) progress += (now - lastFrame) / DURATION_MS;
    lastFrame = now;
    if (progress >= 1) {
      marker.setLatLng(posAt(1));
      playing = false; progress = 0; lastFrame = null;
      setBtn();
      return;
    }
    marker.setLatLng(posAt(progress));
    raf = requestAnimationFrame(frame);
  };
  btn.addEventListener("click", () => {
    playing = !playing;
    if (playing) {
      if (!map.hasLayer(marker)) marker.addTo(map);
      lastFrame = null;
      if (raf == null) raf = requestAnimationFrame(frame);
    } else if (raf != null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    setBtn();
  });
  setBtn();
  activeReplays.push(() => {
    playing = false;
    if (raf != null) cancelAnimationFrame(raf);
    raf = null;
  });
}

/** Lifetime map: one polyline per drive, opacity weighted by how often that route recurs. */
export function renderLifetimeMap(el, drivePaths) {
  const map = baseMap(el);
  const c = routeColor();
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
    L.polyline(path, { color: c, weight: 2.5, opacity: Math.min(0.9, opacity) }).addTo(map);
    allPts.push(...path);
  }

  if (allPts.length > 0) {
    map.fitBounds(L.latLngBounds(allPts), { padding: [24, 24] });
  } else {
    map.setView([20, 0], 2);
  }
  return map;
}
