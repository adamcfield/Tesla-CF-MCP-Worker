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
# Must be a domain that matches the Tesla partner account registration
# (rightcraft.io) — Tesla rejects bare-IP/nip.io hostnames with
# "hostname domain does not match with partner account".
HOST="telemetry.rightcraft.io"
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
# 2026-07-11: full-coverage plan — every streamable field from
# tesla-dashboard/fleet_streaming_fields.csv (239 fields). Intervals are the
# MINIMUM GAP between on-change transmissions, so rarely-changing fields cost
# ~nothing regardless of interval; continuous signals get larger gaps
# (Di* diagnostics 120s, pack stats 120s, static config 3600s) and
# drive-dynamics/safety events small ones (5-15s). Wrong-vehicle-class fields
# (Semitruck*/Tonneau*/Powershare*) are registered but never emit on this car.
# The original 39 fields keep their previous intervals exactly.
fields = {
 "ACChargingEnergyIn": {"interval_seconds": 60},
 "ACChargingPower": {"interval_seconds": 30},
 "AutoSeatClimateLeft": {"interval_seconds": 120},
 "AutoSeatClimateRight": {"interval_seconds": 120},
 "AutomaticBlindSpotCamera": {"interval_seconds": 5},
 "AutomaticEmergencyBrakingOff": {"interval_seconds": 5},
 "BMSState": {"interval_seconds": 60},
 "BatteryHeaterOn": {"interval_seconds": 60},
 "BatteryLevel": {"interval_seconds": 60},
 "BlindSpotCollisionWarningChime": {"interval_seconds": 5},
 "BmsFullchargecomplete": {"interval_seconds": 60},
 "BrakePedal": {"interval_seconds": 5},
 "BrakePedalPos": {"interval_seconds": 2},
 "BrickVoltageMax": {"interval_seconds": 60},
 "BrickVoltageMin": {"interval_seconds": 60},
 "CabinOverheatProtectionMode": {"interval_seconds": 120},
 "CabinOverheatProtectionTemperatureLimit": {"interval_seconds": 120},
 "CarType": {"interval_seconds": 3600},
 "CenterDisplay": {"interval_seconds": 15},
 "ChargeAmps": {"interval_seconds": 60},
 "ChargeCurrentRequest": {"interval_seconds": 60},
 "ChargeCurrentRequestMax": {"interval_seconds": 60},
 "ChargeEnableRequest": {"interval_seconds": 60},
 "ChargeLimitSoc": {"interval_seconds": 300},
 "ChargePort": {"interval_seconds": 3600},
 "ChargePortColdWeatherMode": {"interval_seconds": 15},
 "ChargePortDoorOpen": {"interval_seconds": 15},
 "ChargePortLatch": {"interval_seconds": 15},
 "ChargeRateMilePerHour": {"interval_seconds": 60},
 "ChargeState": {"interval_seconds": 60},
 "ChargerPhases": {"interval_seconds": 60},
 "ChargerVoltage": {"interval_seconds": 60},
 "ChargingCableType": {"interval_seconds": 60},
 "ClimateKeeperMode": {"interval_seconds": 300},
 "ClimateSeatCoolingFrontLeft": {"interval_seconds": 120},
 "ClimateSeatCoolingFrontRight": {"interval_seconds": 120},
 "CruiseFollowDistance": {"interval_seconds": 10},
 "CruiseSetSpeed": {"interval_seconds": 10},
 "CurrentLimitMph": {"interval_seconds": 10},
 "DCChargingEnergyIn": {"interval_seconds": 60},
 "DCChargingPower": {"interval_seconds": 30},
 "DCDCEnable": {"interval_seconds": 120},
 "DefrostForPreconditioning": {"interval_seconds": 120},
 "DefrostMode": {"interval_seconds": 120},
 "DestinationLocation": {"interval_seconds": 60},
 "DestinationName": {"interval_seconds": 60},
 "DetailedChargeState": {"interval_seconds": 60},
 "DiAxleSpeedF": {"interval_seconds": 120},
 "DiAxleSpeedR": {"interval_seconds": 120},
 "DiAxleSpeedREL": {"interval_seconds": 120},
 "DiAxleSpeedRER": {"interval_seconds": 120},
 "DiHeatsinkTF": {"interval_seconds": 120},
 "DiHeatsinkTR": {"interval_seconds": 120},
 "DiHeatsinkTREL": {"interval_seconds": 120},
 "DiHeatsinkTRER": {"interval_seconds": 120},
 "DiInverterTF": {"interval_seconds": 120},
 "DiInverterTR": {"interval_seconds": 120},
 "DiInverterTREL": {"interval_seconds": 120},
 "DiInverterTRER": {"interval_seconds": 120},
 "DiMotorCurrentF": {"interval_seconds": 120},
 "DiMotorCurrentR": {"interval_seconds": 120},
 "DiMotorCurrentREL": {"interval_seconds": 120},
 "DiMotorCurrentRER": {"interval_seconds": 120},
 "DiSlaveTorqueCmd": {"interval_seconds": 120},
 "DiStateF": {"interval_seconds": 120},
 "DiStateR": {"interval_seconds": 120},
 "DiStateREL": {"interval_seconds": 120},
 "DiStateRER": {"interval_seconds": 120},
 "DiStatorTempF": {"interval_seconds": 120},
 "DiStatorTempR": {"interval_seconds": 120},
 "DiStatorTempREL": {"interval_seconds": 120},
 "DiStatorTempRER": {"interval_seconds": 120},
 "DiTorqueActualF": {"interval_seconds": 120},
 "DiTorqueActualR": {"interval_seconds": 120},
 "DiTorqueActualREL": {"interval_seconds": 120},
 "DiTorqueActualRER": {"interval_seconds": 120},
 "DiTorquemotor": {"interval_seconds": 120},
 "DiVBatF": {"interval_seconds": 120},
 "DiVBatR": {"interval_seconds": 120},
 "DiVBatREL": {"interval_seconds": 120},
 "DiVBatRER": {"interval_seconds": 120},
 "DoorState": {"interval_seconds": 15},
 "DriveRail": {"interval_seconds": 60},
 "DriverSeatBelt": {"interval_seconds": 60},
 "DriverSeatOccupied": {"interval_seconds": 5},
 "EfficiencyPackage": {"interval_seconds": 3600},
 "EmergencyLaneDepartureAvoidance": {"interval_seconds": 5},
 "EnergyRemaining": {"interval_seconds": 120},
 "EstBatteryRange": {"interval_seconds": 120},
 "EstimatedHoursToChargeTermination": {"interval_seconds": 60},
 "EuropeVehicle": {"interval_seconds": 3600},
 "ExpectedEnergyPercentAtTripArrival": {"interval_seconds": 300},
 "ExteriorColor": {"interval_seconds": 3600},
 "FastChargerPresent": {"interval_seconds": 60},
 "FastChargerType": {"interval_seconds": 60},
 "FdWindow": {"interval_seconds": 15},
 "ForwardCollisionWarning": {"interval_seconds": 5},
 "FpWindow": {"interval_seconds": 15},
 "Gear": {"interval_seconds": 60},
 "GpsHeading": {"interval_seconds": 10},
 "GpsState": {"interval_seconds": 10},
 "GuestModeEnabled": {"interval_seconds": 15},
 "GuestModeMobileAccessState": {"interval_seconds": 15},
 "HomelinkDeviceCount": {"interval_seconds": 15},
 "HomelinkNearby": {"interval_seconds": 15},
 "HvacACEnabled": {"interval_seconds": 120},
 "HvacAutoMode": {"interval_seconds": 120},
 "HvacFanSpeed": {"interval_seconds": 120},
 "HvacFanStatus": {"interval_seconds": 120},
 "HvacLeftTemperatureRequest": {"interval_seconds": 120},
 "HvacPower": {"interval_seconds": 120},
 "HvacRightTemperatureRequest": {"interval_seconds": 120},
 "HvacSteeringWheelHeatAuto": {"interval_seconds": 120},
 "HvacSteeringWheelHeatLevel": {"interval_seconds": 120},
 "Hvil": {"interval_seconds": 120},
 "IdealBatteryRange": {"interval_seconds": 60},
 "InsideTemp": {"interval_seconds": 300},
 "IsolationResistance": {"interval_seconds": 120},
 "LaneDepartureAvoidance": {"interval_seconds": 5},
 "LateralAcceleration": {"interval_seconds": 1},
 "LifetimeEnergyUsed": {"interval_seconds": 300},
 "LifetimeEnergyUsedDrive": {"interval_seconds": 3600},
 "LightsHazardsActive": {"interval_seconds": 5},
 "LightsHighBeams": {"interval_seconds": 5},
 "LightsTurnSignal": {"interval_seconds": 5},
 "LocatedAtFavorite": {"interval_seconds": 60},
 "LocatedAtHome": {"interval_seconds": 60},
 "LocatedAtWork": {"interval_seconds": 60},
 "Location": {"interval_seconds": 5},
 "Locked": {"interval_seconds": 300},
 "LongitudinalAcceleration": {"interval_seconds": 1},
 "MediaAudioVolume": {"interval_seconds": 60},
 "MediaAudioVolumeIncrement": {"interval_seconds": 300},
 "MediaAudioVolumeMax": {"interval_seconds": 300},
 "MediaNowPlayingAlbum": {"interval_seconds": 60},
 "MediaNowPlayingArtist": {"interval_seconds": 30},
 "MediaNowPlayingDuration": {"interval_seconds": 60},
 "MediaNowPlayingElapsed": {"interval_seconds": 30},
 "MediaNowPlayingStation": {"interval_seconds": 60},
 "MediaNowPlayingTitle": {"interval_seconds": 30},
 "MediaPlaybackSource": {"interval_seconds": 30},
 "MediaPlaybackStatus": {"interval_seconds": 30},
 "MilesSinceReset": {"interval_seconds": 300},
 "MilesToArrival": {"interval_seconds": 60},
 "MinutesToArrival": {"interval_seconds": 60},
 "ModuleTempMax": {"interval_seconds": 60},
 "ModuleTempMin": {"interval_seconds": 60},
 "NotEnoughPowerToHeat": {"interval_seconds": 60},
 "NumBrickVoltageMax": {"interval_seconds": 60},
 "NumBrickVoltageMin": {"interval_seconds": 60},
 "NumModuleTempMax": {"interval_seconds": 60},
 "NumModuleTempMin": {"interval_seconds": 60},
 "Odometer": {"interval_seconds": 60},
 "OffroadLightbarPresent": {"interval_seconds": 3600},
 "OriginLocation": {"interval_seconds": 60},
 "OutsideTemp": {"interval_seconds": 300},
 "PackCurrent": {"interval_seconds": 60},
 "PackVoltage": {"interval_seconds": 60},
 "PairedPhoneKeyAndKeyFobQty": {"interval_seconds": 15},
 "PassengerSeatBelt": {"interval_seconds": 5},
 "PedalPosition": {"interval_seconds": 5},
 "PinToDriveEnabled": {"interval_seconds": 15},
 "PowershareHoursLeft": {"interval_seconds": 3600},
 "PowershareInstantaneousPowerKW": {"interval_seconds": 3600},
 "PowershareStatus": {"interval_seconds": 3600},
 "PowershareStopReason": {"interval_seconds": 3600},
 "PowershareType": {"interval_seconds": 3600},
 "PreconditioningEnabled": {"interval_seconds": 60},
 "RatedRange": {"interval_seconds": 120},
 "RdWindow": {"interval_seconds": 15},
 "RearDefrostEnabled": {"interval_seconds": 120},
 "RearDisplayHvacEnabled": {"interval_seconds": 120},
 "RearSeatHeaters": {"interval_seconds": 3600},
 "RemoteStartEnabled": {"interval_seconds": 15},
 "RightHandDrive": {"interval_seconds": 3600},
 "RoofColor": {"interval_seconds": 3600},
 "RouteLastUpdated": {"interval_seconds": 60},
 "RouteLine": {"interval_seconds": 300},
 "RouteTrafficMinutesDelay": {"interval_seconds": 60},
 "RpWindow": {"interval_seconds": 15},
 "ScheduledChargingMode": {"interval_seconds": 60},
 "ScheduledChargingPending": {"interval_seconds": 60},
 "ScheduledChargingStartTime": {"interval_seconds": 60},
 "SeatHeaterLeft": {"interval_seconds": 120},
 "SeatHeaterRearCenter": {"interval_seconds": 120},
 "SeatHeaterRearLeft": {"interval_seconds": 120},
 "SeatHeaterRearRight": {"interval_seconds": 120},
 "SeatHeaterRight": {"interval_seconds": 120},
 "SeatVentEnabled": {"interval_seconds": 120},
 "SelfDrivingMilesSinceReset": {"interval_seconds": 300},
 "SemitruckPassengerSeatFoldPosition": {"interval_seconds": 3600},
 "SemitruckTpmsPressureRe1L0": {"interval_seconds": 3600},
 "SemitruckTpmsPressureRe1L1": {"interval_seconds": 3600},
 "SemitruckTpmsPressureRe1R0": {"interval_seconds": 3600},
 "SemitruckTpmsPressureRe1R1": {"interval_seconds": 3600},
 "SemitruckTpmsPressureRe2L0": {"interval_seconds": 3600},
 "SemitruckTpmsPressureRe2L1": {"interval_seconds": 3600},
 "SemitruckTpmsPressureRe2R0": {"interval_seconds": 3600},
 "SemitruckTpmsPressureRe2R1": {"interval_seconds": 3600},
 "SemitruckTractorParkBrakeStatus": {"interval_seconds": 3600},
 "SemitruckTrailerParkBrakeStatus": {"interval_seconds": 3600},
 "SentryMode": {"interval_seconds": 300},
 "ServiceMode": {"interval_seconds": 15},
 "Setting24HourTime": {"interval_seconds": 3600},
 "SettingChargeUnit": {"interval_seconds": 3600},
 "SettingDistanceUnit": {"interval_seconds": 3600},
 "SettingTemperatureUnit": {"interval_seconds": 3600},
 "SettingTirePressureUnit": {"interval_seconds": 3600},
 "Soc": {"interval_seconds": 60},
 "SoftwareUpdateDownloadPercentComplete": {"interval_seconds": 300},
 "SoftwareUpdateExpectedDurationMinutes": {"interval_seconds": 300},
 "SoftwareUpdateInstallationPercentComplete": {"interval_seconds": 300},
 "SoftwareUpdateScheduledStartTime": {"interval_seconds": 300},
 "SoftwareUpdateVersion": {"interval_seconds": 300},
 "SpeedLimitMode": {"interval_seconds": 15},
 "SpeedLimitWarning": {"interval_seconds": 5},
 "SunroofInstalled": {"interval_seconds": 3600},
 "SuperchargerSessionTripPlanner": {"interval_seconds": 60},
 "TimeToFullCharge": {"interval_seconds": 60},
 "TonneauOpenPercent": {"interval_seconds": 3600},
 "TonneauPosition": {"interval_seconds": 3600},
 "TonneauTentMode": {"interval_seconds": 3600},
 "TpmsHardWarnings": {"interval_seconds": 300},
 "TpmsLastSeenPressureTimeFl": {"interval_seconds": 300},
 "TpmsLastSeenPressureTimeFr": {"interval_seconds": 300},
 "TpmsLastSeenPressureTimeRl": {"interval_seconds": 300},
 "TpmsLastSeenPressureTimeRr": {"interval_seconds": 300},
 "TpmsPressureFl": {"interval_seconds": 300},
 "TpmsPressureFr": {"interval_seconds": 300},
 "TpmsPressureRl": {"interval_seconds": 300},
 "TpmsPressureRr": {"interval_seconds": 300},
 "TpmsSoftWarnings": {"interval_seconds": 300},
 "Trim": {"interval_seconds": 3600},
 "ValetModeEnabled": {"interval_seconds": 15},
 "VehicleName": {"interval_seconds": 3600},
 "VehicleSpeed": {"interval_seconds": 1},
 "Version": {"interval_seconds": 3600},
 "WheelType": {"interval_seconds": 3600},
 "WiperHeatEnabled": {"interval_seconds": 120},
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
  # \\? — the MCP response embeds the config JSON as an escaped string (\"synced\"),
  # so the quote before ":" may be preceded by a backslash.
  if echo "$CFG" | grep -qE '"synced\\?" *: *true'; then
    echo ""; echo ">>> SYNCED. The car is now streaming to your VM. Take a drive and watch:"
    echo "    curl -s '$WORKER/data/latest?vin=$VIN&token=<read-token>' | python3 -m json.tool"
    exit 0
  fi
done
echo "Not synced yet — the car may be asleep. It syncs automatically once online; re-check get_telemetry_config later."
