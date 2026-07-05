/**
 * TeslaMate-grade tracking: the ingest-time derivation engine and the read
 * queries that back both the MCP tools and the /data REST routes.
 *
 * Session boundaries are derived from raw telemetry state transitions, not from
 * Tesla — an OPEN row (drives.status='active' / charge_sessions.end_ts IS NULL /
 * vehicle_states.end_ts IS NULL) is the source of truth and is read back from
 * D1, so derivation survives isolate restarts with no KV bookkeeping.
 *
 * This path is passive: it only ever runs on data that was pushed to us (a
 * telemetry ingest or an on-demand poll the user already paid for). It never
 * calls the Fleet API and never wakes a vehicle.
 *
 * Derived-not-stored: battery degradation and vampire drain are computed by
 * query over charge_sessions / positions so they are always fresh.
 */

import { getChargingHistory } from "./api";
import { getBudgetStatus } from "./budget";
import { reverseGeocode } from "./geocode";
import { scoreDrive } from "./scoring";
import {
  ensureSchema,
  haversineMeters,
  insertPosition,
  LatestState,
  num,
  PositionSample,
  tzOffsetMinutes,
} from "./store";
import { Env } from "./types";

const CHARGING = new Set(["Charging", "Starting"]);
/** A drive that moves less than this / lasts less than this is discarded as noise. */
const MIN_DRIVE_KM = 0.05;
const MIN_DRIVE_SECONDS = 60;

// ---------------------------------------------------------------------------
// Canonical-field helpers
// ---------------------------------------------------------------------------

/** DetailedChargeState / Gear enums arrive with a type prefix, e.g. "ShiftStateD". */
function stripEnumPrefix(v: unknown, prefix: string): unknown {
  return typeof v === "string" && v.startsWith(prefix) ? v.slice(prefix.length) : v;
}

/** Normalizes gear/shift to a single letter D|R|N|P (or undefined). */
export function normalizeGear(v: unknown): "D" | "R" | "N" | "P" | undefined {
  const s = String(stripEnumPrefix(v, "ShiftState") ?? "").trim().toUpperCase();
  return s === "D" || s === "R" || s === "N" || s === "P" ? s : undefined;
}

export type Activity = "driving" | "charging" | "idle";

/**
 * Derives the vehicle's activity from merged canonical state.
 *
 * Definitive driving signals are checked BEFORE charging: telemetry only sends a
 * field when it changes, so `charging_state` in the merged latest-state doc can
 * be a stale "Charging" left over from before the car was unplugged and driven
 * off. A car in gear D/R or actually moving physically cannot be charging, so it
 * must win — otherwise the drive is never detected and the charge session hangs
 * open through the whole trip.
 */
export function deriveActivity(s: LatestState): Activity {
  const gear = normalizeGear(s.gear);
  const speed = num(s.speed);
  const moving = speed !== null && speed > 1;
  if (gear === "D" || gear === "R") return "driving";
  if (moving && gear !== "P") return "driving";
  const cs = String(s.charging_state ?? "");
  if (CHARGING.has(cs)) return "charging";
  return "idle";
}

/** Maps activity (plus a possible software update) to a state-timeline label. */
function timelineState(s: LatestState, activity: Activity): string {
  if (activity === "driving") return "driving";
  if (activity === "charging") return "charging";
  const pct = num(s.software_update_pct);
  if (pct !== null && pct > 0 && pct < 100) return "updating";
  return "online";
}

/** Builds the structured positions sample from merged canonical state. */
function buildSample(s: LatestState, activity: Activity): PositionSample {
  return {
    activity,
    lat: num(s.lat),
    lon: num(s.lon),
    elevation: num(s.elevation),
    heading: num(s.heading),
    speed: num(s.speed),
    power: num(s.power),
    odometer: num(s.odometer),
    soc: num(s.soc),
    usable_soc: num(s.usable_soc),
    energy_remaining: num(s.energy_remaining),
    rated_range: num(s.rated_range),
    est_range: num(s.est_range),
    ideal_range: num(s.ideal_range),
    inside_temp: num(s.inside_temp),
    outside_temp: num(s.outside_temp),
    charging_state: s.charging_state == null ? null : String(s.charging_state),
    charger_power: num(s.charger_power),
    charger_voltage: num(s.charger_voltage),
    charger_current: num(s.charger_current),
    charge_energy_added: num(s.charge_energy_added),
  };
}

// ---------------------------------------------------------------------------
// Entry point — called by ingest after mergeLatest()
// ---------------------------------------------------------------------------

/**
 * Advances all derivation state machines for one merged sample.
 * `priceCentsKwh` is an optional per-charge price hint from a price rule.
 */
export async function applyDerivation(
  env: Env,
  vin: string,
  ts: number,
  previous: LatestState | null,
  current: LatestState,
  priceCentsKwh?: number,
): Promise<void> {
  await ensureSchema(env);
  const activity = deriveActivity(current);

  // 1. Drives — open/close BEFORE inserting the position so it can be tagged.
  let openDrive = await getOpenDrive(env, vin);
  if (openDrive && activity !== "driving") {
    await closeDrive(env, openDrive, current, ts);
    openDrive = null;
  } else if (!openDrive && activity === "driving") {
    openDrive = await openDrive_(env, vin, ts, current);
  }

  // 2. Position sample (tagged to the open drive, if any).
  const sample = buildSample(current, activity);
  sample.drive_id = openDrive?.id ?? null;
  await insertPosition(env, vin, ts, sample);

  // 3. State timeline.
  await updateStateTimeline(env, vin, timelineState(current, activity), ts, "ingest");

  // 4. Charge sessions + curve.
  await trackCharge(env, vin, current, ts, activity === "charging", priceCentsKwh);
}

// ---------------------------------------------------------------------------
// Drives
// ---------------------------------------------------------------------------

export interface DriveRow {
  id: number;
  vin: string;
  start_ts: number;
  start_odometer: number | null;
  max_charger_power?: number | null;
}

async function getOpenDrive(env: Env, vin: string): Promise<DriveRow | null> {
  return env.DB.prepare(
    `SELECT id, vin, start_ts, start_odometer FROM drives
     WHERE vin = ?1 AND status = 'active' ORDER BY start_ts DESC LIMIT 1`,
  )
    .bind(vin)
    .first<DriveRow>();
}

async function openDrive_(env: Env, vin: string, ts: number, s: LatestState): Promise<DriveRow> {
  const lat = num(s.lat);
  const lon = num(s.lon);
  const locId = lat !== null && lon !== null ? await matchLocation(env, lat, lon) : null;
  const res = await env.DB.prepare(
    `INSERT INTO drives (
       vin, start_ts, status, start_lat, start_lon, start_location_id,
       start_odometer, start_soc, start_rated_range, start_ideal_range, start_outside_temp
     ) VALUES (?1,?2,'active',?3,?4,?5,?6,?7,?8,?9,?10)`,
  )
    .bind(vin, ts, lat, lon, locId, num(s.odometer), num(s.soc), num(s.rated_range), num(s.ideal_range), num(s.outside_temp))
    .run();
  const id = Number(res.meta.last_row_id ?? 0);
  return { id, vin, start_ts: ts, start_odometer: num(s.odometer) };
}

