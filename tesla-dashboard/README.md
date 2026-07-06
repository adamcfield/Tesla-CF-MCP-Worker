# Tesla Dashboard

A TeslaMate-style dashboard for `tesla-cf-mcp-worker`. Static site, zero build
step, zero framework — plain HTML/CSS/JS plus Leaflet (maps) and a Google
Fonts import (IBM Plex Mono for numeric readouts), both loaded from CDN.

This directory is a separate deployable from `tesla-cf-mcp-worker/` — it only
*consumes* that worker's already-deployed API over HTTPS and never touches
its source or its D1/KV state.

## What it talks to

- `GET /data/*` on the worker — the read-only tracking REST API (drives,
  charge sessions + curve, degradation, vampire drain, state timeline,
  locations). Gated by `?token=`.
- `POST /mcp` on the worker — but **only** two safe, read-only tools:
  `list_vehicles` and `get_vehicle_data`. `api.js` hard-allowlists these; it
  has no code path that can reach a command tool (lock, charge, climate,
  etc.). Gated by `Authorization: Bearer`.
- `POST /ai/ask` on the worker — Ask-Tessa natural-language Q&A. The dashboard
  POSTs `{question, vin}`; the worker answers with `{answer, tools_used,
  data}`. Gated by the same token (query param + `Authorization: Bearer`).
  Answers are never cached (see `sw.js`).

All use the same `MCP_AUTH_TOKEN` you already generated for the worker.

## Layout

```
index.html            shell + login gate + PWA meta
styles.css            design tokens + component classes (ported from the design mockup)
api.js                fetch layer + token storage + read-only tool allowlist + export-URL helper
charts.js             dependency-free SVG line/bar/donut chart builders
map.js                Leaflet wrapper (GovMap/OSM/CARTO basemaps) + drive replay animation
app.js                router, per-screen data loading + rendering
manifest.webmanifest  PWA manifest (installable, standalone display)
sw.js                 service worker: cache-first app shell, network-only for all API data
icons/                generated PNG app icons (192/512 maskable + apple-touch 180)
```

## Screens

Ask Tessa, Overview, Timeline, Statistics, Drives (list + detail with route
map + speed chart + risk certificate), Drivers, Places, Lifetime map, Charges
(list + detail with charge curve), Charging stats, Battery health,
Predictions, Vampire drain — matching the "TeslaMate UI redesign" mockup's
layout and color system, but reading real data instead of sample numbers.
Screens show an honest empty state (not fabricated numbers) when the backing
D1 tables have nothing yet, and degrade gracefully when a newer `/data/*` (or
`/ai/*`) endpoint hasn't been deployed on the worker side.

Feature highlights:

- **Ask Tessa** — a natural-language chat panel (`POST /ai/ask`). Ask "How
  efficient was I this month?", "Is my battery healthy?", "Who drives the
  most?" — the answer renders with the tools it used shown as small chips
  ("via get_monthly_report") and an optional compact data view. The transcript
  is kept in memory only (never persisted). When the AI endpoint isn't
  deployed / reachable it shows a graceful "warming up / unavailable" state.
- **Predictions** — two cards. **Battery forecast**: current health %,
  degradation slope %/yr with r², and a warranty-cliff gauge showing years
  remaining and which cap (age vs odometer) binds first, plus a projected-%
  line chart. **Range predictor**: a small form (distance, temp, driver,
  optional elevation) → predicted Wh/km, kWh and SoC used, with the model
  r²/n as a trust indicator. Both show a "not enough data yet" / "not deployed
  yet" empty state when the model or endpoint isn't ready.
- **Insurance-grade drive report** — each drive detail carries a **Risk
  certificate** section: safety score with its confidence band
  (`score_low`–`score_high`, confidence label), over-limit severity + speed-
  limit source, a coach note, a **View signed certificate** button (fetches
  `/data/drive-certificate` and shows the canonical JSON + HMAC-SHA256
  signature + a copy button + the verify URL), and a **🖨 Printable report**
  button that opens a clean, `window.print()`-friendly incident/claims report
  (map, route, metrics, harsh-event summary, certificate hash).
- **Household driver picker** — everywhere a driver is assigned (Drives list
  inline editor + drive detail) the suggestions come from the real household
  roster (`/data/drivers` — Tesla-reported names get a small ⬤ badge), falling
  back to names harvested from loaded drives when that endpoint isn't
  deployed. A note reminds you Tesla can't auto-detect who drove — assignment
  is manual/assisted.
- **Driver percentiles** — each Drivers-page card shows percentile + a
  confidence band (e.g. "82/100 · 76th percentile · high confidence") against
  a UBI baseline, plus the baseline note, when the score endpoint returns
  them.

