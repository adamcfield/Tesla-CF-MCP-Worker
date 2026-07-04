# Tesla CF MCP Worker

Cloudflare Workers MCP server for the **Tesla Fleet API**: vehicle data reads,
**signed vehicle commands** (Vehicle Command Protocol — not the deprecated plain
REST `/command/*` endpoints), Fleet Telemetry ingest + history storage, and a
cron-driven **automation engine** (price/solar-aware charging, geofences,
conditional preconditioning, alert webhooks).

Same pattern as `solaredge-mcp-worker` / `messagebird-mcp-worker`: TypeScript,
zero runtime dependencies, bearer-token gated `/mcp` for Claude Code, OAuth shim
for claude.ai remote connectors.

## Layout

```
wrangler.toml        bindings + vars + cron (no secrets)
src/index.ts         router: /mcp, /ingest, /data, /.well-known, /auth, /setup, /oauth + cron handler
src/mcp.ts           MCP JSON-RPC + tool registry
src/auth.ts          Tesla tokens (KV-rotated refresh), partner setup, MCP auth + OAuth shim
src/api.ts           REST reads (vehicle_data etc.)
src/commands.ts      signed commands via signed_command
src/protocol.ts      protobuf codec + HMAC-personalized command signing
src/telemetry.ts     fleet_telemetry_config lifecycle
src/ingest.ts        POST /ingest/telemetry sink (fleet-telemetry bridge / webhooks / polls)
src/store.ts         D1 history (events, charge sessions, alert log) + KV latest state
src/rules.ts         automation engine: cron tick + ingest-time evaluation
src/types.ts         Env bindings, regional bases, shared types
```

## Setup — one time

### 1. Tesla developer app

