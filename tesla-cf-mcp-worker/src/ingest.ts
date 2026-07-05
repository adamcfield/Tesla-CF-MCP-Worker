/**
 * Telemetry ingest: POST /ingest/telemetry
 *
 * Tesla's Fleet Telemetry cannot push directly to a Worker (vehicles speak
 * WebSocket + mTLS with Tesla-issued client certs to a fleet-telemetry
 * server you run). This endpoint is the Worker-side sink that any bridge can
 * POST to over plain HTTPS + bearer token:
 *   - the official fleet-telemetry server → kafka/zmq → tiny forwarder
 *   - a hosted telemetry provider's webhook (e.g. Teslemetry)
 *   - n8n/Make flows, or a manual push for testing
 *
 * Accepted payload shapes (auto-detected):
 *   1. Normalized:      {"vin":"...","ts":1730000000,"data":{"Soc":72,"Location":{"latitude":..,"longitude":..}}}
 *   2. fleet-telemetry: {"vin":"...","createdAt":"2025-..","data":[{"key":"Soc","value":{"stringValue":"72"}}]}
 *   3. Batch of either: {"events":[<shape 1 or 2>, ...]}
 *
 * Each ingest: canonical fields → KV latest-state, structured sample + derived
 * drive/charge/state boundaries (tracking.ts), arbitrary fields → EAV history,
 * then rule evaluation. This path is passive and never wakes the vehicle.
 */

import { evaluateOnIngest } from "./rules";
import { LatestState, mergeLatest, POSITION_COLUMNS, recordEvents, TelemetryEvent } from "./store";
import { applyDerivation } from "./tracking";
import { Env } from "./types";

/**
 * Maps fleet-telemetry Field names → canonical latest-state keys. Names verified
 * against teslamotors/fleet-telemetry protos/vehicle_data.proto (Field enum).
 * Unmapped fields fall back to their lowercased name.
 */
const FIELD_MAP: Record<string, string> = {
  Soc: "soc",
  BatteryLevel: "soc",
  UsableBatteryLevel: "usable_soc",
  EnergyRemaining: "energy_remaining",
  EstBatteryRange: "est_range",
  RatedRange: "rated_range",
  IdealBatteryRange: "ideal_range",
  Odometer: "odometer",
  VehicleSpeed: "speed",
  Location: "location",
  GpsHeading: "heading",
  Elevation: "elevation",
  Gear: "gear",
  ShiftState: "gear",
  Locked: "locked",
  SentryMode: "sentry",
  DetailedChargeState: "charging_state",
  ChargeState: "charging_state",
  ChargingState: "charging_state",
  ChargeAmps: "charger_current",
  ChargeCurrentRequest: "charge_current_request",
  ChargeLimitSoc: "charge_limit",
  ChargerVoltage: "charger_voltage",
  ACChargingPower: "ac_charging_power",
  DCChargingPower: "dc_charging_power",
  ACChargingEnergyIn: "ac_charge_energy_added",
  DCChargingEnergyIn: "dc_charge_energy_added",
  ChargeEnergyAdded: "charge_energy_added",
  SoftwareUpdateInstallationPercentComplete: "software_update_pct",
  InsideTemp: "inside_temp",
  OutsideTemp: "outside_temp",
  TpmsPressureFl: "tpms_fl",
  TpmsPressureFr: "tpms_fr",
  TpmsPressureRl: "tpms_rl",
  TpmsPressureRr: "tpms_rr",
  DoorState: "door_state",
  FdWindow: "window_fd",
};

/** Canonical fields that live only on `current` for derivation — never stored to EAV. */
const META_FIELDS = new Set([
  "charger_kind", "ac_charging_power", "dc_charging_power",
  "ac_charge_energy_added", "dc_charge_energy_added",
]);

const MI_TO_KM = 1.609344;
/**
 * Canonical fields the Tesla Fleet API reports in imperial units, on BOTH the
 * REST poll path and the telemetry stream, regardless of the car's region or
 * GUI setting (verified against Tesla's official Fleet Telemetry "Available
 * Data" docs + TeslaMate/Home-Assistant, 2026-07). Distances are miles, speed
 * is mph — same 1.609344 factor. Everything else (temps °C, TPMS bar, energy
 * kWh, power kW) is already metric and passes through untouched. Normalizing
 * here, before mergeLatest/derivation, means every downstream table, derived
 * stat, and `/data` route is uniformly metric.
 */
const MILES_FIELDS = new Set(["odometer", "speed", "est_range", "rated_range", "ideal_range"]);