async function closeDrive(env: Env, drive: DriveRow, s: LatestState, ts: number): Promise<void> {
  const agg = await env.DB.prepare(
    `SELECT COUNT(*) n, MAX(speed) max_speed, AVG(speed) avg_speed,
            MAX(power) max_power, AVG(power) avg_power, AVG(outside_temp) outside_temp_avg
     FROM positions WHERE drive_id = ?1`,
  )
    .bind(drive.id)
    .first<{ n: number; max_speed: number | null; avg_speed: number | null; max_power: number | null; avg_power: number | null; outside_temp_avg: number | null }>();

  const startPos = await env.DB.prepare(
    `SELECT energy_remaining, soc, rated_range, odometer FROM positions
     WHERE drive_id = ?1 ORDER BY ts ASC LIMIT 1`,
  )
    .bind(drive.id)
    .first<{ energy_remaining: number | null; soc: number | null; rated_range: number | null; odometer: number | null }>();

  const startOdo = drive.start_odometer ?? startPos?.odometer ?? null;
  const endOdo = num(s.odometer);
  const distanceKm = startOdo !== null && endOdo !== null ? Math.max(0, endOdo - startOdo) : null;
  const durationMin = (ts - drive.start_ts) / 60;

  const energyUsed = await estimateDriveEnergy(env, drive.vin, startPos, s);
  const efficiency =
    energyUsed !== null && distanceKm !== null && distanceKm > 0.1
      ? (energyUsed * 1000) / distanceKm
      : null;
  const avgSpeed =
    distanceKm !== null && durationMin > 0 ? distanceKm / (durationMin / 60) : num(agg?.avg_speed);

  const lat = num(s.lat);
  const lon = num(s.lon);
  const endLocId = lat !== null && lon !== null ? await matchLocation(env, lat, lon) : null;

  // Discard drives that never really moved (parking jitter, GPS drift).
  if ((distanceKm ?? 0) < MIN_DRIVE_KM && durationMin * 60 < MIN_DRIVE_SECONDS) {
    await env.DB.prepare(`UPDATE positions SET drive_id = NULL WHERE drive_id = ?1`).bind(drive.id).run();
    await env.DB.prepare(`DELETE FROM drives WHERE id = ?1`).bind(drive.id).run();
    return;
  }

  // Driving-behaviour metrics from the drive's speed/heading samples.
  const samplesRs = await env.DB.prepare(
    `SELECT ts, speed, heading FROM positions WHERE drive_id = ?1 ORDER BY ts ASC`,
  )
    .bind(drive.id)
    .all<{ ts: number; speed: number | null; heading: number | null }>();
  const tzOffsetMin = (await getVehicleTz(env, drive.vin)) ?? 0;
  const behavior = scoreDrive(samplesRs.results ?? [], { distanceKm, tzOffsetMin });

  // Place names for the endpoints (best-effort; a named geofence wins in the UI).
  const startPoint = await env.DB.prepare(
    `SELECT start_lat, start_lon FROM drives WHERE id = ?1`,
  ).bind(drive.id).first<{ start_lat: number | null; start_lon: number | null }>();
  const startAddr = startPoint?.start_lat != null && startPoint?.start_lon != null
    ? await reverseGeocode(env, startPoint.start_lat, startPoint.start_lon)
    : null;
  const endAddr = lat !== null && lon !== null ? await reverseGeocode(env, lat, lon) : null;

  await env.DB.prepare(
    `UPDATE drives SET
       end_ts = ?2, status = 'complete', end_lat = ?3, end_lon = ?4, end_location_id = ?5,
       end_odometer = ?6, distance_km = ?7, end_soc = ?8, end_rated_range = ?9,
       end_ideal_range = ?10, duration_min = ?11, energy_used_kwh = ?12, efficiency_wh_km = ?13,
       avg_speed = ?14, max_speed = ?15, avg_power = ?16, max_power = ?17,
       outside_temp_avg = ?18, sample_count = ?19,
       max_accel_ms2 = ?20, max_decel_ms2 = ?21, harsh_accel_count = ?22, harsh_brake_count = ?23,
       harsh_turn_count = ?24, over_limit_frac = ?25, night_frac = ?26, behavior_score = ?27,
       start_address = ?28, end_address = ?29, max_jerk_ms3 = ?30
     WHERE id = ?1`,
  )
    .bind(
      drive.id, ts, lat, lon, endLocId, endOdo, distanceKm, num(s.soc), num(s.rated_range),
      num(s.ideal_range), durationMin, energyUsed, efficiency, avgSpeed, num(agg?.max_speed),
      num(agg?.avg_power), num(agg?.max_power), num(agg?.outside_temp_avg), agg?.n ?? 0,
      behavior.max_accel_ms2, behavior.max_decel_ms2, behavior.harsh_accel_count, behavior.harsh_brake_count,
      behavior.harsh_turn_count, behavior.over_limit_frac, behavior.night_frac, behavior.behavior_score,
      startAddr, endAddr, behavior.max_jerk_ms3,
    )
    .run();

  // Auto-suggest a driver from historically-tagged drives with the same start
  // context (geofence/grid + hour-of-week bucket). Best-effort; never blocks.
  await suggestDriverForDrive(env, drive.id, drive.vin).catch(() => {});
}

/**
 * Per-vehicle timezone offset (minutes) for night-driving calc. Priority:
 * an explicit KV override (`tz_offset:VIN`), else the DST-aware offset of the
 * DEFAULT_TZ IANA zone (default Asia/Jerusalem — this fixed night_frac being
 * silently computed against UTC, mislabeling Israeli evening driving).
 */
async function getVehicleTz(env: Env, vin: string): Promise<number | null> {
  const v = await env.TESLA_KV.get(`tz_offset:${vin}`).catch(() => null);
  if (v != null && Number.isFinite(Number(v))) return Number(v);
  return tzOffsetMinutes(env.DEFAULT_TZ || "Asia/Jerusalem");
}

/**
 * Drive energy (kWh), best available method:
 *  1. EnergyRemaining delta (most direct)
 *  2. SoC delta × cached usable pack kWh
 *  3. rated-range delta × cached Wh/rated-km
 */
async function estimateDriveEnergy(
  env: Env,
  vin: string,
  startPos: { energy_remaining: number | null; soc: number | null; rated_range: number | null } | null,
  end: LatestState,
): Promise<number | null> {
  const startEr = startPos?.energy_remaining ?? null;
  const endEr = num(end.energy_remaining);
  if (startEr !== null && endEr !== null) return startEr - endEr;

  const startSoc = startPos?.soc ?? null;
  const endSoc = num(end.soc);
  const pack = await getPackKwh(env, vin);
  if (startSoc !== null && endSoc !== null && pack !== null) return ((startSoc - endSoc) / 100) * pack;

  const startRr = startPos?.rated_range ?? null;
  const endRr = num(end.rated_range);
  const whPerKm = await getRatedWhPerKm(env, vin);
  if (startRr !== null && endRr !== null && whPerKm !== null) return ((startRr - endRr) * whPerKm) / 1000;

  return null;
}

// ---------------------------------------------------------------------------
// Vehicle-state timeline
// ---------------------------------------------------------------------------

interface StateRow {
  id: number;
  state: string;
  start_ts: number;
}

async function getOpenState(env: Env, vin: string): Promise<StateRow | null> {
  return env.DB.prepare(
    `SELECT id, state, start_ts FROM vehicle_states
     WHERE vin = ?1 AND end_ts IS NULL ORDER BY start_ts DESC LIMIT 1`,
  )
    .bind(vin)
    .first<StateRow>();
}

async function updateStateTimeline(
  env: Env,
  vin: string,
  state: string,
  ts: number,
  source: string,
): Promise<void> {
  const open = await getOpenState(env, vin);
  if (open && open.state === state) return;
  if (open) {
    // Always close the previous span so we never leave two rows open (which
    // would happen if a differing state arrived at the same ts). Clamp end_ts
    // to start_ts for any out-of-order sample so duration is never negative.
    const endTs = Math.max(ts, open.start_ts);
    await env.DB.prepare(`UPDATE vehicle_states SET end_ts = ?2 WHERE id = ?1`).bind(open.id, endTs).run();
  }
  await env.DB.prepare(
    `INSERT INTO vehicle_states (vin, state, start_ts, source) VALUES (?1,?2,?3,?4)`,
  )
    .bind(vin, state, ts, source)
    .run();
}

/**
 * Cron-side connectivity → state timeline (asleep/offline/wake). Ingest owns the
 * fine-grained online sub-states (driving/charging/online), so a plain "online"
 * from the connectivity check only transitions when the car was asleep/offline.
 */
