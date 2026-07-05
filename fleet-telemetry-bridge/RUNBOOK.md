# Fleet Telemetry Bridge — Self-Hosting Runbook

Real streaming telemetry from the car into the existing Cloudflare Worker
(`tesla-cf-mcp-worker.adamcfield.workers.dev`), at 1-second `VehicleSpeed`
cadence for harsh-braking detection, for ~$1/month of Tesla signal billing
(fully absorbed by the $10/month credit) plus $0 hosting on Oracle Cloud
Always Free.

```
┌─────────┐  mTLS WebSocket   ┌─────────────────┐  MQTT   ┌───────────┐  MQTT   ┌───────────┐  HTTPS POST (bearer)   ┌──────────────────────┐
│ vehicle │ ────────────────> │ fleet-telemetry │ ──────> │ mosquitto │ ──────> │ forwarder │ ─────────────────────> │ CF Worker            │
│  (EU)   │  :443, Tesla-     │ (official Go    │  QoS 1  │ (broker)  │ durable │ (Node.js) │  batched JSON, 1/sec   │ /ingest/telemetry    │
└─────────┘  issued client    │  server, Docker)│         └───────────┘ session └───────────┘  max while driving     │ → KV/D1 → /data/*    │
             cert on the car  └─────────────────┘                                                                    └──────────────────────┘
```

Everything in this directory is self-contained; nothing else in the repo is
touched. The GitHub-Actions 60s poller keeps running unchanged — both paths
write the same store, so the poller is automatically the fallback (§9).

**Why this architecture** (dispatcher choice): the official server supports
`kafka`, `kinesis`, `pubsub`, `zmq`, `mqtt`, `redis`, and `logger` dispatchers
(verified in `telemetry/producer.go`). MQTT was chosen because:

- the MQTT dispatcher always emits **protobuf-decoded, per-field JSON**
  (verified in `datastore/mqtt/mqtt_payload.go`) — no proto decoding needed in
  the forwarder;
- Mosquitto is a 10 MB container; Kafka/Kinesis/PubSub are absurd for one car;
- ZMQ needs no broker but the Node `zeromq` client has native bindings (flaky
  arm64 builds) and PUB/SUB drops messages whenever the consumer restarts.
  MQTT QoS 1 + a durable session + broker persistence buffers through
  forwarder restarts;
- `logger` would mean tailing stdout — fragile.

**Wire format the forwarder consumes** (verified against
`datastore/mqtt/mqtt_payload.go` + `datastore/mqtt/README.md`):

| topic | payload |
|---|---|
| `telemetry/<VIN>/v/<FieldName>` | bare JSON value: `34.5`, `true`, `"DetailedChargeStateCharging"`, `{"latitude":..,"longitude":..}`, `null` (= invalid, dropped) |
| `telemetry/<VIN>/connectivity` | `{"ConnectionId":..,"Status":..,"CreatedAt":..}` (logged only) |
| `telemetry/<VIN>/alerts/...`, `/errors/...` | logged only |

The forwarder batches each VIN's fields over a 1 s window and POSTs the
Worker's "normalized" ingest shape:
`{"events":[{"vin":"...","ts":1730000000,"data":{"VehicleSpeed":34.5,...}}]}`.
Field names pass through raw — the Worker's `FIELD_MAP` (src/ingest.ts) does
the canonicalization and mph/miles→metric conversion. Note `Gear` arrives as
proto enum strings (`"ShiftStateD"`) and `DetailedChargeState` as
`"DetailedChargeStateCharging"`; the Worker already strips the
`DetailedChargeState` prefix.

---

## 0. Prerequisites (already done for this account)

- Tesla developer app registered, **EU region** → Fleet API base
  `https://fleet-api.prd.eu.vn.cloud.tesla.com`.
- Virtual key paired to the vehicle (`https://tesla.com/_ak/<your-app-domain>`)
  — the same pairing used for signed commands. `fleet_telemetry_config` is
  rejected with `skipped_vehicles.missing_key` without it.