- **Overview** — battery/range/climate, current-location map, TPMS card
  (per-wheel bar pressure, amber when a wheel deviates >0.3 bar from the
  median or trends down >0.15 bar/week), API-spend governor card.
- **Drives** — time + per-driver filter chips, a Driver column with inline
  assignment (click a cell; suggested drivers show as *muted italics?* until
  confirmed), CSV export, and a per-drive detail with route map, **replay**
  (▶ animates the drive along its GPS path, timestamps compressed to ~20 s)
  and GPX export.
- **Places** — saved geofence locations with per-location stats (drives
  from/to, charge sessions, kWh, cost) plus visit-based "suggested places".
  Locations are written via the worker's `set_location` MCP tool; this UI is
  read-only.
- **Statistics** — 12-month totals, monthly distance chart, efficiency vs
  outside temperature (5 °C bins), and a server-computed monthly report
  (drives, distance, energy, Wh/km, charged kWh, AC/DC, cost, cost/100 km)
  when the worker exposes `/data/monthly`.
- **Charges** — list + charge-curve detail, CSV export.
- **Vampire drain** — blended standby loss plus an asleep vs awake-idle
  split when the worker provides the breakdown.
- **Dark mode** — the whole UI has a dark theme; maps switch to the CARTO
  dark-matter basemap automatically (GovMap streets/aerial + OSM stay
  available in the layer switcher).
- **Refresh-in-place** — first visit shows a shimmer skeleton; refreshes keep
  the current content visible until fresh data lands (no blank flash).

The Overview screen's live battery/climate/lock readouts come from an
**on-demand** `get_vehicle_data` call (a "Load live data" button) rather than
polling automatically — this matches the worker's own cost-hygiene rule
(never auto-poll, never auto-wake) and keeps this dashboard from silently
racking up billed Tesla API calls.

## PWA install

The dashboard is an installable PWA. On iOS Safari: Share → **Add to Home
Screen**. On Android Chrome / desktop Chrome: the install prompt in the
address bar (or ⋮ → *Install app*). It opens standalone (no browser chrome)
with the blue "T" icon.

`sw.js` caches only the app shell (HTML/JS/CSS, manifest, icons, Leaflet)
cache-first with a background revalidate. Anything under `/data/`, `/mcp`,
`/ai/`, `/geocode`, `/govtiles`, or any URL carrying a `token=` param is
**never cached** — vehicle data, AI answers and tokened responses always hit
the network. Bump `CACHE_NAME` in `sw.js` when shipping shell changes; old
caches are deleted on activate. Icons are generated programmatically (no
binary assets checked in by hand — see the rounded-square "T" PNGs in
`icons/`).

## Exports

- Drives list → `⬇ CSV` (`/data/export/drives.csv`)
- Charges list → `⬇ CSV` (`/data/export/charges.csv`)
- Drive detail → `⬇ GPX` (`/data/export/drive.gpx?id=`)
- Drive detail → **🖨 Printable report** — a clean, print-to-PDF incident /
  claims report (map, metrics, harsh-event summary, certificate hash),
  rendered client-side in a new window.
- Drive detail → **Signed certificate** — the canonical drive JSON +
  HMAC-SHA256 signature from `/data/drive-certificate?id=`, with a copy button
  and the worker's verify URL.

The CSV/GPX exports are plain token-gated GET links served by the worker.

## Running locally

No build step. Any static file server works:

```sh
npx serve tesla-dashboard -l 8787
# or
python3 -m http.server 8787 --directory tesla-dashboard
```

Then open `http://localhost:8787`, paste your `MCP_AUTH_TOKEN` at the gate.

To point at a different worker deployment: `http://localhost:8787/?origin=https://your-worker.example.com`
(persists in `localStorage` after the first load).

## Deploying (Cloudflare Pages)

Deploys are automatic: this Pages project is connected to this repo via
Cloudflare's Git integration, scoped to the `tesla-dashboard/` root
directory (so a worker-only or bridge-only commit elsewhere in the monorepo
doesn't trigger a rebuild here). No build command — it's a zero-build-step
static site, so every push to `main` just re-uploads the folder as-is; other
branches get their own preview `*.pages.dev` URL.

To deploy manually instead:

```sh
cd tesla-dashboard
npx wrangler pages deploy . --project-name=tesla-dashboard
```

First run creates the Pages project and prints a `*.pages.dev` URL. Add a
custom domain later from the Cloudflare dashboard if you don't want
`pages.dev` in the URL.

## Security note

The access token is stored in `localStorage` in your browser and sent only
to the worker origin you configure — never to any third party. Anyone who
gets the token can read all vehicle history and current state (not send
commands — this dashboard never calls a write tool, and even if someone read
the token from here, the worker's own bearer auth on `/mcp` still gates
command tools the same way it always did). Treat the dashboard URL + token
combination like you would any other read-mostly personal data view.
