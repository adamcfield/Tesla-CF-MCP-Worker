# Tesla CF MCP Worker

Cloudflare Workers MCP server for the **Tesla Fleet API**: vehicle data reads and
**signed vehicle commands** (Vehicle Command Protocol — not the deprecated plain
REST `/command/*` endpoints), plus Fleet Telemetry config management.

Same pattern as `solaredge-mcp-worker` / `messagebird-mcp-worker`: TypeScript,
zero runtime dependencies, bearer-token gated `/mcp` for Claude Code, OAuth shim
for claude.ai remote connectors.

## Layout

```
wrangler.toml        bindings + vars (no secrets)
src/index.ts         router: /mcp, /.well-known, /auth, /setup, /oauth
src/mcp.ts           MCP JSON-RPC + tool registry
src/auth.ts          Tesla tokens (KV-rotated refresh), partner setup, MCP auth + OAuth shim
src/api.ts           REST reads (vehicle_data etc.)
src/commands.ts      signed commands via signed_command
src/protocol.ts      protobuf codec + HMAC-personalized command signing
src/telemetry.ts     fleet_telemetry_config lifecycle
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
wrangler kv namespace create TESLA_KV     # put the id into wrangler.toml
# edit wrangler.toml: TESLA_REGION, PUBLIC_ORIGIN
wrangler secret put TESLA_CLIENT_ID
wrangler secret put TESLA_CLIENT_SECRET
wrangler secret put TESLA_PRIVATE_KEY     # paste the PEM (multi-line ok)
wrangler secret put MCP_AUTH_TOKEN        # openssl rand -hex 32
npm run deploy
```

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

Signed commands: `lock`, `unlock`, `set_charge_limit`, `start_charging`,
`stop_charging`, `climate_on`, `climate_off`, `set_temperature`,
`flash_lights`, `honk_horn`, `open_charge_port`, `close_charge_port`,
`actuate_frunk`, `actuate_trunk`, `set_charging_schedule`,
`remove_charging_schedule`, `set_precondition_schedule`,
`remove_precondition_schedule`.

Telemetry: `get_telemetry_config`, `configure_telemetry`, `delete_telemetry_config`.

## Cost & rate-limit hygiene

- **No auto-wake.** Data reads check connectivity first and fail with guidance
  if the vehicle is asleep; only an explicit `wake_vehicle` call wakes a car.
- **No polling.** Tools run on demand only.
- **Telemetry over polling.** `vehicle_data` ≈ $0.12/hr vs telemetry streaming
  ≈ $0.00667/hr. Every read tool's description nudges toward
  `configure_telemetry` for recurring needs. Receiving/storing the stream
  (Kafka/webhook target) is a **TODO for v2** — v1 only manages the
  vehicle-side config.
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
