/**
 * Service worker: offline-capable, but UPDATE-FIRST so a fresh deploy is seen
 * immediately (no stale-shell trap).
 *
 * Strategy:
 * - App shell (HTML/JS/CSS/manifest, same-origin): NETWORK-FIRST. We always try
 *   the network, cache the fresh copy, and only fall back to cache when offline.
 *   This is what makes a new deploy show up on the very next load instead of one
 *   load later (the classic cache-first PWA "I don't see my changes" problem).
 * - Static, versioned assets (icons, the pinned Leaflet CDN files): CACHE-FIRST
 *   with background revalidate — they rarely change and are safe to serve fast.
 * - API/data/AI/tokened requests: NEVER cached — straight to network.
 *
 * skipWaiting + clients.claim + a controllerchange reload in app.js mean an
 * updated worker takes over and refreshes the page automatically.
 *
 * Web Push: the worker's cron fans undelivered alert-log entries out as
 * encrypted push messages (tesla-cf-mcp-worker/src/webpush.ts); the handlers
 * at the bottom turn them into notifications and route a tap back into the
 * app (default: the Alerts screen). Subscribing happens in app.js via the
 * "Push notifications" card on that screen.
 */

const CACHE_NAME = "tesla-dash-shell-v4";

const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./api.js",
  "./map.js",
  "./charts.js",
  "./styles.css",
  "./manifest.webmanifest",
];
const STATIC = [
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

/** URL fragments that must never enter the cache (API data + AI answers + tokened requests). */
const NEVER_CACHE = ["/data/", "/mcp", "/ai/", "/geocode", "/govtiles", "token="];

/** True for the app shell (same-origin HTML/JS/CSS/manifest) → network-first. */
function isShell(url) {
  return (
    url.origin === self.location.origin &&
    /\.(html|js|css|webmanifest)$/.test(url.pathname.split("?")[0] || "") ||
    url.pathname === "/" ||
    url.pathname.endsWith("/")
  );
}
function isStatic(url) {
  return STATIC.some((s) => url.href === new URL(s, self.location.href).href) ||
    /\.(png|jpg|jpeg|svg|gif|webp)$/.test(url.pathname);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // Pre-cache both sets so the very first offline load works; allSettled so
      // one unreachable CDN file doesn't block install.
      .then((cache) => Promise.allSettled([...SHELL, ...STATIC].map((u) => cache.add(u))))
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
  const url = new URL(req.url);
  if (NEVER_CACHE.some((frag) => req.url.includes(frag))) return; // network-only

  // Network-first for the app shell: always prefer a fresh deploy.
  if (req.mode === "navigate" || isShell(url)) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp.ok) caches.open(CACHE_NAME).then((c) => c.put(req, resp.clone()));
          return resp;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html"))),
    );
    return;
  }

  // Cache-first (+ background revalidate) for versioned static assets.
  if (isStatic(url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const hit = await cache.match(req);
        const refresh = fetch(req)
          .then((resp) => {
            if (resp.ok && (resp.type === "basic" || resp.type === "cors")) cache.put(req, resp.clone());
            return resp;
          })
          .catch(() => hit);
        if (hit) {
          event.waitUntil(refresh.then(() => undefined).catch(() => undefined));
          return hit;
        }
        return refresh;
      }),
    );
    return;
  }
  // Everything else: straight to network.
});

// --- Web Push -------------------------------------------------------------

self.addEventListener("push", (event) => {
  // Payload is {title, body, tag?, url?} JSON (see the worker's webpush.ts) —
  // but never trust that: a malformed/empty payload still must show SOMETHING,
  // both for the user and because browsers punish push events that don't call
  // showNotification.
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch { /* non-JSON payload — fall through to the generic notification */ }
  event.waitUntil(
    self.registration.showNotification(data?.title || "Tesla alert", {
      body: data?.body || "",
      tag: data?.tag || undefined,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      data: { url: data?.url || "/#al" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/#al", self.location.href).href;
  // Focus an already-open dashboard window (navigating it to the alert URL)
  // rather than stacking a new one; open a fresh window only when none exists.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (wins) => {
      const win = wins.find((w) => w.url.startsWith(self.location.origin));
      if (!win) return self.clients.openWindow(target);
      await win.focus().catch(() => {});
      if (win.navigate) await win.navigate(target).catch(() => {});
    }),
  );
});