export async function recordConnectivityState(env: Env, vin: string, teslaState: string): Promise<void> {
  await ensureSchema(env);
  const state = teslaState === "asleep" ? "asleep" : teslaState === "offline" ? "offline" : "online";
  const ts = Math.floor(Date.now() / 1000);
  const open = await getOpenState(env, vin);
  if (state === "online" && open && ["driving", "charging", "online", "updating"].includes(open.state)) {
    return; // ingest is authoritative while the car is actively reporting
  }
  await updateStateTimeline(env, vin, state, ts, "cron");
}

// ---------------------------------------------------------------------------
// Charge sessions + curve
// ---------------------------------------------------------------------------

interface ChargeSessionRow {
  id: number;
  price_cents_kwh: number | null;
  location_id: number | null;
  max_charger_power: number | null;
  start_soc: number | null;
}

async function getOpenChargeSession(env: Env, vin: string): Promise<ChargeSessionRow | null> {
  return env.DB.prepare(
    `SELECT id, price_cents_kwh, location_id, max_charger_power, start_soc
     FROM charge_sessions WHERE vin = ?1 AND end_ts IS NULL ORDER BY start_ts DESC LIMIT 1`,
  )
    .bind(vin)
    .first<ChargeSessionRow>();
}

async function trackCharge(
  env: Env,
  vin: string,
  current: LatestState,
  ts: number,
  chargingNow: boolean,
  priceCentsKwh?: number,
): Promise<void> {
  let session = await getOpenChargeSession(env, vin);

  if (chargingNow) {
    if (!session) session = await openChargeSession(env, vin, current, ts, priceCentsKwh);
    await appendCurve(env, session.id, vin, current, ts);
    const p = num(current.charger_power);
    if (p !== null && (session.max_charger_power == null || p > session.max_charger_power)) {
      await env.DB.prepare(`UPDATE charge_sessions SET max_charger_power = ?2 WHERE id = ?1`)
        .bind(session.id, p)
        .run();
    }
  } else if (session) {
    await closeChargeSession(env, session, current, ts);
  }
}

async function openChargeSession(
  env: Env,
  vin: string,
  s: LatestState,
  ts: number,
  priceCentsKwh?: number,
): Promise<ChargeSessionRow> {
  const lat = num(s.lat);
  const lon = num(s.lon);
  const locId = lat !== null && lon !== null ? await matchLocation(env, lat, lon) : null;
  const chargeType = String(s.charger_kind ?? "") === "DC" ? "DC" : "AC";
  const res = await env.DB.prepare(
    `INSERT INTO charge_sessions (
       vin, start_ts, status, start_soc, lat, lon, price_cents_kwh, start_odometer,
       start_rated_range, start_ideal_range, charge_type, location_id
     ) VALUES (?1,?2,'active',?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
  )
    .bind(vin, ts, num(s.soc), lat, lon, priceCentsKwh ?? null, num(s.odometer), num(s.rated_range), num(s.ideal_range), chargeType, locId)
    .run();
  const id = Number(res.meta.last_row_id ?? 0);
  return { id, price_cents_kwh: priceCentsKwh ?? null, location_id: locId, max_charger_power: null, start_soc: num(s.soc) };
}

async function appendCurve(env: Env, sessionId: number, vin: string, s: LatestState, ts: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO charges (
       session_id, vin, ts, soc, charger_power, charger_voltage, charger_current,
       charge_energy_added, rated_range, outside_temp
     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
  )
    .bind(
      sessionId, vin, ts, num(s.soc), num(s.charger_power), num(s.charger_voltage),
      num(s.charger_current), num(s.charge_energy_added), num(s.rated_range), num(s.outside_temp),
    )
    .run();
}

async function closeChargeSession(
  env: Env,
  session: ChargeSessionRow,
  s: LatestState,
  ts: number,
): Promise<void> {
  const startTs = await env.DB.prepare(`SELECT start_ts FROM charge_sessions WHERE id = ?1`)
    .bind(session.id)
    .first<{ start_ts: number }>();
  const energyAdded = num(s.charge_energy_added);
  const endSoc = num(s.soc);

  // cost: a per-location price wins over a price-rule hint.
  const perKwh = await locationCostPerKwh(env, session.location_id, session.price_cents_kwh);
  const cost = energyAdded !== null && perKwh !== null ? energyAdded * perKwh : null;

  const tempAvg = await env.DB.prepare(`SELECT AVG(outside_temp) t FROM charges WHERE session_id = ?1`)
    .bind(session.id)
    .first<{ t: number | null }>();

  await env.DB.prepare(
    `UPDATE charge_sessions SET
       end_ts = ?2, status = 'complete', end_soc = ?3, energy_added_kwh = ?4, cost = ?5,
       end_rated_range = ?6, end_ideal_range = ?7, duration_min = ?8, outside_temp_avg = ?9
     WHERE id = ?1`,
  )
    .bind(
      session.id, ts, endSoc, energyAdded, cost, num(s.rated_range), num(s.ideal_range),
      startTs ? (ts - startTs.start_ts) / 60 : null, num(tempAvg?.t),
    )
    .run();

  // Self-calibrate usable pack size from a clean session (>=10% SoC gained).
  if (energyAdded !== null && energyAdded > 0 && session.start_soc !== null && endSoc !== null) {
    const dSoc = endSoc - session.start_soc;
    if (dSoc >= 10) await setPackKwh(env, s.vin, (energyAdded / dSoc) * 100);
  }

  // Self-calibrate rated Wh/km: at end-of-charge we know rated range at a known
  // SoC, so full range = range/soc·100 and rated_wh_km = pack·1000/full_range.
  // Replaces the blind 150 Wh/km fallback used by drive-energy estimation.
  const endRange = num(s.rated_range);
  if (endSoc !== null && endSoc >= 40 && endRange !== null && endRange > 0) {
    const pack = await getPackKwh(env, s.vin);
    if (pack !== null) {
      const fullRangeKm = (endRange / endSoc) * 100;
      const ratedWhKm = (pack * 1000) / fullRangeKm;
      if (Number.isFinite(ratedWhKm) && ratedWhKm > 80 && ratedWhKm < 350) {
        const prev = Number((await env.TESLA_KV.get(`rated_wh_km:${s.vin}`).catch(() => null)) ?? "");
        const next = Number.isFinite(prev) && prev > 0 ? prev * 0.7 + ratedWhKm * 0.3 : ratedWhKm;
        await env.TESLA_KV.put(`rated_wh_km:${s.vin}`, String(Math.round(next * 10) / 10)).catch(() => {});
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

interface LocationRow {
  id: number;
  name: string;
  lat: number;
  lon: number;
  radius_m: number;
  cost_per_kwh: number | null;
}

/** Nearest named location containing (lat,lon), or null. */
async function matchLocation(env: Env, lat: number, lon: number): Promise<number | null> {
  const rs = await env.DB.prepare(`SELECT id, lat, lon, radius_m FROM locations`).all<{
    id: number; lat: number; lon: number; radius_m: number;
  }>();
  let best: { id: number; d: number } | null = null;
  for (const l of rs.results ?? []) {
    const d = haversineMeters(lat, lon, l.lat, l.lon);
    if (d <= l.radius_m && (best === null || d < best.d)) best = { id: l.id, d };
  }
  return best?.id ?? null;
}

async function locationCostPerKwh(
  env: Env,
  locationId: number | null,
  priceCentsKwh: number | null,
): Promise<number | null> {
  if (locationId !== null) {
    const loc = await env.DB.prepare(`SELECT cost_per_kwh FROM locations WHERE id = ?1`)
      .bind(locationId)
      .first<{ cost_per_kwh: number | null }>();
    if (loc?.cost_per_kwh != null) return loc.cost_per_kwh;
  }
  return priceCentsKwh != null ? priceCentsKwh / 100 : null;
}

export async function listLocations(env: Env): Promise<LocationRow[]> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(`SELECT * FROM locations ORDER BY name`).all<LocationRow>();
  return rs.results ?? [];
}

export async function setLocation(
  env: Env,
  loc: { id?: number; name: string; lat: number; lon: number; radius_m?: number; cost_per_kwh?: number },
): Promise<{ id: number }> {
  await ensureSchema(env);
  if (loc.id !== undefined) {
    await env.DB.prepare(
      `UPDATE locations SET name=?2, lat=?3, lon=?4, radius_m=?5, cost_per_kwh=?6 WHERE id=?1`,
    )
      .bind(loc.id, loc.name, loc.lat, loc.lon, loc.radius_m ?? 150, loc.cost_per_kwh ?? null)
      .run();
    return { id: loc.id };
  }
  const res = await env.DB.prepare(
    `INSERT INTO locations (name, lat, lon, radius_m, cost_per_kwh, created_ts)
     VALUES (?1,?2,?3,?4,?5,?6)`,
  )
    .bind(loc.name, loc.lat, loc.lon, loc.radius_m ?? 150, loc.cost_per_kwh ?? null, Math.floor(Date.now() / 1000))
    .run();
  return { id: Number(res.meta.last_row_id ?? 0) };
}

export async function deleteLocation(env: Env, id: number): Promise<{ deleted: boolean }> {
  await ensureSchema(env);
  const res = await env.DB.prepare(`DELETE FROM locations WHERE id = ?1`).bind(id).run();
  return { deleted: (res.meta.changes ?? 0) > 0 };
}

export async function getLocationStats(env: Env, id: number): Promise<unknown> {
  await ensureSchema(env);
  const loc = await env.DB.prepare(`SELECT * FROM locations WHERE id = ?1`).bind(id).first();
  if (!loc) return { error: "location not found" };
  const drivesFrom = await env.DB.prepare(`SELECT COUNT(*) n FROM drives WHERE start_location_id = ?1`).bind(id).first<{ n: number }>();
  const drivesTo = await env.DB.prepare(`SELECT COUNT(*) n FROM drives WHERE end_location_id = ?1`).bind(id).first<{ n: number }>();
  const charges = await env.DB.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(energy_added_kwh),0) kwh, COALESCE(SUM(cost),0) cost
     FROM charge_sessions WHERE location_id = ?1 AND status = 'complete'`,
  ).bind(id).first<{ n: number; kwh: number; cost: number }>();
  return {
    location: loc,
    drives_from: drivesFrom?.n ?? 0,
    drives_to: drivesTo?.n ?? 0,
    charge_sessions: charges?.n ?? 0,
    total_energy_added_kwh: round(charges?.kwh ?? 0, 2),
    total_cost: round(charges?.cost ?? 0, 2),
  };
}

