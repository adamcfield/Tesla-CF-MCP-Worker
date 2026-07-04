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
 * Each ingest: raw fields → D1 history, canonical fields → KV latest-state,
 * charge-session state machine, then rule evaluation (geofences, alerts).
 */

import { evaluateOnIngest } from "./rules";
import { LatestState, mergeLatest, recordEvents, trackChargeSession, TelemetryEvent } from "./store";
import { Env } from "./types";

/** Maps telemetry field names → canonical latest-state keys (lowercased snake). */
const FIELD_MAP: Record<string, string> = {
  Soc: "soc",
  BatteryLevel: "soc",
  EstBatteryRange: "est_range",
  RatedRange: "rated_range",
  IdealBatteryRange: "ideal_range",
  Odometer: "odometer",
  VehicleSpeed: "speed",
  Location: "location",
  Locked: "locked",
  SentryMode: "sentry",
  DetailedChargeState: "charging_state",
  ChargeState: "charging_state",
  ChargingState: "charging_state",
  ChargeAmps: "charge_amps",
  ChargeCurrentRequest: "charge_current_request",
  ChargeLimitSoc: "charge_limit",
  ACChargingPower: "charger_power_kw",
  DCChargingPower: "dc_charger_power_kw",
  ACChargingEnergyIn: "charge_energy_added",
  ChargeEnergyAdded: "charge_energy_added",
  InsideTemp: "inside_temp",
  OutsideTemp: "outside_temp",
  TpmsPressureFl: "tpms_fl",
  TpmsPressureFr: "tpms_fr",
  TpmsPressureRl: "tpms_rl",
  TpmsPressureRr: "tpms_rr",
  Gear: "gear",
  DoorState: "door_state",
  FdWindow: "window_fd",
};

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

/** Unwraps fleet-telemetry {stringValue|intValue|floatValue|doubleValue|booleanValue|locationValue} */
function unwrapFtValue(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if (o.locationValue && typeof o.locationValue === "object") return o.locationValue;
  for (const k of ["stringValue", "intValue", "floatValue", "doubleValue", "booleanValue", "longValue"]) {
    if (o[k] !== undefined) return coerce(o[k]);
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
      if (key) fields[key] = unwrapFtValue(value);
    }
  } else if (body.data && typeof body.data === "object") {
    for (const [k, v] of Object.entries(body.data as Record<string, unknown>)) fields[k] = coerce(v);
  } else {
    return null;
  }
  return { vin, ts, fields };
}

/** Applies one parsed ingest: history + latest + sessions + rules. */
export async function applyIngest(env: Env, parsed: ParsedIngest): Promise<LatestState> {
  const events: TelemetryEvent[] = [];
  const patch: Record<string, unknown> = {};

  for (const [field, rawValue] of Object.entries(parsed.fields)) {
    let value = rawValue;
    const canonical = FIELD_MAP[field] ?? field.toLowerCase();
    if (canonical === "charging_state") value = normalizeChargingState(value);

    if (canonical === "location" && value && typeof value === "object") {
      const loc = value as { latitude?: number; longitude?: number };
      if (typeof loc.latitude === "number" && typeof loc.longitude === "number") {
        patch.lat = loc.latitude;
        patch.lon = loc.longitude;
        events.push({ field: "lat", value: loc.latitude, ts: parsed.ts });
        events.push({ field: "lon", value: loc.longitude, ts: parsed.ts });
      }
      continue;
    }

    patch[canonical] = value;
    events.push({ field: canonical, value, ts: parsed.ts });
  }

  await recordEvents(env, parsed.vin, events);
  const { previous, current } = await mergeLatest(env, parsed.vin, patch, parsed.ts);
  await trackChargeSession(env, parsed.vin, previous, current);
  await evaluateOnIngest(env, parsed.vin, previous, current);
  return current;
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

  let accepted = 0;
  for (const item of items) {
    const parsed = parseOne(item);
    if (parsed) {
      await applyIngest(env, parsed);
      accepted++;
    }
  }
  return new Response(JSON.stringify({ accepted, rejected: items.length - accepted }), {
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
  put("EstBatteryRange", charge.est_battery_range);
  put("ChargingState", charge.charging_state);
  put("ChargeLimitSoc", charge.charge_limit_soc);
  put("ChargeAmps", charge.charger_actual_current);
  put("ChargeEnergyAdded", charge.charge_energy_added);
  put("InsideTemp", climate.inside_temp);
  put("OutsideTemp", climate.outside_temp);
  put("Odometer", vehicle.odometer);
  put("Locked", vehicle.locked);
  put("SentryMode", (vehicle.sentry_mode as boolean) ?? undefined);
  put("TpmsPressureFl", vehicle.tpms_pressure_fl);
  put("TpmsPressureFr", vehicle.tpms_pressure_fr);
  put("TpmsPressureRl", vehicle.tpms_pressure_rl);
  put("TpmsPressureRr", vehicle.tpms_pressure_rr);
  if (typeof drive.latitude === "number" && typeof drive.longitude === "number") {
    fields.Location = { latitude: drive.latitude, longitude: drive.longitude };
  }
  return applyIngest(env, { vin, ts, fields });
}
