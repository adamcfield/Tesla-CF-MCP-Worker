# HANDOFF — Tesla CF MCP Worker

Continuation notes for a local Claude Code session (or future you).
State as of 2026-07-04. Repo: `adamcfield/vlt-it-78c1fc3a`, directory
`tesla-cf-mcp-worker/`, everything merged to `main`.

## What this is

Cloudflare Workers MCP server for the Tesla Fleet API:

- **Reads**: vehicle list, full/narrow `vehicle_data`, location, nearby chargers.
- **Signed commands** via the Vehicle Command Protocol (`signed_command` +
  HMAC-personalized scheme; NOT the deprecated REST `/command/*`): lock/unlock,
  charge limit/amps/start/stop/port, climate/temperature, lights/horn, sentry,
  frunk/trunk, navigation, charging & precondition schedules.
- **Telemetry ingest** (`POST /ingest/telemetry`) → KV latest-state + D1
  history + charge-session tracking.
- **Automation engine** (KV-stored JSON rules; 15-min cron + ingest-time
  evaluation): price_charging, solar_surplus, scheduled_precondition,
  geofence, alert (webhook fan-out), log_snapshot.
- **Data endpoints** for Grafana/HA/OBS: `/data/latest`, `/data/series`,
  `/data/charge-sessions`.
- **Auth**: bearer (`MCP_AUTH_TOKEN`) for Claude Code; OAuth 2.1 shim
  (DCR + PKCE, paste-the-token authorize page) for claude.ai connectors.

Full tool list + automation rule examples: `README.md`.

## Current state — DONE