// ---------------------------------------------------------------------------
// Read queries — drives / charges / state timeline
// ---------------------------------------------------------------------------

export async function getDrives(env: Env, vin: string, limit = 50): Promise<unknown[]> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT * FROM drives WHERE vin = ?1 AND status = 'complete' ORDER BY start_ts DESC LIMIT ?2`,
  )
    .bind(vin, limit)
    .all();
  return rs.results ?? [];
}

/**
 * Reverse-geocodes completed drives that don't yet have place names (older
 * drives from before geocoding existed, or lookups that failed). Rate-limited
 * to respect Nominatim; the geocode_cache means repeat locations are instant.
 */
export async function backfillDriveAddresses(env: Env, vin: string, limit = 40): Promise<Record<string, unknown>> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT id, start_lat, start_lon, end_lat, end_lon FROM drives
     WHERE vin = ?1 AND status = 'complete' AND (start_address IS NULL OR end_address IS NULL)
     ORDER BY start_ts DESC LIMIT ?2`,
  )
    .bind(vin, limit)
    .all<{ id: number; start_lat: number | null; start_lon: number | null; end_lat: number | null; end_lon: number | null }>();
  let updated = 0;
  for (const d of rs.results ?? []) {
    const startAddr = d.start_lat != null && d.start_lon != null ? await reverseGeocode(env, d.start_lat, d.start_lon) : null;
    const endAddr = d.end_lat != null && d.end_lon != null ? await reverseGeocode(env, d.end_lat, d.end_lon) : null;
    if (startAddr || endAddr) {
      await env.DB.prepare(`UPDATE drives SET start_address = COALESCE(?2, start_address), end_address = COALESCE(?3, end_address) WHERE id = ?1`)
        .bind(d.id, startAddr, endAddr)
        .run();
      updated++;
    }
  }
  return { vin, examined: (rs.results ?? []).length, updated };
}

/** Assign (or clear, with driver=null) the driver of a drive. */
export async function setDriveDriver(env: Env, id: number, driver: string | null): Promise<{ updated: boolean }> {
  await ensureSchema(env);
  const res = await env.DB.prepare(`UPDATE drives SET driver = ?2 WHERE id = ?1`)
    .bind(id, driver && driver.trim() ? driver.trim() : null)
    .run();
  return { updated: (res.meta.changes ?? 0) > 0 };
}

/**
 * Per-driver behaviour roll-up — an insurance-style risk profile. Aggregates
 * completed drives grouped by the assigned `driver` label (unassigned drives
 * are grouped as "Unassigned"). Harsh-event rates are per 100 km so drivers
 * are comparable regardless of mileage. The behaviour score is distance-
 * weighted. `fidelity` flags whether sampling was dense enough to trust the
 * harsh-event metrics (they need ~10 s or faster; 60 s polling under-reports).
 */
export async function getDriverScores(env: Env, vin: string): Promise<unknown> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT COALESCE(driver, 'Unassigned') AS driver,
            COUNT(*) AS drives,
            COALESCE(SUM(distance_km), 0) AS km,
            COALESCE(SUM(duration_min), 0) AS minutes,
            MAX(max_speed) AS max_speed,
            AVG(avg_speed) AS avg_speed,
            MAX(max_decel_ms2) AS max_decel_ms2,
            COALESCE(SUM(harsh_brake_count), 0) AS harsh_brakes,
            COALESCE(SUM(harsh_accel_count), 0) AS harsh_accels,
            COALESCE(SUM(harsh_turn_count), 0) AS harsh_turns,
            AVG(over_limit_frac) AS over_limit_frac,
            AVG(night_frac) AS night_frac,
            SUM(behavior_score * COALESCE(distance_km, 0)) AS score_wsum,
            SUM(CASE WHEN behavior_score IS NOT NULL THEN COALESCE(distance_km, 0) ELSE 0 END) AS score_wden,
            SUM(sample_count) AS samples
     FROM drives WHERE vin = ?1 AND status = 'complete'
     GROUP BY COALESCE(driver, 'Unassigned')
     ORDER BY km DESC`,
  )
    .bind(vin)
    .all<any>();

  const drivers = (rs.results ?? []).map((r) => {
    const km = r.km || 0;
    const per100 = (n: number) => (km > 0 ? round((n / km) * 100, 2) : null);
    const samplesPerKm = km > 0 ? (r.samples || 0) / km : 0;
    return {
      driver: r.driver,
      drives: r.drives,
      distance_km: round(km, 1),
      duration_min: round(r.minutes || 0, 0),
      avg_speed_kmh: r.avg_speed != null ? round(r.avg_speed, 0) : null,
      max_speed_kmh: r.max_speed != null ? round(r.max_speed, 0) : null,
      max_decel_ms2: r.max_decel_ms2 != null ? round(r.max_decel_ms2, 2) : null,
      max_decel_g: r.max_decel_ms2 != null ? round(r.max_decel_ms2 / 9.81, 2) : null,
      harsh_brakes_per_100km: per100(r.harsh_brakes || 0),
      harsh_accels_per_100km: per100(r.harsh_accels || 0),
      harsh_turns_per_100km: per100(r.harsh_turns || 0),
      over_limit_pct: r.over_limit_frac != null ? round(r.over_limit_frac * 100, 1) : null,
      night_pct: r.night_frac != null ? round(r.night_frac * 100, 1) : null,
      behavior_score: r.score_wden > 0 ? round(r.score_wsum / r.score_wden, 0) : null,
      // Harsh-event metrics need dense sampling to be reliable.
      fidelity: samplesPerKm >= 3 ? "good" : samplesPerKm >= 1 ? "coarse" : "sparse",
    };
  });

  return {
    vin,
    drivers,
    note: "Harsh braking/acceleration/cornering are DERIVED from speed samples; they need ~10s (or faster) sampling to be reliable. At the current logging cadence, 'sparse'/'coarse' fidelity means harsh-event counts under-report — avg/max speed, night %, and mileage are always reliable.",
  };
}

export async function getDrive(env: Env, id: number): Promise<unknown> {
  await ensureSchema(env);
  const drive = await env.DB.prepare(`SELECT * FROM drives WHERE id = ?1`).bind(id).first();
  if (!drive) return { error: "drive not found" };
  const path = await env.DB.prepare(
    `SELECT ts, lat, lon, speed, power, soc, elevation FROM positions
     WHERE drive_id = ?1 ORDER BY ts ASC`,
  )
    .bind(id)
    .all();
  return { drive, path: path.results ?? [] };
}

export async function getChargeSessions(env: Env, vin: string, limit = 50): Promise<unknown[]> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT * FROM charge_sessions WHERE vin = ?1 ORDER BY start_ts DESC LIMIT ?2`,
  )
    .bind(vin, limit)
    .all();
  return rs.results ?? [];
}