- Vehicle firmware ≥ 2023.20.6 (any current car qualifies; some pre-2021 S/X
  never will).
- Worker deployed with `POST /ingest/telemetry` guarded by `INGEST_TOKEN`
  (falls back to `MCP_AUTH_TOKEN`).

Still needed: a VM with a public IP, a DNS hostname, a TLS cert.

---

## 1. Host: Oracle Cloud Always Free (recommended) or Fly.io

### 1a. Oracle Cloud Always Free — $0/month, recommended

The Always Free tier includes Ampere A1 ARM capacity (up to 4 OCPU / 24 GB
split across VMs) and 2× AMD `VM.Standard.E2.1.Micro`. This stack idles at
~100 MB RAM; the smallest shape is plenty. The official
`tesla/fleet-telemetry` Docker image is multi-arch (amd64 **and** arm64,
verified on Docker Hub), so ARM is fine.

1. Sign up at cloud.oracle.com (pick a **home region in the EU** — e.g.
   `eu-frankfurt-1` — to keep vehicle→server latency low; the car is in EU).
2. Compute → Instances → Create instance:
   - Image: **Ubuntu 24.04** (aarch64 for A1).
   - Shape: `VM.Standard.A1.Flex`, 1 OCPU / 6 GB (or `E2.1.Micro` if A1
     capacity is unavailable — a common Always Free annoyance; retry other
     ADs or use the Micro).
   - Add your SSH public key. Note the assigned **public IP**.