- All code merged to `main` (PR #1 core+automation platform, PR #2 setup.sh).
- `tsc --noEmit` clean.
- Protocol layer verified byte-for-byte against Tesla's own protobuf
  descriptors; HMAC tags independently recomputed from the vehicle side of
  the ECDH exchange (via Teslemetry `tesla-fleet-api` reference protos).
- Ingest→store→rules pipeline verified in Node with mocked KV/D1/network
  (14 checks: both wire shapes, session open/close, geofences, all alerts,
  sleeping-car cron behavior, feed parsing).
- NOT yet exercised against the live Fleet API (no credentials in the
  remote session — that's the local session's job, below).

## Current state — IN FLIGHT

- A deep adversarial review (5 reviewer agents + 2-lens verification per
  finding) was running in the remote session when this file was written.
  Confirmed findings will arrive as a follow-up PR titled something like
  "review fixes" — check open PRs before assuming the code is final.
  Known candidate issues the review was checking (unconfirmed): OAuth shim
  refresh-tokens usable as access tokens; price/solar rules re-sending
  commands + webhooks every 15-min tick while a regime persists (spam);
  no single-flight on concurrent Tesla token refresh; timing-unsafe `===`
  in `/data` token check; objects stored as "[object Object]" in history.
  If no fixes PR exists yet, re-examine these first.

## What to do locally (in order)

1. `git pull`, `cd tesla-cf-mcp-worker`, run **`./setup.sh`** — one-shot:
   wrangler login, keygen, KV+D1 creation with wrangler.toml patching,
   secrets (prompts for Tesla client id/secret; auto-generates
   MCP_AUTH_TOKEN into gitignored `.mcp-auth-token`), double-deploy, and
   prints every URL below filled in. Idempotent; re-run after failures.
   - Before running: set `TESLA_REGION = "eu"` in wrangler.toml (Israel =
     EU Fleet API region). Default in the file is "na".
   - If you want a custom domain (recommended — pairing/registration are
     domain-bound and workers.dev is ugly in the Tesla app): wire the
     route in Cloudflare first, set `PUBLIC_ORIGIN` to it, THEN run setup.
2. **Tesla developer app** (https://developer.tesla.com/dashboard) —
   has a human approval queue, start early:
   - OAuth grant type: authorization code + machine-to-machine (default).
   - Allowed Origin URL: `https://<worker-domain>` (lowercase, no path).
   - Allowed Redirect URI: `https://<worker-domain>/auth/callback`.
   - Allowed Returned URLs: leave empty.
   - Scopes: vehicle_device_data, vehicle_location, vehicle_cmds,
     vehicle_charging_cmds.
   - Put client id/secret into Worker secrets (setup.sh prompts, or
     `wrangler secret put TESLA_CLIENT_ID` / `TESLA_CLIENT_SECRET`).
3. Verify key hosting:
   `curl https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`
4. Partner registration (one-time, after app approval):
   `curl -X POST https://<domain>/setup/register-partner -H "Authorization: Bearer <MCP_AUTH_TOKEN>"`
   then check `GET /setup/partner-public-key` returns your key.
5. Owner grant: open `https://<domain>/auth/login?key=<MCP_AUTH_TOKEN>`,
   sign in with the Tesla account. Refresh-token rotation is automatic
   afterwards (stored in KV).
6. Pair the virtual key: open `https://tesla.com/_ak/<domain>` on a phone
   with the Tesla app, near the car. Without this, every command tool
   returns a "virtual key not paired" error pointing at this URL.
7. Connect Claude Code:
   `claude mcp add --transport http tesla https://<domain>/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"`
   claude.ai: add `https://<domain>/mcp` as custom connector, paste the
   token on the authorize page.
8. Smoke test, in this order: `list_vehicles` → `get_vehicle_data` (car
   must be awake — use the app or `wake_vehicle`) → `flash_lights` →
   then everything else.

## Architecture crib sheet (for debugging)

- `src/protocol.ts` — hand-rolled protobuf codec + signing. Session key =
  HMAC-SHA256(SHA1(ECDH-X)[0:16], "authenticated command"); metadata TLV
  order: SIGNATURE_TYPE(8), DOMAIN, VIN, EPOCH, EXPIRES_AT(be32),
  COUNTER(be32), 0xFF. Field numbers came from Tesla's descriptors — do
  not "fix" them without re-deriving (see PR #1 body for method).
- `src/commands.ts` — per-isolate session cache (deliberately NOT in KV:
  counters must never be replayed); handshake per VIN×domain; retries on
  faults 6/15; pairing hint on 3/4/7 or whitelist status.
- Domains: locks/closures/wake → VCSEC(2); charging/climate/nav/sentry →
  Infotainment(3).
- `src/rules.ts` — cron tick every 15 min (wrangler.toml [triggers]);
  free connectivity check per VIN; billed polls ONLY with per-rule
  `allow_poll: true`; automations can never unlock/open trunks or wake.
- `src/ingest.ts` — accepts normalized `{vin, ts, data:{Field:val}}`,
  fleet-telemetry `{data:[{key,value:{stringValue…}}]}`, or `{events:[…]}`.
  Fleet telemetry itself can't reach a Worker directly (vehicles speak
  WebSocket+mTLS to a fleet-telemetry server) — bridge via small VPS
  consumer or a hosted provider's webhook; or skip and use allow_poll.
- Storage: KV `latest:<vin>` doc + D1 `telemetry_events`/`charge_sessions`/
  `alert_log` (auto-created on first use).
- Secrets: TESLA_CLIENT_ID, TESLA_CLIENT_SECRET, TESLA_PRIVATE_KEY (PEM),
  TESLA_REFRESH_TOKEN (optional seed), MCP_AUTH_TOKEN, INGEST_TOKEN
  (optional), WEBHOOK_SECRET (optional). None in wrangler.toml.

## Known gotchas

- Changing the worker's domain later = update Tesla app origins + re-run
  partner registration + RE-PAIR the virtual key. Pick the domain once.
- `wake_vehicle` takes 10–30 s; data reads intentionally fail (with
  guidance) on a sleeping car instead of waking it.
- Tesla bills: vehicle_data reads (~$0.12/hr-equivalent), commands, wakes.
  Telemetry streaming is ~18× cheaper than polling — prefer it for
  anything recurring; every read tool's description repeats this.
- The stale remote branch `claude/tesla-mcp-worker-5x4jwh` may still show
  pre-merge commits; safe to delete from the GitHub UI.
- `days` strings in automations: "All" or "Mon,Tue,…"; unknown day names
  in rules.ts currently fall back to all-days (review may change this).
- Repo also hosts an unrelated Volta IT dashboard at its root — don't
  clobber `index.html`/root `README.md`.