/**
 * Backfills past Supercharger sessions from Tesla's charging-history API into
 * charge_sessions (idempotent — dedup by Tesla's sessionId via external_id).
 * These carry energy/cost/site/time but no SoC, range, or per-sample curve, so
 * they populate the Charges and Charging-stats views but not battery health.
 * Live-derived sessions (source='derived') are never touched.
 */
export async function backfillChargeHistory(env: Env, vin: string): Promise<Record<string, unknown>> {
  await ensureSchema(env);
  const sessions = await getChargingHistory(env, vin);
  let added = 0;
  let skipped = 0;
  for (const s of sessions) {
    if (!Number.isFinite(s.external_id)) { skipped++; continue; }
    const durationMin = s.start_ts !== null && s.end_ts !== null ? (s.end_ts - s.start_ts) / 60 : null;
    const res = await env.DB.prepare(
      `INSERT OR IGNORE INTO charge_sessions (
         vin, start_ts, end_ts, status, charge_type, energy_added_kwh, cost, currency,
         site_name, duration_min, external_id, source
       ) VALUES (?1,?2,?3,'complete','DC',?4,?5,?6,?7,?8,?9,'backfill')`,
    )
      .bind(vin, s.start_ts, s.end_ts, s.energy_kwh, s.cost, s.currency, s.site_name, durationMin, s.external_id)
      .run();
    if ((res.meta.changes ?? 0) > 0) added++; else skipped++;
  }
  return { vin, fetched: sessions.length, added, skipped_existing: skipped };
}

export async function getChargeCurve(env: Env, sessionId: number): Promise<unknown> {
  await ensureSchema(env);
  const session = await env.DB.prepare(`SELECT * FROM charge_sessions WHERE id = ?1`).bind(sessionId).first();
  if (!session) return { error: "charge session not found" };
  const curve = await env.DB.prepare(
    `SELECT ts, soc, charger_power, charger_voltage, charger_current, charge_energy_added, rated_range, outside_temp
     FROM charges WHERE session_id = ?1 ORDER BY ts ASC`,
  )
    .bind(sessionId)
    .all();
  return { session, curve: curve.results ?? [] };
}

export async function getStateTimeline(env: Env, vin: string, hours = 168): Promise<unknown[]> {
  await ensureSchema(env);
  const since = Math.floor(Date.now() / 1000) - Math.round(hours * 3600);
  const rs = await env.DB.prepare(
    `SELECT id, state, start_ts, end_ts, source,
            (COALESCE(end_ts, strftime('%s','now')) - start_ts) AS duration_s
     FROM vehicle_states
     WHERE vin = ?1 AND (end_ts IS NULL OR end_ts >= ?2) ORDER BY start_ts DESC`,
  )
    .bind(vin, since)
    .all();
  return rs.results ?? [];
}

// ---------------------------------------------------------------------------
// Derived: degradation
// ---------------------------------------------------------------------------

/**
 * Battery degradation from completed charge sessions: at the end of each charge
 * we know rated range at a known SoC, so projected range at 100% =
 * end_rated_range / end_soc * 100. Capacity is scaled by the self-calibrated
 * usable pack kWh.
 *
 * Quality: DC fast-charge endings (hot pack) and extreme-ambient sessions
 * inject several % of scatter, so the TREND is fitted only over "clean"
 * points — AC (or unknown-type legacy) sessions ending ≥60% SoC at mild
 * ambient — via least-squares, reported as %/year with an r² confidence
 * hint. The full series is still returned for plotting (flagged per point),
 * and naive first-vs-last is kept for continuity.
 */