function toMetric(canonical: string, value: unknown): unknown {
  if (MILES_FIELDS.has(canonical) && typeof value === "number" && Number.isFinite(value)) {
    return value * MI_TO_KM;
  }
  return value;
}

/** DetailedChargeState enum strings arrive prefixed, e.g. "DetailedChargeStateCharging". */
function normalizeChargingState(v: unknown): unknown {
  if (typeof v === "string" && v.startsWith("DetailedChargeState")) {
    return v.slice("DetailedChargeState".length);
  }
  return v;
}

function coerce(v: unknown): unknown {
  if (typeof v !== "string") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : v;
}

/**
 * Unwraps a fleet-telemetry Value. The proto has one field per type
 * (stringValue, intValue, doubleValue, booleanValue, locationValue, and enum
 * wrappers like detailedChargeStateValue / shiftStateValue / sentryModeStateValue),
 * so match generically on any single `*Value` key rather than a hardcoded list —
 * otherwise enum/sensor fields fall through and get stored as "[object Object]".
 * `{invalid:true}` markers carry no reading and are dropped.
 */
function unwrapFtValue(v: unknown): unknown {
  // Bare primitives go through coerce too: a bridge posting the array shape
  // with an unwrapped string value ({"key":"Odometer","value":"50000"}) must
  // yield a NUMBER, or toMetric()'s number-only guard skips the mi->km
  // conversion and the sample is stored as unconverted miles.
  if (v === null || typeof v !== "object") return coerce(v);
  const o = v as Record<string, unknown>;
  if (o.invalid === true) return undefined;
  if (o.locationValue && typeof o.locationValue === "object") return o.locationValue;
  for (const [k, inner] of Object.entries(o)) {
    if (k.endsWith("Value") && (inner === null || typeof inner !== "object")) {
      return coerce(inner);
    }
  }
  return v;
}

interface ParsedIngest {
  vin: string;
  ts: number;
  fields: Record<string, unknown>; // raw telemetry field name -> value
}

function parseOne(body: Record<string, unknown>): ParsedIngest | null {
  const vin = typeof body.vin === "string" ? body.vin : null;
  if (!vin) return null;
  let ts = Math.floor(Date.now() / 1000);
  if (typeof body.ts === "number") ts = Math.floor(body.ts > 1e12 ? body.ts / 1000 : body.ts);
  else if (typeof body.createdAt === "string") {
    const parsed = Date.parse(body.createdAt);
    if (!Number.isNaN(parsed)) ts = Math.floor(parsed / 1000);
  }

  const fields: Record<string, unknown> = {};
  if (Array.isArray(body.data)) {
    for (const item of body.data) {
      const { key, value } = (item ?? {}) as { key?: string; value?: unknown };
      if (!key) continue;
      const unwrapped = unwrapFtValue(value);
      if (unwrapped !== undefined) fields[key] = unwrapped;
    }
  } else if (body.data && typeof body.data === "object") {
    for (const [k, v] of Object.entries(body.data as Record<string, unknown>)) fields[k] = coerce(v);
  } else {
    return null;
  }
  return { vin, ts, fields };
}

/** Applies one parsed ingest: latest + structured sample + derivation + EAV + rules. */
export async function applyIngest(env: Env, parsed: ParsedIngest): Promise<LatestState> {
  const events: TelemetryEvent[] = [];
  const patch: Record<string, unknown> = {};

  for (const [field, rawValue] of Object.entries(parsed.fields)) {
    let value = rawValue;
    const canonical = FIELD_MAP[field] ?? field.toLowerCase();
    if (canonical === "charging_state") value = normalizeChargingState(value);
    value = toMetric(canonical, value);

    if (canonical === "location" && value && typeof value === "object") {
      const loc = value as { latitude?: number; longitude?: number };
      if (typeof loc.latitude === "number" && typeof loc.longitude === "number") {
        patch.lat = loc.latitude;
        patch.lon = loc.longitude;
      }
      continue;
    }

    patch[canonical] = value;
    // EAV history holds only fields not captured as structured position columns.
    if (!POSITION_COLUMNS.has(canonical) && !META_FIELDS.has(canonical) && canonical !== "location") {
      events.push({ field: canonical, value, ts: parsed.ts });
    }
  }

  // Fold AC/DC charging power + energy into single canonical fields, tagging the
  // charge type so charge sessions record AC vs DC.
  resolveCharging(patch);

  await recordEvents(env, parsed.vin, events);
  const { previous, current } = await mergeLatest(env, parsed.vin, patch, parsed.ts);
  await applyDerivation(env, parsed.vin, parsed.ts, previous, current);
  await evaluateOnIngest(env, parsed.vin, previous, current);
  return current;
}