1. Sign in at [developer.tesla.com](https://developer.tesla.com) and create an app.
2. **Allowed origin**: your Worker origin (e.g. `https://tesla.example.com`).
3. **Allowed redirect URI**: `https://<worker-domain>/auth/callback`.
4. Request scopes: `vehicle_device_data`, `vehicle_location`, `vehicle_cmds`,
   `vehicle_charging_cmds` (plus `openid offline_access` implicitly).
5. Note the **client ID** and **client secret**.

> The partner-account domain must be the domain that serves the public key —
> i.e. this Worker's domain. Use a custom domain route if you don't want
> `workers.dev` in your Tesla app config.

### 2. Command-signing keypair

```sh
openssl ecparam -name prime256v1 -genkey -noout -out tesla-private-key.pem
```

The Worker derives and serves the public key itself at
`/.well-known/appspecific/com.tesla.3p.public-key.pem` — you never host a
separate file, and the private key never leaves Worker secrets.

### 3. Deploy

```sh
npm install
wrangler kv namespace create TESLA_KV       # put the id into wrangler.toml
wrangler d1 create tesla-cf-mcp-worker      # put the database_id into wrangler.toml
# edit wrangler.toml: TESLA_REGION, PUBLIC_ORIGIN
wrangler secret put TESLA_CLIENT_ID
wrangler secret put TESLA_CLIENT_SECRET
wrangler secret put TESLA_PRIVATE_KEY       # paste the PEM (multi-line ok)
wrangler secret put MCP_AUTH_TOKEN          # openssl rand -hex 32
wrangler secret put INGEST_TOKEN            # optional: separate token for the telemetry sink
wrangler secret put WEBHOOK_SECRET          # optional: signed header on outbound alert webhooks
npm run deploy
```

D1 tables are created automatically on first use.

Confirm key hosting: `curl https://<worker-domain>/.well-known/appspecific/com.tesla.3p.public-key.pem`

### 4. Register the partner endpoint (per region)

```sh
curl -X POST https://<worker-domain>/setup/register-partner \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN"
# verify Tesla picked up the key:
curl https://<worker-domain>/setup/partner-public-key \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN"
```

### 5. Owner grant (third-party token)

Open `https://<worker-domain>/auth/login?key=<MCP_AUTH_TOKEN>` in a browser,
sign in with the Tesla account that owns the vehicles, approve the scopes.
Tokens land in KV; refresh rotation is handled automatically from then on.
(Alternatively seed `wrangler secret put TESLA_REFRESH_TOKEN`.)

### 6. Pair the virtual key with each vehicle

Commands are signed with your private key, and the vehicle only accepts keys
it has been paired with. On a phone that has the Tesla app:

1. Open `https://tesla.com/_ak/<worker-domain>` (or scan it as a QR code).
2. Approve the key in the Tesla app while near the vehicle.

If you skip this, command tools fail with a clear "virtual key not paired"
error containing this link.

## Connecting clients

**Claude Code**

```sh
claude mcp add --transport http tesla https://<worker-domain>/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

**claude.ai (remote connector)** — add `https://<worker-domain>/mcp` as a
custom connector; when the OAuth screen appears, paste the `MCP_AUTH_TOKEN`.

## Tools

Reads: `list_vehicles`, `get_vehicle_data`, `get_charge_state`,
`get_climate_state`, `get_location`, `nearby_charging_sites`, `wake_vehicle`.

Signed commands: `lock`, `unlock`, `set_charge_limit`, `set_charging_amps`,
`start_charging`, `stop_charging`, `climate_on`, `climate_off`,
`set_temperature`, `flash_lights`, `honk_horn`, `set_sentry_mode`,
`navigate_to`, `open_charge_port`, `close_charge_port`, `actuate_frunk`,
`actuate_trunk`, `set_charging_schedule`, `remove_charging_schedule`,
`set_precondition_schedule`, `remove_precondition_schedule`.

Telemetry: `get_telemetry_config`, `configure_telemetry`, `delete_telemetry_config`.

History & state: `get_latest_state` (free, from the local store),
`get_history`, `list_history_fields`, `get_charge_sessions`, `get_alert_log`.

Automations: `list_automations`, `set_automation`, `delete_automation`,
`run_automations_now`.

## Telemetry ingest — getting a stream into the Worker

Tesla vehicles stream telemetry over WebSocket + mTLS (Tesla-issued client
certs) to a [fleet-telemetry](https://github.com/teslamotors/fleet-telemetry)
server — that TLS termination **cannot run on a Worker**. The Worker instead
exposes a plain HTTPS sink any bridge can POST to:

```
POST /ingest/telemetry
Authorization: Bearer <INGEST_TOKEN or MCP_AUTH_TOKEN>

{"vin":"5YJ3…","ts":1730000000,"data":{"Soc":72,"OutsideTemp":9.5,
  "Location":{"latitude":32.08,"longitude":34.78},"DetailedChargeState":"DetailedChargeStateCharging"}}
```

Also accepted: the fleet-telemetry JSON shape
(`{"vin":…,"createdAt":…,"data":[{"key":"Soc","value":{"stringValue":"72"}}]}`)
and batches (`{"events":[…]}`). Bridge options:

1. **Self-hosted fleet-telemetry** (small VPS/fly.io) with the kafka/zmq
   backend and a ~20-line consumer that forwards each message here.
2. **Hosted provider webhook** (e.g. Teslemetry) pointed at this endpoint.
3. **No stream at all**: automations with `"allow_poll": true` fall back to
   billed `vehicle_data` polls on the cron tick — works, costs more (see below).

Register the vehicle-side config with the `configure_telemetry` tool. Every
ingest updates the KV latest-state doc, appends to D1 history, advances the
charge-session tracker, and evaluates geofence/alert rules.

## Automations

Rules are JSON documents (KV-stored) managed with `set_automation` /
`list_automations` / `delete_automation`; the engine runs on ingest events and
on a 15-minute cron. Every rule can carry `notify: ["https://…"]` webhook URLs
(MessageBird flow invocation, Make/n8n webhook, a Google Apps Script that
appends to a Sheet, …) — payloads are JSON with an `x-webhook-token` header
when `WEBHOOK_SECRET` is set. Firings and errors land in `get_alert_log`.

**Safety rails**: automations can never `unlock` or open trunks (allowlist),
and never wake a sleeping vehicle. Billed polling only happens for rules with
`"allow_poll": true`, and only when the car is already online.

Price-aware charging (Amber example — cheap = charge fast, expensive = stop):

```json
{"type":"price_charging","vin":"5YJ3…","enabled":true,
 "feed":{"url":"https://api.amber.com.au/v1/sites/SITE_ID/prices/current",
         "headers":{"Authorization":"Bearer AMBER_TOKEN"},"format":"amber"},
 "cheap_below_cents":15,"amps_cheap":32,"limit_cheap":90,
 "expensive_above_cents":45,
 "notify":["https://hook.make.com/…"]}
```

Solar-surplus charging fed by your `solaredge-mcp-worker` (any URL returning
JSON with an export-watts number works; amps track the surplus each tick):

```json
{"type":"solar_surplus","vin":"5YJ3…","enabled":true,
 "source":{"url":"https://solaredge-worker.example.com/data/current?token=…",
           "json_path":"power.export_w"},
 "start_above_w":1500,"stop_below_w":500,"volts":230,"phases":1,
 "min_amps":6,"max_amps":16,
 "at":{"lat":32.0800,"lon":34.7800,"radius_m":300}}
```

Geofences (enter/exit actions — e.g. climate on when leaving the office,
sentry off + charge port open when arriving home):

```json
{"type":"geofence","vin":"5YJ3…","name":"volta-office","enabled":true,
 "lat":32.0623,"lon":34.7805,"radius_m":250,
 "on_exit":[{"command":"climate_on"},{"command":"set_temperature","args":{"temp_celsius":21}}]}
```

```json
{"type":"geofence","vin":"5YJ3…","name":"home","enabled":true,
 "lat":32.0900,"lon":34.7700,"radius_m":150,
 "on_enter":[{"command":"sentry_off"},{"command":"open_charge_port"}],
 "on_exit":[{"command":"sentry_on"},{"command":"lock"}]}
```

Conditional preconditioning the app UI can't express ("only if it's cold and
the battery can afford it"):

```json
{"type":"scheduled_precondition","vin":"5YJ3…","enabled":true,
 "time":"07:15","days":"Mon,Tue,Wed,Thu,Fri","tz_offset_minutes":180,
 "conditions":{"outside_temp_below_c":5,"soc_above":40},"temp_celsius":22}
```

Alerts (webhook per event; cooldowns prevent spam):

```json
{"type":"alert","vin":"5YJ3…","when":"door_unlocked_while_away",
 "home":{"lat":32.09,"lon":34.77,"radius_m":200},"notify":["https://…"]}
```

```json
{"type":"alert","vin":"5YJ3…","when":"soc_below","threshold":30,
 "between_hours":[22,6],"tz_offset_minutes":180,"notify":["https://…"]}
```

Other `when` values: `tire_pressure_drop` (`drop_bar`), `charging_started`,
`charging_stopped`, `unexpected_wake` (connectivity transition seen by the
cron's free check). For pure history collection without a telemetry stream:
`{"type":"log_snapshot","vin":"…","interval_minutes":60,"allow_poll":true}` —
explicitly opt-in because it's billed polling.

## Dashboards & integrations

Read-only JSON endpoints (Authorization header **or** `?token=` for
header-less consumers — note the token then appears in that consumer's logs):

- `GET /data/latest?vin=…` — Home Assistant `rest` sensor, OBS browser-source
  overlay, status widgets.
- `GET /data/series?vin=…&field=soc&hours=168` — Grafana (JSON API
  datasource), degradation charts (`field=soc`, `field=rated_range`), mileage
  logs for insurance (`field=odometer`), TPMS trends.
- `GET /data/charge-sessions?vin=…` — charge cost/energy table.

Make/n8n can call any MCP tool directly: `POST /mcp` with
`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_latest_state","arguments":{"vin":"…"}}}`.

## Cost & rate-limit hygiene

- **No auto-wake.** Data reads check connectivity first and fail with guidance
  if the vehicle is asleep; only an explicit `wake_vehicle` call wakes a car.
  Automations skip (and log) instead of waking.
- **No blind polling.** MCP tools run on demand; the cron only uses the free
  connectivity endpoint unless a rule explicitly sets `allow_poll: true`.
- **Telemetry over polling.** `vehicle_data` ≈ $0.12/hr vs telemetry streaming
  ≈ $0.00667/hr. With a stream feeding `/ingest/telemetry`, automations,
  history and `get_latest_state` all run off pushed data at the cheap rate.
- Narrow reads (`get_charge_state` etc.) request only the needed
  `vehicle_data` endpoints.

## Command signing notes

Commands go through `POST /api/1/vehicles/{vin}/signed_command` wrapped in a
`RoutableMessage`: a session handshake fetches the vehicle's ephemeral public
key/epoch/counter per domain (VCSEC for locks/closures, Infotainment for
charging/climate), then each command is HMAC-SHA256-signed
(HMAC-personalized scheme) with a key derived via ECDH(P-256) + SHA1 → HMAC.
Stale counter/epoch faults trigger one automatic re-handshake; "key not on
whitelist" surfaces the pairing URL above. Sessions are cached per isolate,
never in KV (counters must not be replayed).