export async function getBatteryDegradation(env: Env, vin: string): Promise<unknown> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT end_ts AS ts, end_soc, end_rated_range, charge_type, outside_temp_avg
     FROM charge_sessions
     WHERE vin = ?1 AND status = 'complete' AND end_soc IS NOT NULL AND end_soc > 50
       AND end_rated_range IS NOT NULL AND end_rated_range > 0
     ORDER BY end_ts ASC`,
  )
    .bind(vin)
    .all<{ ts: number; end_soc: number; end_rated_range: number; charge_type: string | null; outside_temp_avg: number | null }>();

  const pack = await getPackKwh(env, vin);
  // Per point, projected range at 100% is the real degradation signal (it moves
  // as the pack ages). Capacity is reported once at the top level — it would be
  // flat and misleading per-point since pack kWh is a single current estimate.
  const series = (rs.results ?? []).map((r) => {
    const clean =
      (r.charge_type === "AC" || r.charge_type == null) &&
      r.end_soc >= 60 &&
      (r.outside_temp_avg == null || (r.outside_temp_avg >= 5 && r.outside_temp_avg <= 38));
    return {
      ts: r.ts,
      projected_range_100_km: round((r.end_rated_range / r.end_soc) * 100, 1),
      at_soc: r.end_soc,
      clean,
    };
  });

  if (series.length < 2) {
    return { series, note: "Need at least two charges above 50% to estimate degradation.", pack_kwh: pack };
  }
  const first = series[0]!;
  const last = series[series.length - 1]!;
  const lossPct = round((1 - last.projected_range_100_km / first.projected_range_100_km) * 100, 2);

  // Least-squares trend over clean points (falls back to all if too few).
  const cleanPts = series.filter((p) => p.clean);
  const usedCleanOnly = cleanPts.length >= 3;
  const fitPts = (usedCleanOnly ? cleanPts : series).map((p) => ({ x: p.ts, y: p.projected_range_100_km }));
  let trend: Record<string, unknown> | null = null;
  if (fitPts.length >= 3) {
    const n = fitPts.length;
    const mx = fitPts.reduce((s, p) => s + p.x, 0) / n;
    const my = fitPts.reduce((s, p) => s + p.y, 0) / n;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of fitPts) {
      sxx += (p.x - mx) ** 2;
      sxy += (p.x - mx) * (p.y - my);
      syy += (p.y - my) ** 2;
    }
    if (sxx > 0 && syy > 0) {
      const slope = sxy / sxx; // km per second
      const r2 = (sxy * sxy) / (sxx * syy);
      const kmPerYear = slope * 365.25 * 86400;
      trend = {
        pct_per_year: round((-kmPerYear / my) * 100, 2), // positive = losing range
        r2: round(r2, 3),
        points_used: n,
        clean_only: usedCleanOnly,
        note: "Fitted on AC/mild-ambient session endings; low r² means the signal is still mostly noise.",
      };
    }
  }

  return {
    series,
    first_projected_range_100_km: first.projected_range_100_km,
    latest_projected_range_100_km: last.projected_range_100_km,
    degradation_pct: lossPct,
    trend,
    pack_kwh: pack != null ? round(pack, 2) : null,
    samples: series.length,
  };
}

// ---------------------------------------------------------------------------
// Derived: vampire drain (idle SoC loss)
// ---------------------------------------------------------------------------

/**
 * Idle/vampire drain: SoC lost between consecutive samples where the car was
 * neither driving nor charging and enough time passed (covers both awake-idle
 * and sleep, since telemetry pauses while asleep and resumes on wake).
 *
 * Each span is additionally classified ASLEEP vs AWAKE-IDLE by overlap with
 * the vehicle_states timeline — the actionable split: sleeping loses well
 * under 1%/day, while Sentry/awake-idle can burn an order of magnitude more.
 * A blended number hides exactly that.
 */
export async function getVampireDrain(env: Env, vin: string, days = 30): Promise<unknown> {
  await ensureSchema(env);
  const since = Math.floor(Date.now() / 1000) - Math.round(days * 86400);
  const rs = await env.DB.prepare(
    `SELECT ts, soc, activity, charging_state FROM positions
     WHERE vin = ?1 AND ts >= ?2 AND soc IS NOT NULL ORDER BY ts ASC`,
  )
    .bind(vin, since)
    .all<{ ts: number; soc: number; activity: string | null; charging_state: string | null }>();

  // Asleep spans in the window, for span classification by overlap.
  const sleepRs = await env.DB.prepare(
    `SELECT start_ts, COALESCE(end_ts, strftime('%s','now')) AS end_ts FROM vehicle_states
     WHERE vin = ?1 AND state = 'asleep' AND COALESCE(end_ts, strftime('%s','now')) >= ?2`,
  )
    .bind(vin, since)
    .all<{ start_ts: number; end_ts: number }>();
  const sleeps = sleepRs.results ?? [];
  const asleepOverlap = (a: number, b: number): number => {
    let s = 0;
    for (const sp of sleeps) s += Math.max(0, Math.min(b, sp.end_ts) - Math.max(a, sp.start_ts));
    return s;
  };

  const rows = rs.results ?? [];
  const MIN_GAP_S = 30 * 60; // 30 min
  const MAX_GAP_S = 3 * 86400; // ignore multi-day telemetry outages
  interface Span { start_ts: number; end_ts: number; hours: number; soc_lost: number; pct_per_day: number; kind: "sleep" | "awake" }
  const spans: Span[] = [];
  let totalLoss = 0;
  let totalHours = 0;
  const bucket = { sleep: { hours: 0, soc_lost: 0 }, awake: { hours: 0, soc_lost: 0 } };

  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    const dt = b.ts - a.ts;
    const idle =
      a.activity !== "driving" && a.activity !== "charging" &&
      b.activity !== "driving" && b.activity !== "charging" &&
      !CHARGING.has(String(a.charging_state ?? "")) && !CHARGING.has(String(b.charging_state ?? ""));
    if (!idle || dt < MIN_GAP_S || dt > MAX_GAP_S) continue;
    const loss = a.soc - b.soc;
    if (loss <= 0) continue; // charging/regen or noise
    const hours = dt / 3600;
    const kind: Span["kind"] = asleepOverlap(a.ts, b.ts) / dt >= 0.5 ? "sleep" : "awake";
    totalLoss += loss;
    totalHours += hours;
    bucket[kind].hours += hours;
    bucket[kind].soc_lost += loss;
    spans.push({ start_ts: a.ts, end_ts: b.ts, hours: round(hours, 2), soc_lost: round(loss, 2), pct_per_day: round((loss / hours) * 24, 3), kind });
  }

  const rate = (x: { hours: number; soc_lost: number }) =>
    x.hours > 0 ? round((x.soc_lost / x.hours) * 24, 3) : null;
  return {
    days,
    idle_spans: spans.length,
    total_soc_lost_pct: round(totalLoss, 2),
    total_idle_hours: round(totalHours, 1),
    avg_pct_per_day: totalHours > 0 ? round((totalLoss / totalHours) * 24, 3) : null,
    sleep: { hours: round(bucket.sleep.hours, 1), soc_lost: round(bucket.sleep.soc_lost, 2), pct_per_day: rate(bucket.sleep) },
    awake: { hours: round(bucket.awake.hours, 1), soc_lost: round(bucket.awake.soc_lost, 2), pct_per_day: rate(bucket.awake) },
    spans: spans.slice(-50),
  };
}

// ---------------------------------------------------------------------------
// Derived: tracking summary
// ---------------------------------------------------------------------------

export async function getTrackingSummary(env: Env, vin: string): Promise<unknown> {
  await ensureSchema(env);
  const drives = await env.DB.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(distance_km),0) km, COALESCE(SUM(energy_used_kwh),0) kwh,
            MAX(end_odometer) odo
     FROM drives WHERE vin = ?1 AND status = 'complete'`,
  ).bind(vin).first<{ n: number; km: number; kwh: number; odo: number | null }>();
  const charges = await env.DB.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(energy_added_kwh),0) kwh, COALESCE(SUM(cost),0) cost
     FROM charge_sessions WHERE vin = ?1 AND status = 'complete'`,
  ).bind(vin).first<{ n: number; kwh: number; cost: number }>();
  const latest = await env.DB.prepare(
    `SELECT ts, soc, odometer, rated_range FROM positions WHERE vin = ?1 ORDER BY ts DESC LIMIT 1`,
  ).bind(vin).first<{ ts: number; soc: number | null; odometer: number | null; rated_range: number | null }>();

  const drivenKm = drives?.km ?? 0;
  const usedKwh = drives?.kwh ?? 0;
  return {
    vin,
    odometer_km: latest?.odometer ?? drives?.odo ?? null,
    soc: latest?.soc ?? null,
    rated_range_km: latest?.rated_range ?? null,
    last_seen_ts: latest?.ts ?? null,
    drive_count: drives?.n ?? 0,
    total_distance_km: round(drivenKm, 1),
    total_drive_energy_kwh: round(usedKwh, 1),
    avg_efficiency_wh_km: drivenKm > 1 ? round((usedKwh * 1000) / drivenKm, 0) : null,
    charge_session_count: charges?.n ?? 0,
    total_charge_energy_kwh: round(charges?.kwh ?? 0, 1),
    total_charge_cost: round(charges?.cost ?? 0, 2),
    pack_kwh: await getPackKwh(env, vin),
    api_budget: await getBudgetStatus(env).catch(() => null),
  };
}

// ---------------------------------------------------------------------------
// Derived: efficiency vs ambient temperature
// ---------------------------------------------------------------------------

/**
 * Wh/km bucketed by 5 °C bins of each drive's average outside temperature —
 * the classic cold-weather range-penalty curve, distance-weighted so short
 * hops don't dominate. Uses only completed drives ≥2 km with a real
 * efficiency figure. $0: aggregates data already logged.
 */
export async function getEfficiencyByTemp(env: Env, vin: string): Promise<unknown> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT CAST(FLOOR(outside_temp_avg / 5) * 5 AS INTEGER) AS t_min,
            COUNT(*) AS drives,
            SUM(distance_km) AS distance_km,
            SUM(efficiency_wh_km * distance_km) / SUM(distance_km) AS avg_wh_km
     FROM drives
     WHERE vin = ?1 AND status = 'complete' AND distance_km >= 2
       AND efficiency_wh_km IS NOT NULL AND outside_temp_avg IS NOT NULL
     GROUP BY t_min ORDER BY t_min ASC`,
  )
    .bind(vin)
    .all<{ t_min: number; drives: number; distance_km: number; avg_wh_km: number }>();
  return {
    vin,
    bins: (rs.results ?? []).map((r) => ({
      t_min: r.t_min,
      t_max: r.t_min + 5,
      avg_wh_km: round(r.avg_wh_km, 0),
      drives: r.drives,
      distance_km: round(r.distance_km, 1),
    })),
  };
}

// ---------------------------------------------------------------------------
// Derived: tire pressures (TPMS)
// ---------------------------------------------------------------------------

const WHEELS = ["fl", "fr", "rl", "rr"] as const;

/**
 * Per-wheel TPMS history + latest reading + a linear-regression trend
 * (bar/week) that catches a slow leak weeks before the car complains.
 * TPMS lands in the EAV store (tpms_fl…rr, bar); series are downsampled
 * to ≤200 points per wheel for payload sanity.
 */
