/**
 * Service worker: offline-capable app shell, strictly network-only data.
 *
 * - App shell (this page, the JS/CSS modules, manifest, icons, and the two
 *   unpkg Leaflet files) is served CACHE-FIRST, with a background revalidate
 *   so a deployed update still lands on the next load.
 * - Anything touching the worker API is NEVER cached: /data/, /mcp, /ai/,
 *   /geocode, /govtiles, or any URL carrying a token= param falls through to
 *   the network untouched — vehicle data, AI answers, and bearer-token
 *   responses must not persist in Cache Storage.
 *
 * Bump CACHE_NAME on shell changes; activate deletes every older cache.
 */

const CACHE_NAME = "tesla-dash-shell-v2";

const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./api.js",
  "./map.js",
  "./charts.js",
  "./styles.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

/** URL fragments that must never enter the cache (API data + AI answers + tokened requests). */
const NEVER_CACHE = ["/data/", "/mcp", "/ai/", "/geocode", "/govtiles", "token="];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // allSettled, not addAll: one unreachable CDN file shouldn't block install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (NEVER_CACHE.some((frag) => req.url.includes(frag))) return; // network-only, untouched

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const hit = await cache.match(req);
      const refresh = fetch(req)
        .then((resp) => {
          if (resp.ok && (resp.type === "basic" || resp.type === "cors")) {
            cache.put(req, resp.clone());
          }
          return resp;
        })
        .catch(() => hit); // offline: whatever the cache had (or undefined → error)
      if (hit) {
        event.waitUntil(refresh.then(() => undefined).catch(() => undefined));
        return hit;
      }
      return refresh;
    }),
  );
});