3. Open ports in the **VCN Security List** (Networking → VCN → subnet →
   Security List → Add Ingress Rules):
   - `0.0.0.0/0` TCP **443** (vehicle mTLS WebSocket)
   - `0.0.0.0/0` TCP **80** (Let's Encrypt HTTP-01 issuance/renewal only)
   - (22 is open by default for SSH)
4. Oracle Ubuntu images also ship **host-level iptables** that reject
   everything but 22 — opening the Security List alone is not enough:

   ```bash
   sudo iptables -I INPUT 5 -p tcp --dport 443 -j ACCEPT
   sudo iptables -I INPUT 5 -p tcp --dport 80  -j ACCEPT
   sudo apt-get update && sudo apt-get install -y iptables-persistent
   sudo netfilter-persistent save
   ```

5. Install Docker:

   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER && newgrp docker
   ```

### 1b. Fly.io — alternative, no longer free

> Fly.io removed its free allowance for new organizations; expect roughly
> $3–5/month (shared-cpu-1x machine + a **dedicated IPv4, ~$2/month**, which
> you need because vehicles connect by raw TLS). [UNVERIFIED: exact current
> Fly pricing — check fly.io/docs/about/pricing before choosing this path.]

The critical Fly detail: Fly's proxy normally terminates TLS, which would
**break mTLS** (the vehicle's client cert must reach fleet-telemetry itself).
You must configure a raw TCP passthrough service — in `fly.toml`, a
`[[services]]` block with `internal_port = 8443`, a port-443 entry, and **no
`tls` handler**:

```toml
[[services]]
  internal_port = 8443
  protocol = "tcp"
  [[services.ports]]
    port = 443        # no handlers = raw passthrough, mTLS reaches the app
```

Because Fly's own cert management only works with proxy-terminated TLS,
issue the Let's Encrypt cert with the **DNS-01** challenge from your laptop
(`certbot certonly --manual --preferred-challenges dns`) and bake/mount the
cert files into the machine. This is workable but strictly more fiddly than
the Oracle path — use Oracle unless you have a reason not to.

---

## 2. DNS

Pick a hostname, e.g. `telemetry.<your-domain>`. Add an **A record** → the
VM's public IP.

- **If the domain is on Cloudflare: the record MUST be "DNS only" (grey
  cloud).** An orange-cloud proxied record makes Cloudflare terminate TLS,
  which strips the vehicle's client certificate and breaks mTLS. Same reason
  you cannot point the car at a Worker directly — that's why this bridge
  exists.
- No domain? A free DDNS name (e.g. DuckDuckDNS/duckdns.org) works — Let's
  Encrypt issues for `<name>.duckdns.org` fine. Any stable public FQDN is
  acceptable; the hostname goes into the vehicle config in §5.
- Keep TTL low (300s) during setup.

Check propagation: `dig +short telemetry.<your-domain>` → must return the VM IP.

---

## 3. TLS certificate (Let's Encrypt) + auto-renewal

The vehicle validates the server against the `ca` chain you send in
`fleet_telemetry_config`, and fleet-telemetry terminates TLS itself with
`tls.server_cert` / `tls.server_key` (keys verified in `config/config.go`).
A publicly-trusted Let's Encrypt cert works — this is what Tesla's own
tutorial uses.

On the VM (replace `telemetry.example.com` throughout):

```bash
sudo apt-get install -y certbot
# Port 80 must be free and open (it is; nothing else runs on this VM)
sudo certbot certonly --standalone \
  -d telemetry.example.com \
  --agree-tos -m adamcfield@gmail.com --non-interactive
```

Certs land in `/etc/letsencrypt/live/telemetry.example.com/`.

### 3a. Install certs where the container can read them

The fleet-telemetry image is distroless and runs as **uid 65532** (nonroot),
so the mounted key must be readable by that uid. From the directory holding
this kit (assume `~/fleet-telemetry-bridge`):

```bash
DOMAIN=telemetry.example.com
BRIDGE=~/fleet-telemetry-bridge
sudo install -o 65532 -g 65532 -m 444 /etc/letsencrypt/live/$DOMAIN/fullchain.pem $BRIDGE/certs/fullchain.pem
sudo install -o 65532 -g 65532 -m 400 /etc/letsencrypt/live/$DOMAIN/privkey.pem  $BRIDGE/certs/privkey.pem
```

### 3b. Auto-renewal

`certbot` installs a systemd timer that renews automatically (verify:
`systemctl list-timers | grep certbot`). Renewal drops new files under
`/etc/letsencrypt/live/`, so add a **deploy hook** that re-copies them and
restarts the server:

```bash
sudo tee /etc/letsencrypt/renewal-hooks/deploy/fleet-telemetry.sh >/dev/null <<'EOF'
#!/bin/bash
set -euo pipefail
DOMAIN=telemetry.example.com          # <-- edit
BRIDGE=/home/ubuntu/fleet-telemetry-bridge   # <-- edit
install -o 65532 -g 65532 -m 444 /etc/letsencrypt/live/$DOMAIN/fullchain.pem $BRIDGE/certs/fullchain.pem
install -o 65532 -g 65532 -m 400 /etc/letsencrypt/live/$DOMAIN/privkey.pem  $BRIDGE/certs/privkey.pem
cd $BRIDGE && docker compose restart fleet-telemetry
EOF
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/fleet-telemetry.sh
sudo certbot renew --dry-run    # must end with "simulating renewal... success"
```

Renewal uses `--standalone` on port 80 again — leave 80 open in the firewall
permanently, or renewals fail after ~90 days (§9).

> Note: the certificate **chain sent to the vehicle** (`ca` in §5) is pinned
> at config time. Let's Encrypt renewals keep the same chain (intermediate +
> ISRG Root X1), so routine renewals need **no** vehicle re-config. If LE ever
> rotates intermediates onto a different root, re-send the config (§5).

---

## 4. Bring the stack up

Copy this directory to the VM and start it:

```bash
# from your laptop
scp -r "fleet-telemetry-bridge" ubuntu@<VM_IP>:~/

# on the VM
cd ~/fleet-telemetry-bridge
cp .env.example .env
nano .env          # set INGEST_TOKEN (must equal the Worker's INGEST_TOKEN secret)
docker compose up -d --build
```

If the Worker has no dedicated ingest secret yet, set one first (from the
repo on your laptop — this is the only Worker-side step, and it's a secret,
not a code change):

```bash
cd tesla-cf-mcp-worker && npx wrangler secret put INGEST_TOKEN
```

Sanity checks on the VM:

```bash
docker compose ps                       # all three Up
curl -s http://127.0.0.1:8081/status    # -> "ok"  (fleet-telemetry status port)
docker compose logs fleet-telemetry | tail -20
docker compose logs forwarder | tail -20   # "connected", "subscribed"
```

And the TLS front door from your **laptop**:

```bash
openssl s_client -connect telemetry.example.com:443 -servername telemetry.example.com </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates
```

Tesla ships a validator for exactly this — run it before touching the car:

```bash
git clone --depth 1 https://github.com/teslamotors/fleet-telemetry /tmp/ft
cat > /tmp/validate_server.json <<EOF
{"hostname": "telemetry.example.com", "port": 443, "ca": $(jq -Rs . < /tmp/ca_chain.pem)}
EOF
/tmp/ft/tools/check_server_cert.sh /tmp/validate_server.json
```

(`/tmp/ca_chain.pem` is built in §5a.)

---

## 5. Point the car at it

### 5a. Build the `ca` value

Tesla's docs: `ca` = "the full certificate chain used to generate the
server's TLS certificate". For Let's Encrypt that is the intermediate
(`chain.pem`) plus the ISRG Root X1 root:

```bash
# on the VM
DOMAIN=telemetry.example.com
sudo cat /etc/letsencrypt/live/$DOMAIN/chain.pem > /tmp/ca_chain.pem
curl -s https://letsencrypt.org/certs/isrgrootx1.pem >> /tmp/ca_chain.pem
jq -Rs . < /tmp/ca_chain.pem    # -> one JSON string with \n escapes; this is the "ca" value
```

Validate with `check_server_cert.sh` (§4). [Note: some community setups pass
`fullchain.pem` (leaf+intermediate) instead; both validate against
`check_server_cert.sh`'s partial-chain logic, but intermediate+root survives
routine leaf renewals, so prefer it.]

### 5b. Field plan (what/why/cost)

Signals are transmitted **on change, no more often than `interval_seconds`**
(fleet-telemetry README). So a parked car sends almost nothing regardless of
intervals — these are worst-case-while-active rates. There is no explicit
"on change" mode: for `DetailedChargeState` a 60 s interval *is* on-change
behavior with a 60 s debounce. (`minimum_delta` and `resend_interval_seconds`
are also accepted per field — the Worker's MCP tool passes them through if
you ever want dead-banding. [UNVERIFIED: exact semantics; not needed here.])

| field | interval_seconds | why | worst-case rate |
|---|---|---|---|
| `VehicleSpeed` | **1** | harsh-braking Δv/Δt (1 Hz ⇒ braking g = Δkm/h ÷ 3.6 ÷ 9.81 per s) | 3600/driving-hr |
| `Location` | 5 | drive traces | 720/driving-hr |
| `Soc` | 60 | battery/charge tracking | 60/active-hr |
| `ACChargingPower` | 30 | AC charge curves | 120/charging-hr |
| `DetailedChargeState` | 60 | charge session boundaries (on-change) | ~few/session |
| `InsideTemp` | 300 | climate history | 12/active-hr |
| `OutsideTemp` | 300 | climate history | 12/active-hr |
| `TpmsPressureFl/Fr/Rl/Rr` | 300 | tire alerts | ≤12/driving-hr each |

All names verified against the Worker's `FIELD_MAP` (src/ingest.ts) — every
one lands in a canonical column.

### 5c. Configure via the existing MCP tool (preferred)

Call the Worker's `configure_telemetry` tool with:

```json
{
  "vins": ["<YOUR_VIN>"],
  "hostname": "telemetry.example.com",
  "port": 443,
  "ca": "-----BEGIN CERTIFICATE-----\n<intermediate>\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\n<ISRG Root X1>\n-----END CERTIFICATE-----\n",
  "fields": {
    "VehicleSpeed":        { "interval_seconds": 1 },
    "Location":            { "interval_seconds": 5 },
    "Soc":                 { "interval_seconds": 60 },
    "ACChargingPower":     { "interval_seconds": 30 },
    "DetailedChargeState": { "interval_seconds": 60 },
    "InsideTemp":          { "interval_seconds": 300 },
    "OutsideTemp":         { "interval_seconds": 300 },
    "TpmsPressureFl":      { "interval_seconds": 300 },
    "TpmsPressureFr":      { "interval_seconds": 300 },
    "TpmsPressureRl":      { "interval_seconds": 300 },
    "TpmsPressureRr":      { "interval_seconds": 300 }
  }
}
```

(`ca` is the exact string `jq -Rs .` printed in §5a, without the outer quotes
JSON already provides.) The tool POSTs
`/api/1/vehicles/fleet_telemetry_config` with the owner token; Tesla signs
and delivers the config — no vehicle-command proxy needed. A response listing
the VIN under `updated_vehicles` is success; `skipped_vehicles.missing_key`
means the virtual key isn't paired.

Then poll `get_telemetry_config` for the VIN until `synced: true` (can take a
few minutes; the car must be online — it is *not* woken for this).

### 5d. Or raw curl (equivalent)

```bash
# owner token: the Worker manages it; for manual use, any valid third-party
# owner access token for the account works.
curl -s -X POST "https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/vehicles/fleet_telemetry_config" \
  -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d @telemetry_config.json      # {"vins":[...],"config":{hostname,port,ca,fields}} — note the extra "config" nesting vs the MCP tool
```

Partner token (only needed for the diagnostics endpoint below and app
registration, which is already done):

```bash
PARTNER_TOKEN=$(curl -s -X POST "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=client_credentials \
  -d client_id=$TESLA_CLIENT_ID \
  -d client_secret=$TESLA_CLIENT_SECRET \
  -d 'scope=openid vehicle_device_data' \
  -d 'audience=https://fleet-api.prd.eu.vn.cloud.tesla.com' | jq -r .access_token)

# why is the car not connecting?
curl -s "https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/partner_accounts/fleet_telemetry_errors" \
  -H "Authorization: Bearer $PARTNER_TOKEN" | jq .
```

---

## 6. Verify end-to-end

Work down the pipe; each step isolates one hop.

1. **Vehicle → server**: `docker compose logs -f fleet-telemetry` — look for
   a connection log with the VIN after `synced:true` (drive off or open the
   app to make the car chatty).
2. **Server → broker**:
   `docker compose exec mosquitto mosquitto_sub -v -t 'telemetry/#'` — you
   should see `telemetry/<VIN>/v/VehicleSpeed 12.5` style lines, plus a
   `connectivity` message on connect.
3. **Broker → forwarder**: `docker compose logs -f forwarder` — per-minute
   `stats` lines with `received=` climbing and `postErrors=0`.
4. **Forwarder → Worker → store** (freshness check, from anywhere):

   ```bash
   curl -s "https://tesla-cf-mcp-worker.adamcfield.workers.dev/data/latest?vin=<YOUR_VIN>&token=$MCP_AUTH_TOKEN" | jq .
   ```

   While driving, `speed` should update and the state timestamp should stay
   within a few seconds of now (vs. ≤60 s staleness from the poller alone).
5. **Signal-volume / billing watch**: the server counts incoming signals in
   Prometheus metrics — `curl -s http://127.0.0.1:9090/metrics | grep -i signal`
   on the VM. Compare monthly totals against §7.

**Test the Worker hop without the car** (also proves the token before you
touch the vehicle):

```bash
curl -s -X POST "https://tesla-cf-mcp-worker.adamcfield.workers.dev/ingest/telemetry" \
  -H "Authorization: Bearer $INGEST_TOKEN" -H "Content-Type: application/json" \
  -d '{"vin":"<YOUR_VIN>","ts":'"$(date +%s)"',"data":{"VehicleSpeed":42,"Soc":71}}'
# -> {"accepted":1,"rejected":0}
```

**Test the forwarder without the Worker**: set `DRY_RUN=true` in `.env`,
`docker compose up -d forwarder`, publish a fake frame:

```bash
docker compose exec mosquitto mosquitto_pub -t 'telemetry/TESTVIN000000000/v/VehicleSpeed' -m '33.5'
docker compose logs forwarder | grep dry-run   # shows the exact POST body
```

---

## 7. Monthly cost

Basis: Tesla bills streaming signals at **$1 per ~150,000 signals**
(≈$0.0000067 each; consistent with Tesla's published ~$0.00667/hr per
~1000-signal-hour) against the **$10/month credit**. One field transmission =
one signal; on-change semantics make everything below an upper bound.

| scenario | driving | AC charging | active hrs | VehicleSpeed | Location | Soc | ACChgPower | temps | TPMS | ~total | ~cost | out of pocket |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Light (15 h/mo) | 15 h | 20 h | 40 h | 54,000 | 10,800 | 2,400 | 2,400 | 960 | 720 | **≈71k** | $0.47 | **$0** |
| Typical (30 h/mo) | 30 h | 40 h | 80 h | 108,000 | 21,600 | 4,800 | 4,800 | 1,920 | 1,440 | **≈143k** | $0.95 | **$0** |
| Heavy (60 h/mo) | 60 h | 60 h | 150 h | 216,000 | 43,200 | 9,000 | 7,200 | 3,600 | 2,880 | **≈282k** | $1.88 | **$0** |

Even the heavy scenario uses <20% of the free credit. Hosting: Oracle $0.
Headroom check: the credit covers ~1.5M signals ≈ 420 driving hours/month at
this field plan — you cannot realistically exceed it by driving.

**IMPORTANT — combined budget with the poller.** The worker records signal
spend at `/ingest/telemetry` (ingest.ts → `recordSpend("signal", …)`), so the
same governor that caps polling ALSO sees streaming spend: the two share one
monthly ledger, the poll cadence auto-throttles as signals accumulate, and the
combined total can't cross Tesla's $10 disable line. That said, the default
poll budget is **$9** (`BUDGET_POLL_USD`) and commands are allowed up to
**$9.70** — so before you enable the stream, **lower the poll budget to leave
room for signals**, e.g. set `BUDGET_POLL_USD = "7"` (a `[vars]` entry in
`wrangler.toml`, or `npx wrangler secret put BUDGET_POLL_USD`). With streaming
feeding fresh data every second, the poller is only a fallback anyway, so a
lower poll cap costs you nothing.

---

## 8. Teardown

In this order (stop the car streaming *first*, or it will keep trying):

```bash
# 1. remove the vehicle config — MCP tool delete_telemetry_config {"vin": "<YOUR_VIN>"}
#    or: curl -X DELETE "https://fleet-api.prd.eu.vn.cloud.tesla.com/api/1/vehicles/<VIN>/fleet_telemetry_config" -H "Authorization: Bearer $OWNER_TOKEN"

# 2. on the VM
cd ~/fleet-telemetry-bridge
docker compose down -v            # -v drops the mosquitto queue volume
sudo certbot delete --cert-name telemetry.example.com
sudo rm /etc/letsencrypt/renewal-hooks/deploy/fleet-telemetry.sh

# 3. delete the DNS A record; terminate the VM (or close 80/443 in the
#    Security List if keeping it)
```

The Worker needs no changes — `/ingest/telemetry` simply stops receiving, and
the 60 s poller is still feeding `/data/*`.

---

## 9. Failure modes — and why the poller is the safety net

The Worker's poll path (`applyVehicleData`) and the ingest path
(`applyIngest`) write **the same latest-state/history store**. Telemetry
frames simply overwrite poller data with fresher values; if frames stop, the
GitHub-Actions 60 s poll keeps `/data/*` current at poll cadence with zero
switchover logic. Losing the bridge degrades granularity (no 1 Hz speed), it
never blanks the dashboard.

| failure | symptom | detection | fix |
|---|---|---|---|
| **Cert expires** (renewal broke) | car silently stops connecting; fleet-telemetry logs TLS errors | `openssl s_client ... -dates` (§4); `/data/latest` freshness degrades to ~60 s (poller cadence) | fix renewal (`sudo certbot renew`), deploy hook recopies + restarts; port 80 must still be open |
| **VM down / crashed** | no frames; `/status` unreachable | `curl http://<vm>:443` fails; freshness ~60 s | reboot VM; `restart: unless-stopped` brings all three containers back. The car reconnects by itself and, with `reliable_ack_sources`, retransmits unacknowledged data [UNVERIFIED: how much the vehicle buffers while the server is unreachable] |
| **Forwarder down / Worker unreachable** | mosquitto queue grows | forwarder `stats` lines gone / `postErrors` climbing | mosquitto's durable session holds ~10k msgs (≈40 min driving); forwarder drains on restart with backoff |
| **Broker down** | fleet-telemetry logs MQTT publish errors | compose healthcheck | paho auto-reconnects; compose restarts it |
| **Config dropped after firmware update** | connectivity stops after an update | `get_telemetry_config` shows missing/`synced:false` | re-run §5c (idempotent) |
| **Token mismatch** | forwarder logs `HTTP 401` | forwarder logs | align `.env` `INGEST_TOKEN` with the Worker secret |
| **Tesla-side rejects config** | `skipped_vehicles` in response | response body | `missing_key` → pair virtual key; `unsupported_firmware` → update car |
| **DNS moved behind CF proxy** | car can't complete mTLS | `dig` returns Cloudflare IPs | grey-cloud the record (§2) |

Diagnostics of last resort: `fleet_telemetry_errors` with the partner token
(§5d) reports the vehicle's own view of connection failures (bad CA, DNS,
unreachable host).

---

## Appendix: verified facts vs assumptions

Verified against `teslamotors/fleet-telemetry@main` source (July 2026):

- server config keys in `config/config.json` here — `config/config.go`
  (`host`, `port`, `status_port`, `log_level`, `json_log_enable`,
  `namespace`, `monitoring`, `rate_limit`, `reliable_ack_sources`, `records`,
  `mqtt`, `tls.server_cert`, `tls.server_key`); example baseline:
  `examples/server_config.json`
- dispatcher names `kafka|kinesis|pubsub|zmq|mqtt|redis|logger` —
  `telemetry/producer.go`
- MQTT block keys and defaults — `datastore/mqtt/mqtt.go` `Config` struct
- MQTT topics/payloads (bare JSON values, `{latitude,longitude}` for
  Location, enum `.String()` names, `null` for invalid) —
  `datastore/mqtt/mqtt_payload.go`
- status endpoint `GET /status` on `status_port` —
  `server/monitoring/status_server.go`
- image is distroless nonroot (uid 65532), CMD
  `/fleet-telemetry -config /etc/fleet-telemetry/config.json` — `Dockerfile`
- Docker Hub `tesla/fleet-telemetry` ships amd64+arm64 (v0.9.3, June 2026) —
  Docker Hub API
- vehicles use Tesla-issued TLS **client** certs; the server embeds Tesla's
  prod CA for client verification by default (`use_default_eng_ca` flips to
  eng) — README + `config/config.go`
- `fleet_telemetry_config` body `{vins, config:{hostname, port, ca, fields}}`,
  Let's Encrypt OK, no command proxy needed, `synced` flag, `_ak` pairing —
  Tesla dev docs via community guides + the Worker's own
  `src/telemetry.ts`/`src/mcp.ts`
- signals transmitted on change, capped by `interval_seconds` — README

Assumptions / flagged:

- [UNVERIFIED] vehicle-side buffering depth while the server is down
  (reliable-ack retransmit exists, but the retention window isn't documented)
- [UNVERIFIED] current Fly.io minimum spend; the mTLS-passthrough
  `fly.toml` pattern is standard but untested here
- [UNVERIFIED] `minimum_delta` / `resend_interval_seconds` exact semantics
  (present in Tesla's schema and the Worker's types; unused by this plan)
- Cost basis $1/150k signals + $10 credit: user's existing cost model,
  cross-checked against Teslemetry's published $0.00667/hr-per-1000-signals
  figure — Tesla could reprice
