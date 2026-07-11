#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Tesla Fleet Telemetry — FINAL ACTIVATION (run ONCE, on the Mac).
#
#   MCP_AUTH_TOKEN='<your worker full-scope token>' bash fleet-telemetry-bridge/activate.sh
#
# What it does (all the credential-gated steps I can't do for you):
#   1. Tells the Worker the ingest token so the forwarder's POSTs are accepted.
#   2. Lowers the poll budget to $7 so streaming signals stay inside the $10 credit.
#   3. Registers the streaming config with Tesla (hostname + CA + field plan).
#   4. Waits until the car reports the config as synced.
#
# No secrets are embedded here: the ingest token + CA are pulled from the VM over
# SSH at runtime, and MCP_AUTH_TOKEN is read from your environment (never written).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
: "${MCP_AUTH_TOKEN:?Set MCP_AUTH_TOKEN=<your worker full-scope token> before running}"

WORKER="https://tesla-cf-mcp-worker.adamcfield.workers.dev"
VIN="LRW3E7ET1RC159967"
HOST="82.70.222.107.nip.io"
PORT=443
VM_IP="82.70.222.107"
SSH_KEY="$HOME/.ssh/oracle_tesla"
WORKER_DIR="$(cd "$(dirname "$0")/../tesla-cf-mcp-worker" && pwd)"
SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null ubuntu@$VM_IP"

echo "== Fetching ingest token + CA from the VM =="
INGEST_TOKEN=$($SSH 'grep "^INGEST_TOKEN=" ~/fleet-telemetry-bridge/.env | cut -d= -f2-')
CA_PEM=$($SSH 'cat ~/fleet-telemetry-bridge/certs/ca.pem')
[ -n "$INGEST_TOKEN" ] && [ -n "$CA_PEM" ] || { echo "Could not read token/CA from VM"; exit 1; }
echo "   ok (token ${#INGEST_TOKEN} chars, CA $(echo "$CA_PEM" | wc -l | tr -d ' ') lines)"

echo "== 1/4  Set Worker secret INGEST_TOKEN =="
( cd "$WORKER_DIR" && printf '%s' "$INGEST_TOKEN" | npx wrangler secret put INGEST_TOKEN )

echo "== 2/4  Lower poll budget to \$7 (room for streaming signals) =="
( cd "$WORKER_DIR" && printf '7' | npx wrangler secret put BUDGET_POLL_USD )

echo "== 3/4  Register streaming config with Tesla =="
PAYLOAD=$(CA="$CA_PEM" VIN="$VIN" HOST="$HOST" PORT="$PORT" python3 - <<'PY'
import json, os
fields = {
 "LongitudinalAcceleration": {"interval_seconds": 1},   # real braking/accel g-force
 "LateralAcceleration":      {"interval_seconds": 1},   # real cornering g
 "VehicleSpeed":             {"interval_seconds": 1},
 "Location":                 {"interval_seconds": 5},
 "BrakePedalPos":            {"interval_seconds": 2},
 "DriverSeatBelt":           {"interval_seconds": 60},
 "Gear":                     {"interval_seconds": 60},
 "Soc":                      {"interval_seconds": 60},
 "ACChargingPower":          {"interval_seconds": 30},
 "DetailedChargeState":      {"interval_seconds": 60},
 "HvacLeftTemperatureRequest": {"interval_seconds": 120},
 "SeatHeaterLeft":           {"interval_seconds": 120},
 "InsideTemp":               {"interval_seconds": 300},
 "OutsideTemp":              {"interval_seconds": 300},
 "TpmsPressureFl": {"interval_seconds": 300}, "TpmsPressureFr": {"interval_seconds": 300},
 "TpmsPressureRl": {"interval_seconds": 300}, "TpmsPressureRr": {"interval_seconds": 300},
 # --- added 2026-07-11: media (the Media screen was empty because these were
 # --- never streamed), plus the fields the hourly REST reconciliation used to
 # --- be the only source of. All on-change-ish; signal cost is negligible
 # --- ($1/150k signals) next to what telemetry-first saves in REST reads.
 "MediaPlaybackStatus":      {"interval_seconds": 30},
 "MediaPlaybackSource":      {"interval_seconds": 30},
 "MediaNowPlayingTitle":     {"interval_seconds": 30},
 "MediaNowPlayingArtist":    {"interval_seconds": 30},
 "MediaNowPlayingAlbum":     {"interval_seconds": 60},
 "MediaNowPlayingStation":   {"interval_seconds": 60},
 "MediaAudioVolume":         {"interval_seconds": 60},
 "Odometer":                 {"interval_seconds": 60},
 "EstBatteryRange":          {"interval_seconds": 120},
 "RatedRange":               {"interval_seconds": 120},
 "EnergyRemaining":          {"interval_seconds": 120},
 "ChargeLimitSoc":           {"interval_seconds": 300},
 "ChargeAmps":               {"interval_seconds": 60},
 "ACChargingEnergyIn":       {"interval_seconds": 60},
 "DCChargingPower":          {"interval_seconds": 30},
 "SentryMode":               {"interval_seconds": 300},
 "Locked":                   {"interval_seconds": 300},
 "ClimateKeeperMode":        {"interval_seconds": 300},
 "HvacACEnabled":            {"interval_seconds": 120},
 "HvacPower":                {"interval_seconds": 120},
 "SoftwareUpdateDownloadPercentComplete": {"interval_seconds": 300},
}
args = {"vins":[os.environ["VIN"]], "hostname":os.environ["HOST"],
        "port":int(os.environ["PORT"]), "ca":os.environ["CA"], "fields":fields}
print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call",
                  "params":{"name":"configure_telemetry","arguments":args}}))
PY
)
RESP=$(curl -s -X POST "$WORKER/mcp" -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "content-type: application/json" -d "$PAYLOAD")
echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
if echo "$RESP" | grep -q "missing_key"; then
  echo ""
  echo "!! Tesla says the VIRTUAL KEY isn't paired to the car."
  echo "   Open this on your phone (Tesla app installed) and tap 'Add key':"
  echo "     https://tesla.com/_ak/tesla-cf-mcp-worker.adamcfield.workers.dev"
  echo "   then re-run this script."
  exit 2
fi

echo "== 4/4  Waiting for the car to sync (up to ~5 min; car must be online) =="
for i in $(seq 1 20); do
  sleep 15
  CFG=$(curl -s -X POST "$WORKER/mcp" -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
    -H "content-type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_telemetry_config","arguments":{"vin":"'"$VIN"'"}}}')
  SHORT=$(echo "$CFG" | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin))[:180])' 2>/dev/null || echo "$CFG" | head -c 180)
  echo "   [$((i*15))s] $SHORT"
  if echo "$CFG" | grep -qE '"synced" *: *true'; then
    echo ""; echo ">>> SYNCED. The car is now streaming to your VM. Take a drive and watch:"
    echo "    curl -s '$WORKER/data/latest?vin=$VIN&token=<read-token>' | python3 -m json.tool"
    exit 0
  fi
done
echo "Not synced yet — the car may be asleep. It syncs automatically once online; re-check get_telemetry_config later."
