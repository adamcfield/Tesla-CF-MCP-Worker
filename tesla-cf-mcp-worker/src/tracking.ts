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

import {
  ensureSchema,
  haversineMeters,
  insertPosition,
  LatestState,
  num,
  PositionSample,
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

  await env.DB.prepare(
    `UPDATE drives SET
       end_ts = ?2, status = 'complete', end_lat = ?3, end_lon = ?4, end_location_id = ?5,
       end_odometer = ?6, distance_km = ?7, end_soc = ?8, end_rated_range = ?9,
       end_ideal_range = ?10, duration_min = ?11, energy_used_kwh = ?12, efficiency_wh_km = ?13,
       avg_speed = ?14, max_speed = ?15, avg_power = ?16, max_power = ?17,
       outside_temp_avg = ?18, sample_count = ?19
     WHERE id = ?1`,
  )
    .bind(
      drive.id, ts, lat, lon, endLocId, endOdo, distanceKm, num(s.soc), num(s.rated_range),
      num(s.ideal_range), durationMin, energyUsed, efficiency, avgSpeed, num(agg?.max_speed),
      num(agg?.avg_power), num(agg?.max_power), num(agg?.outside_temp_avg), agg?.n ?? 0,
    )
    .run();
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
 * usable pack kWh. Reported as a time series plus first/latest deltas.
 */
export async function getBatteryDegradation(env: Env, vin: string): Promise<unknown> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT end_ts AS ts, end_soc, end_rated_range, end_ideal_range
     FROM charge_sessions
     WHERE vin = ?1 AND status = 'complete' AND end_soc IS NOT NULL AND end_soc > 50
       AND end_rated_range IS NOT NULL AND end_rated_range > 0
     ORDER BY end_ts ASC`,
  )
    .bind(vin)
    .all<{ ts: number; end_soc: number; end_rated_range: number; end_ideal_range: number | null }>();

  const pack = await getPackKwh(env, vin);
  // Per point, projected range at 100% is the real degradation signal (it moves
  // as the pack ages). Capacity is reported once at the top level — it would be
  // flat and misleading per-point since pack kWh is a single current estimate.
  const series = (rs.results ?? []).map((r) => ({
    ts: r.ts,
    projected_range_100_km: round((r.end_rated_range / r.end_soc) * 100, 1),
    at_soc: r.end_soc,
  }));

  if (series.length < 2) {
    return { series, note: "Need at least two charges above 50% to estimate degradation.", pack_kwh: pack };
  }
  const first = series[0]!;
  const last = series[series.length - 1]!;
  const lossPct = round((1 - last.projected_range_100_km / first.projected_range_100_km) * 100, 2);
  return {
    series,
    first_projected_range_100_km: first.projected_range_100_km,
    latest_projected_range_100_km: last.projected_range_100_km,
    degradation_pct: lossPct,
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

  const rows = rs.results ?? [];
  const MIN_GAP_S = 30 * 60; // 30 min
  const MAX_GAP_S = 3 * 86400; // ignore multi-day telemetry outages
  const spans: { start_ts: number; end_ts: number; hours: number; soc_lost: number; pct_per_day: number }[] = [];
  let totalLoss = 0;
  let totalHours = 0;

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
    totalLoss += loss;
    totalHours += hours;
    spans.push({ start_ts: a.ts, end_ts: b.ts, hours: round(hours, 2), soc_lost: round(loss, 2), pct_per_day: round((loss / hours) * 24, 3) });
  }

  return {
    days,
    idle_spans: spans.length,
    total_soc_lost_pct: round(totalLoss, 2),
    total_idle_hours: round(totalHours, 1),
    avg_pct_per_day: totalHours > 0 ? round((totalLoss / totalHours) * 24, 3) : null,
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
  };
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