/** Collapses ac_/dc_ charging fields into charger_power / charge_energy_added + charger_kind. */
function resolveCharging(patch: Record<string, unknown>): void {
  const asNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const ac = asNum(patch.ac_charging_power);
  const dc = asNum(patch.dc_charging_power);
  if (dc !== undefined && dc > 0) {
    patch.charger_power = dc;
    patch.charger_kind = "DC";
  } else if (ac !== undefined) {
    patch.charger_power = ac;
    patch.charger_kind = "AC";
  } else if (dc !== undefined) {
    patch.charger_power = dc;
  }
  const acE = asNum(patch.ac_charge_energy_added);
  const dcE = asNum(patch.dc_charge_energy_added);
  if (patch.charge_energy_added === undefined) {
    if (dcE !== undefined && (patch.charger_kind === "DC" || acE === undefined)) patch.charge_energy_added = dcE;
    else if (acE !== undefined) patch.charge_energy_added = acE;
  }
}

export async function handleIngest(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400 });
  }

  const items: Record<string, unknown>[] = [];
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.events)) items.push(...(b.events as Record<string, unknown>[]));
  else if (Array.isArray(body)) items.push(...(body as Record<string, unknown>[]));
  else items.push(b);

  // Apply in timestamp order: the derivation state machine assumes monotonic
  // time, so an out-of-order batch would corrupt drive/charge/state boundaries.
  const parsed = items.map(parseOne).filter((x): x is NonNullable<typeof x> => x !== null);
  parsed.sort((a, b2) => a.ts - b2.ts);
  for (const p of parsed) await applyIngest(env, p);

  return new Response(JSON.stringify({ accepted: parsed.length, rejected: items.length - parsed.length }), {
    headers: { "content-type": "application/json" },
  });
}

/** Folds a REST vehicle_data response into the same store (poll path). */
export async function applyVehicleData(
  env: Env,
  vin: string,
  vd: Record<string, unknown>,
): Promise<LatestState> {
  const ts = Math.floor(Date.now() / 1000);
  const charge = (vd.charge_state ?? {}) as Record<string, unknown>;
  const climate = (vd.climate_state ?? {}) as Record<string, unknown>;
  const drive = (vd.drive_state ?? {}) as Record<string, unknown>;
  const vehicle = (vd.vehicle_state ?? {}) as Record<string, unknown>;

  const fields: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v !== undefined && v !== null) fields[k] = v;
  };
  put("Soc", charge.battery_level);
  put("UsableBatteryLevel", charge.usable_battery_level);
  put("EstBatteryRange", charge.est_battery_range);
  put("RatedRange", charge.battery_range);
  put("IdealBatteryRange", charge.ideal_battery_range);
  put("ChargingState", charge.charging_state);
  put("ChargeLimitSoc", charge.charge_limit_soc);
  put("ChargeAmps", charge.charger_actual_current);
  put("ChargerVoltage", charge.charger_voltage);
  put("ChargeEnergyAdded", charge.charge_energy_added);
  // charger_power is reported in kW; fast_charger_present distinguishes DC.
  if (charge.fast_charger_present === true) put("DCChargingPower", charge.charger_power);
  else put("ACChargingPower", charge.charger_power);
  put("InsideTemp", climate.inside_temp);
  put("OutsideTemp", climate.outside_temp);
  put("Odometer", vehicle.odometer);
  put("Locked", vehicle.locked);
  put("SentryMode", (vehicle.sentry_mode as boolean) ?? undefined);
  put("TpmsPressureFl", vehicle.tpms_pressure_fl);
  put("TpmsPressureFr", vehicle.tpms_pressure_fr);
  put("TpmsPressureRl", vehicle.tpms_pressure_rl);
  put("TpmsPressureRr", vehicle.tpms_pressure_rr);
  put("Gear", drive.shift_state);
  put("VehicleSpeed", drive.speed);
  put("GpsHeading", drive.heading);
  put("power", drive.power); // kW; drive_state.power maps 1:1 to the canonical field
  if (typeof drive.latitude === "number" && typeof drive.longitude === "number") {
    fields.Location = { latitude: drive.latitude, longitude: drive.longitude };
  }
  return applyIngest(env, { vin, ts, fields });
}