export async function getTirePressures(env: Env, vin: string, days = 30): Promise<unknown> {
  await ensureSchema(env);
  const since = Math.floor(Date.now() / 1000) - Math.round(days * 86400);
  const series: Record<string, [number, number][]> = {};
  const latest: Record<string, number> = {};
  let latestTs = 0;
  const trend: Record<string, number> = {};

  for (const w of WHEELS) {
    const rs = await env.DB.prepare(
      `SELECT ts, value_num FROM telemetry_events
       WHERE vin = ?1 AND field = ?2 AND ts >= ?3 AND value_num IS NOT NULL
       ORDER BY ts ASC`,
    )
      .bind(vin, `tpms_${w}`, since)
      .all<{ ts: number; value_num: number }>();
    const pts = (rs.results ?? []).map((r) => [r.ts, round(r.value_num, 2)] as [number, number]);
    // Downsample evenly to ≤200 points.
    const step = Math.max(1, Math.ceil(pts.length / 200));
    series[w] = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
    const lastPt = pts[pts.length - 1];
    if (lastPt) {
      latest[w] = lastPt[1];
      latestTs = Math.max(latestTs, lastPt[0]);
    }
    // Least-squares slope in bar/week (needs ≥5 points across ≥2 days).
    if (pts.length >= 5 && pts[pts.length - 1]![0] - pts[0]![0] >= 2 * 86400) {
      const n = pts.length;
      const mx = pts.reduce((s, p) => s + p[0], 0) / n;
      const my = pts.reduce((s, p) => s + p[1], 0) / n;
      let sxx = 0, sxy = 0;
      for (const p of pts) {
        sxx += (p[0] - mx) ** 2;
        sxy += (p[0] - mx) * (p[1] - my);
      }
      if (sxx > 0) trend[w] = round((sxy / sxx) * 7 * 86400, 3);
    }
  }

  const haveLatest = WHEELS.every((w) => latest[w] !== undefined);
  return {
    vin,
    unit: "bar",
    latest: haveLatest ? { fl: latest.fl, fr: latest.fr, rl: latest.rl, rr: latest.rr, ts: latestTs } : null,
    series,
    trend_bar_per_week: Object.keys(trend).length === 4
      ? { fl: trend.fl, fr: trend.fr, rl: trend.rl, rr: trend.rr }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Derived: monthly report
// ---------------------------------------------------------------------------

/**
 * Server-side monthly roll-up: driving (count/distance/energy/efficiency) +
 * charging (sessions/kWh/AC-DC split/cost) + cost per 100 km. Timestamps are
 * bucketed in the vehicle's local zone (DEFAULT_TZ) so a 23:30 drive doesn't
 * land in the wrong month. Also exposed as the get_monthly_report MCP tool so
 * Claude can answer "summarize my June" in one call.
 */
export async function getMonthlyReport(env: Env, vin: string, months = 12): Promise<unknown> {
  await ensureSchema(env);
  const tzMin = (await getVehicleTz(env, vin)) ?? 0;
  const shift = tzMin * 60; // seconds to add before bucketing
  const monthExpr = (col: string) => `strftime('%Y-%m', ${col} + ${shift}, 'unixepoch')`;

  const drives = await env.DB.prepare(
    `SELECT ${monthExpr("start_ts")} AS month,
            COUNT(*) AS drives, SUM(distance_km) AS distance_km,
            SUM(energy_used_kwh) AS energy_kwh,
            SUM(efficiency_wh_km * distance_km) / NULLIF(SUM(CASE WHEN efficiency_wh_km IS NOT NULL THEN distance_km END), 0) AS avg_wh_km
     FROM drives WHERE vin = ?1 AND status = 'complete'
     GROUP BY month ORDER BY month DESC LIMIT ?2`,
  )
    .bind(vin, months)
    .all<{ month: string; drives: number; distance_km: number | null; energy_kwh: number | null; avg_wh_km: number | null }>();

  const charges = await env.DB.prepare(
    `SELECT ${monthExpr("start_ts")} AS month,
            COUNT(*) AS sessions, SUM(energy_added_kwh) AS kwh,
            SUM(CASE WHEN charge_type = 'AC' THEN energy_added_kwh ELSE 0 END) AS ac_kwh,
            SUM(CASE WHEN charge_type = 'DC' THEN energy_added_kwh ELSE 0 END) AS dc_kwh,
            SUM(cost) AS cost, MAX(currency) AS currency
     FROM charge_sessions WHERE vin = ?1 AND status = 'complete'
     GROUP BY month ORDER BY month DESC LIMIT ?2`,
  )
    .bind(vin, months)
    .all<{ month: string; sessions: number; kwh: number | null; ac_kwh: number | null; dc_kwh: number | null; cost: number | null; currency: string | null }>();

  const byMonth = new Map<string, Record<string, unknown>>();
  for (const d of drives.results ?? []) {
    byMonth.set(d.month, {
      month: d.month,
      drives: d.drives,
      distance_km: round(d.distance_km ?? 0, 1),
      drive_energy_kwh: round(d.energy_kwh ?? 0, 1),
      avg_wh_km: d.avg_wh_km != null ? round(d.avg_wh_km, 0) : null,
      charge_sessions: 0, charge_kwh: 0, ac_kwh: 0, dc_kwh: 0, charge_cost: 0, currency: null,
      cost_per_100km: null,
    });
  }
  for (const c of charges.results ?? []) {
    const row = byMonth.get(c.month) ?? {
      month: c.month, drives: 0, distance_km: 0, drive_energy_kwh: 0, avg_wh_km: null,
      charge_sessions: 0, charge_kwh: 0, ac_kwh: 0, dc_kwh: 0, charge_cost: 0, currency: null, cost_per_100km: null,
    };
    row.charge_sessions = c.sessions;
    row.charge_kwh = round(c.kwh ?? 0, 1);
    row.ac_kwh = round(c.ac_kwh ?? 0, 1);
    row.dc_kwh = round(c.dc_kwh ?? 0, 1);
    row.charge_cost = round(c.cost ?? 0, 2);
    row.currency = c.currency;
    const dist = Number(row.distance_km);
    row.cost_per_100km = dist > 10 && c.cost != null ? round((c.cost / dist) * 100, 2) : null;
    byMonth.set(c.month, row);
  }

  const out = [...byMonth.values()].sort((a, b) => String(b.month).localeCompare(String(a.month))).slice(0, months);
  return { vin, months: out };
}

// ---------------------------------------------------------------------------
// Derived: suggested locations (repeat-visited unnamed spots)
// ---------------------------------------------------------------------------

/**
 * Clusters drive endpoints on a ~110 m grid, keeps clusters with ≥3 visits
 * that are NOT inside an existing named location, and labels them from the
 * geocode cache. Surfaces the "you park here all the time — name it?" list
 * that makes per-location stats useful without manual setup.
 */
export async function getSuggestedLocations(env: Env, vin: string): Promise<unknown> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT ROUND(lat, 3) AS lat_r, ROUND(lon, 3) AS lon_r, COUNT(*) AS visits
     FROM (
       SELECT start_lat AS lat, start_lon AS lon FROM drives WHERE vin = ?1 AND status = 'complete' AND start_lat IS NOT NULL
       UNION ALL
       SELECT end_lat, end_lon FROM drives WHERE vin = ?1 AND status = 'complete' AND end_lat IS NOT NULL
     )
     GROUP BY lat_r, lon_r HAVING visits >= 3 ORDER BY visits DESC LIMIT 25`,
  )
    .bind(vin)
    .all<{ lat_r: number; lon_r: number; visits: number }>();

  const locations = await env.DB.prepare(`SELECT lat, lon, radius_m FROM locations`).all<{
    lat: number; lon: number; radius_m: number;
  }>();

  const suggestions: { lat: number; lon: number; visits: number; label: string | null }[] = [];
  for (const c of rs.results ?? []) {
    const insideNamed = (locations.results ?? []).some(
      (l) => haversineMeters(c.lat_r, c.lon_r, l.lat, l.lon) <= l.radius_m,
    );
    if (insideNamed) continue;
    const cached = await env.DB.prepare(
      `SELECT label FROM geocode_cache WHERE lat_r = ?1 AND lon_r = ?2 AND label != ''`,
    )
      .bind(c.lat_r, c.lon_r)
      .first<{ label: string }>();
    suggestions.push({ lat: c.lat_r, lon: c.lon_r, visits: c.visits, label: cached?.label ?? null });
    if (suggestions.length >= 10) break;
  }
  return { vin, suggestions };
}

// ---------------------------------------------------------------------------
// Driver auto-suggestion
// ---------------------------------------------------------------------------

/**
 * Suggests a driver for a just-closed drive from tagged history: drives that
 * started in the same geofence (or ~1 km grid cell) in the same hour-of-week
 * bucket (weekday/weekend × 3-hour block). The most frequent tagged driver
 * with ≥2 supporting drives wins. Stored in suggested_driver — the UI shows
 * it as a one-tap confirmation, never silently promotes it to `driver`.
 */
export async function suggestDriverForDrive(env: Env, driveId: number, vin: string): Promise<void> {
  const d = await env.DB.prepare(
    `SELECT start_ts, start_lat, start_lon, start_location_id, driver FROM drives WHERE id = ?1`,
  )
    .bind(driveId)
    .first<{ start_ts: number; start_lat: number | null; start_lon: number | null; start_location_id: number | null; driver: string | null }>();
  if (!d || d.driver) return; // already tagged — nothing to suggest

  const tzMin = (await getVehicleTz(env, vin)) ?? 0;
  const bucketOf = (ts: number): string => {
    const local = new Date((ts + tzMin * 60) * 1000);
    const dow = local.getUTCDay();
    const weekend = dow === 5 || dow === 6; // Israeli weekend (Fri/Sat)
    return `${weekend ? "we" : "wd"}:${Math.floor(local.getUTCHours() / 3)}`;
  };
  const targetBucket = bucketOf(d.start_ts);

  const candidates = await env.DB.prepare(
    `SELECT driver, start_ts, start_lat, start_lon, start_location_id FROM drives
     WHERE vin = ?1 AND status = 'complete' AND driver IS NOT NULL AND id != ?2
     ORDER BY start_ts DESC LIMIT 500`,
  )
    .bind(vin, driveId)
    .all<{ driver: string; start_ts: number; start_lat: number | null; start_lon: number | null; start_location_id: number | null }>();

  const votes = new Map<string, number>();
  for (const c of candidates.results ?? []) {
    const samePlace =
      (d.start_location_id != null && c.start_location_id === d.start_location_id) ||
      (d.start_lat != null && d.start_lon != null && c.start_lat != null && c.start_lon != null &&
        haversineMeters(d.start_lat, d.start_lon, c.start_lat, c.start_lon) <= 1000);
    if (!samePlace) continue;
    if (bucketOf(c.start_ts) !== targetBucket) continue;
    votes.set(c.driver, (votes.get(c.driver) ?? 0) + 1);
  }
  let best: { driver: string; n: number } | null = null;
  for (const [driver, n] of votes) if (!best || n > best.n) best = { driver, n };
  if (best && best.n >= 2) {
    await env.DB.prepare(`UPDATE drives SET suggested_driver = ?2 WHERE id = ?1`).bind(driveId, best.driver).run();
  }
}

// ---------------------------------------------------------------------------
// Stale-session auto-close (cron)
// ---------------------------------------------------------------------------

/**
 * Closes drives/charges left open by a mid-session signal loss (tunnel,
 * poller outage, car offline). Without this, the next unrelated sample days
 * later becomes the "end", producing a bogus multi-day drive that poisons
 * every aggregate. Runs from the cron tick; closes any open session whose
 * newest attached sample is older than the cutoff, ending it AT that sample.
 */
export async function closeStaleSessions(env: Env, maxAgeS = 6 * 3600): Promise<Record<string, number>> {
  await ensureSchema(env);
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeS;
  let closedDrives = 0;
  let closedCharges = 0;

  const staleDrives = await env.DB.prepare(
    `SELECT d.id, d.vin, d.start_ts, d.start_odometer,
            (SELECT MAX(ts) FROM positions p WHERE p.drive_id = d.id) AS last_ts
     FROM drives d WHERE d.status = 'active'`,
  ).all<{ id: number; vin: string; start_ts: number; start_odometer: number | null; last_ts: number | null }>();
  for (const d of staleDrives.results ?? []) {
    const lastTs = d.last_ts ?? d.start_ts;
    if (lastTs >= cutoff) continue;
    const lastPos = await env.DB.prepare(
      `SELECT * FROM positions WHERE drive_id = ?1 ORDER BY ts DESC LIMIT 1`,
    ).bind(d.id).first<Record<string, unknown>>();
    // Synthesize an end-state from the last known sample and close normally.
    const pseudo: LatestState = {
      vin: d.vin, updated_at: lastTs,
      lat: lastPos?.lat, lon: lastPos?.lon, odometer: lastPos?.odometer,
      soc: lastPos?.soc, rated_range: lastPos?.rated_range, ideal_range: lastPos?.ideal_range,
      energy_remaining: lastPos?.energy_remaining,
    };
    await closeDrive(env, { id: d.id, vin: d.vin, start_ts: d.start_ts, start_odometer: d.start_odometer }, pseudo, lastTs);
    closedDrives++;
  }

  const staleCharges = await env.DB.prepare(
    `SELECT cs.id, cs.vin, cs.price_cents_kwh, cs.location_id, cs.max_charger_power, cs.start_soc,
            (SELECT MAX(ts) FROM charges c WHERE c.session_id = cs.id) AS last_ts, cs.start_ts
     FROM charge_sessions cs WHERE cs.end_ts IS NULL AND cs.status = 'active'`,
  ).all<{ id: number; vin: string; price_cents_kwh: number | null; location_id: number | null; max_charger_power: number | null; start_soc: number | null; last_ts: number | null; start_ts: number }>();
  for (const c of staleCharges.results ?? []) {
    const lastTs = c.last_ts ?? c.start_ts;
    if (lastTs >= cutoff) continue;
    const lastCurve = await env.DB.prepare(
      `SELECT * FROM charges WHERE session_id = ?1 ORDER BY ts DESC LIMIT 1`,
    ).bind(c.id).first<Record<string, unknown>>();
    const pseudo: LatestState = {
      vin: c.vin, updated_at: lastTs,
      soc: lastCurve?.soc, rated_range: lastCurve?.rated_range,
      charge_energy_added: lastCurve?.charge_energy_added,
    };
    await closeChargeSession(
      env,
      { id: c.id, price_cents_kwh: c.price_cents_kwh, location_id: c.location_id, max_charger_power: c.max_charger_power, start_soc: c.start_soc },
      pseudo,
      lastTs,
    );
    closedCharges++;
  }

  return { closed_drives: closedDrives, closed_charges: closedCharges };
}

// ---------------------------------------------------------------------------
// Self-calibrated per-vehicle constants (KV)
// ---------------------------------------------------------------------------

async function getPackKwh(env: Env, vin: string): Promise<number | null> {
  const v = await env.TESLA_KV.get(`pack_kwh:${vin}`);
  return v ? Number(v) : null;
}

async function setPackKwh(env: Env, vin: string, kwh: number): Promise<void> {
  if (!Number.isFinite(kwh) || kwh <= 0 || kwh > 200) return;
  const prev = await getPackKwh(env, vin);
  // Exponential moving average smooths out per-session noise.
  const next = prev !== null ? prev * 0.7 + kwh * 0.3 : kwh;
  await env.TESLA_KV.put(`pack_kwh:${vin}`, String(round(next, 3)));
}

async function getRatedWhPerKm(env: Env, vin: string): Promise<number | null> {
  const v = await env.TESLA_KV.get(`rated_wh_km:${vin}`);
  return v ? Number(v) : 150; // sane default for a Model 3/Y if never calibrated
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
