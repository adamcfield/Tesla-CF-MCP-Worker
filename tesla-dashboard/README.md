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

Both use the same `MCP_AUTH_TOKEN` you already generated for the worker.

## Layout

```
index.html   shell + login gate
styles.css   design tokens + component classes (ported from the design mockup)
api.js       fetch layer + token storage + the read-only tool allowlist
charts.js    dependency-free SVG line/bar/donut chart builders
map.js       Leaflet wrapper (OSM tiles, no API key) for location/route/lifetime maps
app.js       router, per-screen data loading + rendering, all 9 screens
```

## Screens

Overview, Timeline, Statistics, Drives (list + detail with route map + speed
chart), Lifetime map, Charges (list + detail with charge curve), Charging
stats, Battery health, Vampire drain — matching the "TeslaMate UI redesign"
mockup's layout and color system, but reading real data instead of sample
numbers. Screens show an honest empty state (not fabricated numbers) when the
backing D1 tables have nothing yet — this happens today because no Fleet
Telemetry stream or `run_automations_now`-driven poll has been wired up on
the worker side, so `drives`/`charge_sessions`/`positions` are still empty.

The Overview screen's live battery/climate/lock readouts come from an
**on-demand** `get_vehicle_data` call (a "Load live data" button) rather than
polling automatically — this matches the worker's own cost-hygiene rule
(never auto-poll, never auto-wake) and keeps this dashboard from silently
racking up billed Tesla API calls.

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

```sh
cd tesla-dashboard
npx wrangler pages deploy . --project-name=tesla-dashboard
```

First run creates the Pages project and prints a `*.pages.dev` URL. Re-run
the same command to redeploy after edits — no `wrangler.toml` needed for a
plain static site. Add a custom domain later from the Cloudflare dashboard
if you don't want `pages.dev` in the URL.

## Security note

The access token is stored in `localStorage` in your browser and sent only
to the worker origin you configure — never to any third party. Anyone who
gets the token can read all vehicle history and current state (not send
commands — this dashboard never calls a write tool, and even if someone read
the token from here, the worker's own bearer auth on `/mcp` still gates
command tools the same way it always did). Treat the dashboard URL + token
combination like you would any other read-mostly personal data view.
