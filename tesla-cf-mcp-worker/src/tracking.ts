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

import { getChargingHistory, getVehicleDrivers } from "./api";
import { getBudgetForecast, getBudgetStatus } from "./budget";
import { signDriveCertificate } from "./certificate";
import { reverseGeocode } from "./geocode";
import { postedLimitsForSamples } from "./roadlimits";
import { scoreDrive } from "./scoring";
import {
  ensureSchema,
  getLatest,
  haversineMeters,
  insertPosition,
  LatestState,
  num,
  POSITION_COLUMNS,
  PositionSample,
  tzOffsetMinutes,
} from "./store";
import { Env } from "./types";

const CHARGING = new Set(["Charging", "Starting"]);
/** A drive that moves less than this / lasts less than this is discarded as noise. */
const MIN_DRIVE_KM = 0.05;
const MIN_DRIVE_SECONDS = 60;
/** Odometer jump (km) between two parked polls that we treat as a missed drive. */
const MIN_DRIVE_KM_SYNTH = 0.5;
/**
 * Above this jump, or spanning a longer gap, the odometer delta is an OFFLINE
 * GAP (dead 12V, long parking, a loaner, a multi-day outage) that almost
 * certainly contains many real drives — synthesizing one "drive" over it would
 * be a bogus mega-drive, so we leave it unrecovered instead.
 */
const MAX_DRIVE_KM_SYNTH = 500;
const MAX_GAP_S_SYNTH = 24 * 3600;
/** Floor speed for a synthetic drive's inferred duration (the poll gap is only
 *  an upper bound on WHEN it happened, not how long it took). */
const SYNTH_FLOOR_KMH = 20;

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
 *
 * `moving` alone (no gear check) decides "driving": Gear/ShiftState and
 * VehicleSpeed stream independently and at different intervals, so `s.gear`
 * in the merged state can be a STALE "P" carried over from before the car set
 * off, persisting through an entire drive if Gear itself doesn't get
 * re-reported. That previously suppressed the moving check (`gear !== "P"`)
 * and produced real multi-minute, real-speed drives (seen live: sustained
 * 60-90 km/h for 4+ minutes) misclassified as "idle" for their whole
 * duration. Speed is the one field that was reliably fresh throughout that
 * drive, so it alone is trusted here.
 */
export function deriveActivity(s: LatestState): Activity {
  const gear = normalizeGear(s.gear);
  const speed = num(s.speed);
  const moving = speed !== null && speed > 1;
  if (gear === "D" || gear === "R") return "driving";
  if (moving) return "driving";
  const cs = String(s.charging_state ?? "");
  if (CHARGING.has(cs)) return "charging";
  return "idle";
}

// SoftwareUpdateInstallationPercentComplete is an on-change field: Tesla sends
// it while an update is actively installing, then simply stops — there is no
// reliable terminal 0/100 packet. mergeLatest's merge-forever semantics mean
// a single "1%" sample would otherwise read as "still updating" indefinitely
// (observed live 2026-07-12: one real sample at 22:26 the night before kept
// fragmenting the whole next day's idle time into false "Software update"
// timeline entries). Treat it as stale — and therefore not updating — once
// it's older than a real OTA install ever takes.
const UPDATE_STALE_S = 90 * 60;

// "power" (drive_state.power) has no Fleet Telemetry streaming equivalent —
// it can only be refreshed by a billed REST poll (see power_ts in ingest.ts),
// which telemetry-first now throttles to ~hourly whenever streaming is
// healthy. Without a staleness check, mergeLatest's merge-forever semantics
// would smear that one hourly snapshot across every streaming-driven position
// sample taken in between (observed live 2026-07-13: a whole day of drives
// stuck at the single negative/zero reading from the last reconciliation
// poll). Treat it as unknown once it's older than the normal poll cadence.
const POWER_STALE_S = 5 * 60;

/** Maps activity (plus a possible software update) to a state-timeline label. */
function timelineState(s: LatestState, activity: Activity, ts: number): string {
  if (activity === "driving") return "driving";
  if (activity === "charging") return "charging";
  const pct = num(s.software_update_pct);
  const seenTs = num(s.software_update_pct_ts);
  const fresh = seenTs !== null && ts - seenTs < UPDATE_STALE_S;
  if (pct !== null && pct > 0 && pct < 100 && fresh) return "updating";
  return "online";
}

/** Builds the structured positions sample from merged canonical state. */
function buildSample(s: LatestState, activity: Activity, ts: number): PositionSample {
  const powerTs = num(s.power_ts);
  const powerFresh = powerTs !== null && ts - powerTs < POWER_STALE_S;
  return {
    activity,
    lat: num(s.lat),
    lon: num(s.lon),
    elevation: num(s.elevation),
    heading: num(s.heading),
    speed: num(s.speed),
    power: powerFresh ? num(s.power) : null,
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
    lon_accel: num(s.lon_accel),
    lat_accel: num(s.lat_accel),
    brake_pedal: num(s.brake_pedal),
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

  // 0. Odometer-jump recovery. Free-cron polling only watches the car ~5 min
  //    per run and GitHub throttles the schedule to ~hourly, so most drives
  //    happen entirely between polls and are never seen as a "driving" state.
  //    If the odometer advanced meaningfully since the last sample while parked
  //    (no open drive), synthesize the drive from the odometer delta so it
  //    isn't lost — distance/endpoints/energy are real; only the GPS route is
  //    missing. (Fleet Telemetry streaming eliminates the gap entirely.)
  if (previous && activity !== "driving") {
    const prevOdo = num(previous.odometer);
    const curOdo = num(current.odometer);
    const jumpKm = prevOdo !== null && curOdo !== null ? curOdo - prevOdo : 0;
    const openNow = await getOpenDrive(env, vin);
    // Implied-speed sanity: the gap bounds how long the jump can have taken,
    // so a jump that would need >160 km/h SUSTAINED for the whole gap is a
    // corrupt odometer reading (unit glitch, partial write), not a drive --
    // synthesizing it would fabricate a permanent long-distance drive row.
    const gapH = (ts - previous.updated_at) / 3600;
    const impliedKmh = gapH > 0 ? jumpKm / gapH : Infinity;
    if (
      !openNow &&
      jumpKm >= MIN_DRIVE_KM_SYNTH && jumpKm <= MAX_DRIVE_KM_SYNTH &&
      impliedKmh <= 160 &&
      ts > previous.updated_at && ts - previous.updated_at <= MAX_GAP_S_SYNTH
    ) {
      await synthesizeDrive(env, vin, previous, current, ts, jumpKm).catch(() => {});
    }
  }

  // 1. Drives — open/close BEFORE inserting the position so it can be tagged.
  let openDrive = await getOpenDrive(env, vin);
  if (openDrive && activity !== "driving") {
    await closeDrive(env, openDrive, current, ts);
    openDrive = null;
  } else if (!openDrive && activity === "driving") {
    openDrive = await openDrive_(env, vin, ts, current);
  }

  // 2. Position sample (tagged to the open drive, if any).
  const sample = buildSample(current, activity, ts);
  sample.drive_id = openDrive?.id ?? null;
  await insertPosition(env, vin, ts, sample);

  // 3. State timeline.
  await updateStateTimeline(env, vin, timelineState(current, activity, ts), ts, "ingest");

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
  try {
    const res = await env.DB.prepare(
      `INSERT INTO drives (
         vin, start_ts, status, start_lat, start_lon, start_location_id,
         start_odometer, start_soc, start_rated_range, start_ideal_range, start_outside_temp,
         fp_temp_set, fp_seat_heater
       ) VALUES (?1,?2,'active',?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
    )
      .bind(
        vin, ts, lat, lon, locId, num(s.odometer), num(s.soc), num(s.rated_range), num(s.ideal_range), num(s.outside_temp),
        num(s.cabin_temp_set), num(s.seat_heater_l),
      )
      .run();
    const id = Number(res.meta.last_row_id ?? 0);
    return { id, vin, start_ts: ts, start_odometer: num(s.odometer) };
  } catch (e) {
    // idx_drives_one_active fired: a concurrent invocation (REST poll vs
    // telemetry ingest) opened a drive between our check and this insert —
    // reuse that row instead of duplicating the drive.
    const existing = await getOpenDrive(env, vin);
    if (existing) return existing;
    throw e;
  }
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

  // Driving-behaviour metrics from the drive's samples — real IMU (lon/lat
  // accel) when the telemetry stream provided it, else the Δv/Δt proxy.
  const samplesRs = await env.DB.prepare(
    `SELECT ts, speed, heading, lat, lon, lon_accel, lat_accel
     FROM positions WHERE drive_id = ?1 ORDER BY ts ASC`,
  )
    .bind(drive.id)
    .all<{ ts: number; speed: number | null; heading: number | null; lat: number | null; lon: number | null; lon_accel: number | null; lat_accel: number | null }>();
  const behaviorSamples = samplesRs.results ?? [];
  const tzOffsetMin = (await getVehicleTz(env, drive.vin)) ?? 0;
  // Posted speed limits per sample (OSM maxspeed, cached) — best-effort.
  const posted = await postedLimitsForSamples(env, behaviorSamples).catch(() => ({ limits: [], source: "none" as const }));
  const behavior = scoreDrive(behaviorSamples, {
    distanceKm, tzOffsetMin,
    postedLimits: posted.limits, speedLimitSource: posted.source,
  });

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
       start_address = ?28, end_address = ?29, max_jerk_ms3 = ?30,
       over_limit_severity = ?31, speed_limit_source = ?32, score_low = ?33, score_high = ?34,
       score_confidence = ?35, accel_source = ?36
     WHERE id = ?1`,
  )
    .bind(
      drive.id, ts, lat, lon, endLocId, endOdo, distanceKm, num(s.soc), num(s.rated_range),
      num(s.ideal_range), durationMin, energyUsed, efficiency, avgSpeed, num(agg?.max_speed),
      num(agg?.avg_power), num(agg?.max_power), num(agg?.outside_temp_avg), agg?.n ?? 0,
      behavior.max_accel_ms2, behavior.max_decel_ms2, behavior.harsh_accel_count, behavior.harsh_brake_count,
      behavior.harsh_turn_count, behavior.over_limit_frac, behavior.night_frac, behavior.behavior_score,
      startAddr, endAddr, behavior.max_jerk_ms3,
      behavior.over_limit_severity, behavior.speed_limit_source, behavior.score_low, behavior.score_high,
      behavior.score_confidence, behavior.accel_source,
    )
    .run();

  // Auto-suggest a driver from historically-tagged drives with the same start
  // context (geofence/grid + hour-of-week bucket). Best-effort; never blocks.
  await suggestDriverForDrive(env, drive.id, drive.vin).catch(() => {});
}

/**
 * Inserts a COMPLETE drive recovered from an odometer jump between two parked
 * polls (a drive that happened entirely within a poll gap). Distance, energy,
 * SoC delta and endpoints are real; there is no GPS route and no behaviour
 * score (no per-second samples exist), and it's flagged synthetic=1. Endpoints
 * are geofence-matched + reverse-geocoded like a normal drive.
 */
async function synthesizeDrive(
  env: Env,
  vin: string,
  previous: LatestState,
  current: LatestState,
  ts: number,
  distanceKm: number,
): Promise<void> {
  const startTs = previous.updated_at;
  const startLat = num(previous.lat);
  const startLon = num(previous.lon);
  const endLat = num(current.lat);
  const endLon = num(current.lon);
  const startOdo = num(previous.odometer);
  const endOdo = num(current.odometer);
  // The poll gap is an upper bound on WHEN the drive happened, not its length.
  // Cap the inferred duration to a plausible floor speed so a short jump after
  // a long poll gap isn't stored as a multi-day crawl at ~0 km/h.
  const maxSynthMin = (distanceKm / SYNTH_FLOOR_KMH) * 60;
  const durationMin = Math.min(Math.max(1, (ts - startTs) / 60), Math.max(1, maxSynthMin));

  // Energy: prefer EnergyRemaining delta, else SoC delta × pack.
  let energyUsed: number | null = null;
  const startEr = num(previous.energy_remaining);
  const endEr = num(current.energy_remaining);
  if (startEr !== null && endEr !== null && startEr - endEr > 0) energyUsed = startEr - endEr;
  else {
    const startSoc = num(previous.soc);
    const endSoc = num(current.soc);
    const pack = await getPackKwh(env, vin);
    if (startSoc !== null && endSoc !== null && pack !== null && startSoc - endSoc > 0) {
      energyUsed = ((startSoc - endSoc) / 100) * pack;
    }
  }
  const efficiency = energyUsed !== null && distanceKm > 0.1 ? (energyUsed * 1000) / distanceKm : null;
  const avgSpeed = durationMin > 0 ? distanceKm / (durationMin / 60) : null;

  const startLoc = startLat !== null && startLon !== null ? await matchLocation(env, startLat, startLon) : null;
  const endLoc = endLat !== null && endLon !== null ? await matchLocation(env, endLat, endLon) : null;
  const startAddr = startLat !== null && startLon !== null ? await reverseGeocode(env, startLat, startLon) : null;
  const endAddr = endLat !== null && endLon !== null ? await reverseGeocode(env, endLat, endLon) : null;

  const res = await env.DB.prepare(
    `INSERT INTO drives (
       vin, start_ts, end_ts, status, synthetic,
       start_lat, start_lon, end_lat, end_lon, start_location_id, end_location_id,
       start_odometer, end_odometer, distance_km, duration_min,
       start_soc, end_soc, start_rated_range, end_rated_range,
       energy_used_kwh, efficiency_wh_km, avg_speed, sample_count,
       start_address, end_address, outside_temp_avg
     ) VALUES (?1,?2,?3,'complete',1,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,0,?21,?22,?23)`,
  )
    .bind(
      vin, startTs, ts, startLat, startLon, endLat, endLon, startLoc, endLoc,
      startOdo, endOdo, round(distanceKm, 2), round(durationMin, 1),
      num(previous.soc), num(current.soc), num(previous.rated_range), num(current.rated_range),
      energyUsed !== null ? round(energyUsed, 3) : null, efficiency !== null ? round(efficiency, 1) : null,
      avgSpeed !== null ? round(avgSpeed, 1) : null, startAddr, endAddr, num(current.outside_temp),
    )
    .run();
  const newId = Number(res.meta.last_row_id ?? 0);
  if (newId) await suggestDriverForDrive(env, newId, vin).catch(() => {});
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
  // A negative estimate means the readings disagree (a stale start sample, a
  // mid-drive top-up, BMS recalibration) -- store "unknown", not a physically
  // impossible negative consumption that poisons every efficiency aggregate.
  const clamp = (kwh: number) => (kwh < 0 ? null : kwh);

  const startEr = startPos?.energy_remaining ?? null;
  const endEr = num(end.energy_remaining);
  if (startEr !== null && endEr !== null) return clamp(startEr - endEr);

  const startSoc = startPos?.soc ?? null;
  const endSoc = num(end.soc);
  const pack = await getPackKwh(env, vin);
  if (startSoc !== null && endSoc !== null && pack !== null) return clamp(((startSoc - endSoc) / 100) * pack);

  const startRr = startPos?.rated_range ?? null;
  const endRr = num(end.rated_range);
  const whPerKm = await getRatedWhPerKm(env, vin);
  if (startRr !== null && endRr !== null && whPerKm !== null) return clamp(((startRr - endRr) * whPerKm) / 1000);

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
  try {
    await env.DB.prepare(
      `INSERT INTO vehicle_states (vin, state, start_ts, source) VALUES (?1,?2,?3,?4)`,
    )
      .bind(vin, state, ts, source)
      .run();
  } catch (e) {
    // idx_vehicle_states_one_open fired: a concurrent invocation (cron
    // connectivity check vs telemetry ingest) already opened a row for this
    // vin between our read above and this insert. That row already records
    // the state change (or a near-simultaneous one); inserting our own would
    // create a second open row that getOpenState's ORDER BY start_ts DESC
    // could permanently lose track of -- the exact mechanism behind a real
    // ~70h phantom "driving" entry (observed live 2026-07-08). Nothing to do:
    // defer to whichever row won the race.
    const stillOpen = await getOpenState(env, vin);
    if (!stillOpen) throw e;
  }
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
  try {
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
  } catch (e) {
    // idx_charges_one_active fired: a concurrent invocation (REST poll vs
    // telemetry ingest) opened a session between our check and this insert —
    // reuse that row so one physical charge never becomes two sessions.
    const existing = await getOpenChargeSession(env, vin);
    if (existing) return existing;
    throw e;
  }
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

  // Name the charge location — a live-derived session at "Unknown location"
  // otherwise. A matched geofence name wins in the UI; else reverse-geocode
  // the coordinates into site_name (the field the dashboard already displays).
  if (session.location_id == null) {
    const loc = await env.DB.prepare(`SELECT lat, lon, site_name FROM charge_sessions WHERE id = ?1`)
      .bind(session.id)
      .first<{ lat: number | null; lon: number | null; site_name: string | null }>();
    if (loc && !loc.site_name && loc.lat != null && loc.lon != null) {
      const addr = await reverseGeocode(env, loc.lat, loc.lon);
      if (addr) await env.DB.prepare(`UPDATE charge_sessions SET site_name = ?2 WHERE id = ?1`).bind(session.id, addr).run();
    }
  }

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
  drivers: string[]; // empty = untagged/shared (every pre-existing row)
}

/** Raw `locations.drivers` column (JSON array text, or null) → a clean string[]. */
function parseLocationDrivers(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string" && d.trim() !== "") : [];
  } catch {
    return [];
  }
}

/** string[] (or undefined/empty) → what gets stored in the `drivers` column — null means untagged/shared. */
function serializeLocationDrivers(drivers?: string[] | null): string | null {
  const cleaned = (drivers ?? []).map((d) => d.trim()).filter(Boolean);
  return cleaned.length ? JSON.stringify(cleaned) : null;
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
  const rs = await env.DB.prepare(`SELECT * FROM locations ORDER BY name`).all<LocationRow & { drivers: unknown; address?: string | null }>();
  const rows = (rs.results ?? []).map((r) => ({ ...r, drivers: parseLocationDrivers(r.drivers) }));

  // Lazily reverse-geocode places saved before the address column existed (or
  // whose lookup failed) — capped per call so one list request can't stall on
  // N geocodes; the 30d geocode cache makes repeats instant. Persisted so it
  // runs once per place, not once per page view.
  let filled = 0;
  for (const r of rows) {
    if (r.address || filled >= 3) continue;
    const addr = await reverseGeocode(env, r.lat, r.lon);
    if (addr) {
      await env.DB.prepare(`UPDATE locations SET address = ?2 WHERE id = ?1`).bind(r.id, addr).run();
      (r as { address?: string | null }).address = addr;
      filled++;
    }
  }

  // Per-place usage stats in ONE pass per table (visits = drives ending here).
  const [arr, dep, chg] = await Promise.all([
    env.DB.prepare(
      `SELECT end_location_id loc, COUNT(*) n, MAX(end_ts) last_ts FROM drives
       WHERE status = 'complete' AND end_location_id IS NOT NULL GROUP BY end_location_id`,
    ).all<{ loc: number; n: number; last_ts: number | null }>(),
    env.DB.prepare(
      `SELECT start_location_id loc, COUNT(*) n FROM drives
       WHERE status = 'complete' AND start_location_id IS NOT NULL GROUP BY start_location_id`,
    ).all<{ loc: number; n: number }>(),
    env.DB.prepare(
      `SELECT location_id loc, COUNT(*) n, COALESCE(SUM(energy_added_kwh),0) kwh,
              COALESCE(SUM(cost),0) cost, MAX(start_ts) last_ts
       FROM charge_sessions WHERE status = 'complete' AND location_id IS NOT NULL GROUP BY location_id`,
    ).all<{ loc: number; n: number; kwh: number; cost: number; last_ts: number | null }>(),
  ]);
  const arrBy = new Map((arr.results ?? []).map((x) => [x.loc, x]));
  const depBy = new Map((dep.results ?? []).map((x) => [x.loc, x]));
  const chgBy = new Map((chg.results ?? []).map((x) => [x.loc, x]));
  return rows.map((r) => {
    const a = arrBy.get(r.id), d = depBy.get(r.id), c = chgBy.get(r.id);
    return {
      ...r,
      visits: a?.n ?? 0,
      departures: d?.n ?? 0,
      charge_count: c?.n ?? 0,
      charge_kwh: round(c?.kwh ?? 0, 1),
      charge_cost: round(c?.cost ?? 0, 2),
      last_visit_ts: Math.max(a?.last_ts ?? 0, c?.last_ts ?? 0) || null,
    };
  });
}

export async function setLocation(
  env: Env,
  loc: { id?: number; name: string; lat: number; lon: number; radius_m?: number; cost_per_kwh?: number; drivers?: string[] | null; address?: string | null },
): Promise<{ id: number }> {
  await ensureSchema(env);
  if (loc.id !== undefined) {
    // `drivers` omitted (undefined) on an update means "leave tags as they
    // are" — e.g. renaming a location shouldn't silently wipe its driver
    // tags. Only an explicit array (including []) overwrites them.
    // `address` follows the same contract: undefined = keep, ""/null = clear
    // (a cleared address gets lazily re-geocoded by listLocations).
    const driversJson = loc.drivers !== undefined
      ? serializeLocationDrivers(loc.drivers)
      : (await env.DB.prepare(`SELECT drivers FROM locations WHERE id = ?1`).bind(loc.id).first<{ drivers: string | null }>())?.drivers ?? null;
    const address = loc.address !== undefined
      ? (loc.address?.trim() || null)
      : ((await env.DB.prepare(`SELECT address FROM locations WHERE id = ?1`).bind(loc.id).first<{ address: string | null }>())?.address ?? null);
    await env.DB.prepare(
      `UPDATE locations SET name=?2, lat=?3, lon=?4, radius_m=?5, cost_per_kwh=?6, drivers=?7, address=?8 WHERE id=?1`,
    )
      .bind(loc.id, loc.name, loc.lat, loc.lon, loc.radius_m ?? 150, loc.cost_per_kwh ?? null, driversJson, address)
      .run();
    // The place may have moved/resized — re-match history so its visit stats
    // and event history stay truthful (force recomputes existing matches too).
    await backfillLocationMatches(env, true);
    return { id: loc.id };
  }
  const driversJson = serializeLocationDrivers(loc.drivers);
  const res = await env.DB.prepare(
    `INSERT INTO locations (name, lat, lon, radius_m, cost_per_kwh, created_ts, drivers, address)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
  )
    .bind(loc.name, loc.lat, loc.lon, loc.radius_m ?? 150, loc.cost_per_kwh ?? null, Math.floor(Date.now() / 1000), driversJson, loc.address?.trim() || null)
    .run();
  // A brand-new place claims its history immediately (visits/charges that
  // happened here before it was saved).
  await backfillLocationMatches(env, false);
  return { id: Number(res.meta.last_row_id ?? 0) };
}

export async function deleteLocation(env: Env, id: number): Promise<{ deleted: boolean }> {
  await ensureSchema(env);
  const res = await env.DB.prepare(`DELETE FROM locations WHERE id = ?1`).bind(id).run();
  return { deleted: (res.meta.changes ?? 0) > 0 };
}

export async function getLocationStats(env: Env, id: number): Promise<unknown> {
  await ensureSchema(env);
  const loc = await env.DB.prepare(`SELECT * FROM locations WHERE id = ?1`).bind(id).first<{ drivers: unknown }>();
  if (!loc) return { error: "location not found" };
  const drivesFrom = await env.DB.prepare(`SELECT COUNT(*) n FROM drives WHERE start_location_id = ?1`).bind(id).first<{ n: number }>();
  const drivesTo = await env.DB.prepare(`SELECT COUNT(*) n FROM drives WHERE end_location_id = ?1`).bind(id).first<{ n: number }>();
  const charges = await env.DB.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(energy_added_kwh),0) kwh, COALESCE(SUM(cost),0) cost
     FROM charge_sessions WHERE location_id = ?1 AND status = 'complete'`,
  ).bind(id).first<{ n: number; kwh: number; cost: number }>();
  return {
    location: { ...loc, drivers: parseLocationDrivers(loc.drivers) },
    drives_from: drivesFrom?.n ?? 0,
    drives_to: drivesTo?.n ?? 0,
    charge_sessions: charges?.n ?? 0,
    total_energy_added_kwh: round(charges?.kwh ?? 0, 2),
    total_cost: round(charges?.cost ?? 0, 2),
  };
}

/**
 * (Re)matches historical drives and charge sessions to the saved places.
 * Live matching only happens as sessions open/close, so anything recorded
 * BEFORE a place was saved (or after it was moved/resized) sits unmatched
 * and the place shows zero visits. Runs with the locations preloaded — one
 * pass over ~all rows, only writing actual changes. `force` recomputes rows
 * that already have a location id (needed after moving/deleting a place).
 * Called from setLocation on every save, and exposed as
 * POST /setup/backfill-locations for a manual full pass.
 */
export async function backfillLocationMatches(env: Env, force = false): Promise<Record<string, number>> {
  await ensureSchema(env);
  const locs = (await env.DB.prepare(`SELECT id, lat, lon, radius_m FROM locations`).all<{
    id: number; lat: number; lon: number; radius_m: number;
  }>()).results ?? [];
  const match = (lat: number | null, lon: number | null): number | null => {
    if (lat == null || lon == null) return null;
    let best: { id: number; d: number } | null = null;
    for (const l of locs) {
      const d = haversineMeters(lat, lon, l.lat, l.lon);
      if (d <= l.radius_m && (best === null || d < best.d)) best = { id: l.id, d };
    }
    return best?.id ?? null;
  };

  let drivesChanged = 0;
  const drives = (await env.DB.prepare(
    `SELECT id, start_lat, start_lon, end_lat, end_lon, start_location_id, end_location_id
     FROM drives WHERE status = 'complete'`,
  ).all<{ id: number; start_lat: number | null; start_lon: number | null; end_lat: number | null; end_lon: number | null; start_location_id: number | null; end_location_id: number | null }>()).results ?? [];
  for (const d of drives) {
    const start = force || d.start_location_id == null ? match(d.start_lat, d.start_lon) : d.start_location_id;
    const end = force || d.end_location_id == null ? match(d.end_lat, d.end_lon) : d.end_location_id;
    if (start !== (d.start_location_id ?? null) || end !== (d.end_location_id ?? null)) {
      await env.DB.prepare(`UPDATE drives SET start_location_id = ?2, end_location_id = ?3 WHERE id = ?1`)
        .bind(d.id, start, end).run();
      drivesChanged++;
    }
  }

  let chargesChanged = 0;
  const charges = (await env.DB.prepare(
    `SELECT id, lat, lon, location_id FROM charge_sessions WHERE status = 'complete'`,
  ).all<{ id: number; lat: number | null; lon: number | null; location_id: number | null }>()).results ?? [];
  for (const c of charges) {
    const m = force || c.location_id == null ? match(c.lat, c.lon) : c.location_id;
    if (m !== (c.location_id ?? null)) {
      await env.DB.prepare(`UPDATE charge_sessions SET location_id = ?2 WHERE id = ?1`).bind(c.id, m).run();
      chargesChanged++;
    }
  }
  return { locations: locs.length, drives_examined: drives.length, drives_changed: drivesChanged, charges_examined: charges.length, charges_changed: chargesChanged };
}

/**
 * Everything that ever happened AT a saved place, newest first: arrivals
 * (drives ending here), departures (drives starting here) and charge sessions
 * — each row carries the drive/charge id so the dashboard can click through.
 */
export async function getLocationHistory(env: Env, id: number, limit = 200): Promise<unknown> {
  await ensureSchema(env);
  const loc = await env.DB.prepare(`SELECT id, name FROM locations WHERE id = ?1`).bind(id).first();
  if (!loc) return { error: "location not found" };
  const [arrivals, departures, charges] = await Promise.all([
    env.DB.prepare(
      `SELECT id, end_ts ts, start_address other_address, distance_km, driver, duration_min
       FROM drives WHERE end_location_id = ?1 AND status = 'complete' ORDER BY end_ts DESC LIMIT ?2`,
    ).bind(id, limit).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT id, start_ts ts, end_address other_address, distance_km, driver, duration_min
       FROM drives WHERE start_location_id = ?1 AND status = 'complete' ORDER BY start_ts DESC LIMIT ?2`,
    ).bind(id, limit).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT id, start_ts ts, end_ts, energy_added_kwh, start_soc, end_soc, cost, charge_type, duration_min
       FROM charge_sessions WHERE location_id = ?1 AND status = 'complete' ORDER BY start_ts DESC LIMIT ?2`,
    ).bind(id, limit).all<Record<string, unknown>>(),
  ]);
  const events: Array<Record<string, unknown>> = [
    ...(arrivals.results ?? []).map((r) => ({ ...r, kind: "arrival" })),
    ...(departures.results ?? []).map((r) => ({ ...r, kind: "departure" })),
    ...(charges.results ?? []).map((r) => ({ ...r, kind: "charge" })),
  ];
  const sorted = events
    .filter((e) => typeof e.ts === "number")
    .sort((a, b) => (b.ts as number) - (a.ts as number))
    .slice(0, limit);
  return { location: loc, events: sorted };
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

/**
 * Recovers drives that free-cron polling missed, from the odometer history in
 * `positions`. Scans consecutive parked samples (drive_id IS NULL) for an
 * odometer jump ≥ the threshold with no drive already covering that span, and
 * synthesizes a drive for each. Idempotent (the coverage check skips spans a
 * prior run already filled). This is how a Home→beach→Home trip that happened
 * between two hourly polls shows up after the fact.
 */
export async function backfillSyntheticDrives(env: Env, vin: string, limit = 100): Promise<Record<string, unknown>> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT ts, odometer, lat, lon, soc, rated_range, energy_remaining, outside_temp, drive_id
     FROM positions WHERE vin = ?1 AND odometer IS NOT NULL ORDER BY ts ASC`,
  )
    .bind(vin)
    .all<{ ts: number; odometer: number; lat: number | null; lon: number | null; soc: number | null; rated_range: number | null; energy_remaining: number | null; outside_temp: number | null; drive_id: number | null }>();
  const rows = rs.results ?? [];
  let created = 0;
  let examined = 0;
  for (let i = 1; i < rows.length && created < limit; i++) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    if (a.drive_id != null || b.drive_id != null) continue; // part of a real drive
    const jump = b.odometer - a.odometer;
    if (jump < MIN_DRIVE_KM_SYNTH || jump > MAX_DRIVE_KM_SYNTH) continue;
    if (b.ts - a.ts > MAX_GAP_S_SYNTH) continue; // offline gap, not one drive
    examined++;
    // Skip if a drive (real or already-synthesized) covers this span.
    const covered = await env.DB.prepare(
      `SELECT 1 FROM drives WHERE vin = ?1 AND status = 'complete' AND start_ts <= ?2 AND end_ts >= ?3 LIMIT 1`,
    ).bind(vin, a.ts, b.ts).first();
    if (covered) continue;
    const prev: LatestState = { vin, updated_at: a.ts, odometer: a.odometer, lat: a.lat, lon: a.lon, soc: a.soc, rated_range: a.rated_range, energy_remaining: a.energy_remaining };
    const cur: LatestState = { vin, updated_at: b.ts, odometer: b.odometer, lat: b.lat, lon: b.lon, soc: b.soc, rated_range: b.rated_range, energy_remaining: b.energy_remaining, outside_temp: b.outside_temp };
    await synthesizeDrive(env, vin, prev, cur, b.ts, jump).catch(() => {});
    created++;
  }
  return { vin, jumps_examined: examined, drives_recovered: created };
}

/** Reverse-geocodes derived charge sessions that show as "Unknown location". */
export async function backfillChargeAddresses(env: Env, vin: string, limit = 40): Promise<Record<string, unknown>> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT id, lat, lon FROM charge_sessions
     WHERE vin = ?1 AND status = 'complete' AND location_id IS NULL
       AND (site_name IS NULL OR site_name = '') AND lat IS NOT NULL AND lon IS NOT NULL
     ORDER BY start_ts DESC LIMIT ?2`,
  ).bind(vin, limit).all<{ id: number; lat: number; lon: number }>();
  let updated = 0;
  for (const c of rs.results ?? []) {
    const addr = await reverseGeocode(env, c.lat, c.lon);
    if (addr) {
      await env.DB.prepare(`UPDATE charge_sessions SET site_name = ?2 WHERE id = ?1`).bind(c.id, addr).run();
      updated++;
    }
  }
  return { vin, examined: (rs.results ?? []).length, updated };
}

/**
 * Assign (or clear, with driver=null) the driver of a drive. This is always a
 * HUMAN action (the dashboard's manual input/quick-assign, or the set_driver
 * MCP tool) — tagged driver_source='manual' so it's visually distinct from,
 * and always overrides, a system auto-assignment (see suggestDriverForDrive).
 */
export async function setDriveDriver(env: Env, id: number, driver: string | null): Promise<{ updated: boolean }> {
  await ensureSchema(env);
  const clean = driver && driver.trim() ? driver.trim() : null;
  const res = await env.DB.prepare(`UPDATE drives SET driver = ?2, driver_source = ?3 WHERE id = ?1`)
    .bind(id, clean, clean ? "manual" : null)
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
            SUM(CASE WHEN synthetic = 1 THEN 1 ELSE 0 END) AS synthetic_drives,
            COALESCE(SUM(distance_km), 0) AS km,
            -- Synthetic (odometer-recovered) drives have a fabricated poll-gap
            -- duration and no real speed, so exclude them from the time/speed
            -- aggregates; their distance still counts.
            COALESCE(SUM(CASE WHEN synthetic = 1 THEN 0 ELSE duration_min END), 0) AS minutes,
            MAX(max_speed) AS max_speed,
            AVG(CASE WHEN synthetic = 1 THEN NULL ELSE avg_speed END) AS avg_speed,
            MAX(max_decel_ms2) AS max_decel_ms2,
            COALESCE(SUM(harsh_brake_count), 0) AS harsh_brakes,
            COALESCE(SUM(harsh_accel_count), 0) AS harsh_accels,
            COALESCE(SUM(harsh_turn_count), 0) AS harsh_turns,
            AVG(over_limit_frac) AS over_limit_frac,
            AVG(night_frac) AS night_frac,
            SUM(behavior_score * COALESCE(distance_km, 0)) AS score_wsum,
            SUM(CASE WHEN behavior_score IS NOT NULL THEN COALESCE(distance_km, 0) ELSE 0 END) AS score_wden,
            SUM(score_low * COALESCE(distance_km, 0)) AS low_wsum,
            SUM(score_high * COALESCE(distance_km, 0)) AS high_wsum,
            AVG(over_limit_severity) AS over_limit_severity,
            SUM(CASE WHEN accel_source = 'imu' THEN 1 ELSE 0 END) AS imu_drives,
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
    const score = r.score_wden > 0 ? Math.round(r.score_wsum / r.score_wden) : null;
    const imu = (r.imu_drives || 0) > 0;
    // Confidence: real IMU ⇒ high; else from sampling density.
    const confidence = imu || samplesPerKm >= 6 ? "high" : samplesPerKm >= 2 ? "medium" : "low";
    return {
      driver: r.driver,
      drives: r.drives,
      synthetic_drives: r.synthetic_drives || 0, // recovered from odometer gaps (no route/speed)
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
      over_limit_severity_kmh: r.over_limit_severity != null ? round(r.over_limit_severity, 1) : null,
      night_pct: r.night_frac != null ? round(r.night_frac * 100, 1) : null,
      behavior_score: score,
      score_low: r.score_wden > 0 && r.low_wsum != null ? Math.round(r.low_wsum / r.score_wden) : score,
      score_high: r.score_wden > 0 && r.high_wsum != null ? Math.round(r.high_wsum / r.score_wden) : score,
      score_confidence: confidence,
      percentile: score != null ? scoreToPercentile(score) : null,
      accel_source: imu ? "imu" : "derived",
      fidelity: samplesPerKm >= 3 ? "good" : samplesPerKm >= 1 ? "coarse" : "sparse",
    };
  });

  return {
    vin,
    drivers,
    baseline: "Percentile is vs a reference safe-driving distribution (higher = safer than that % of drivers).",
    note: "Harsh events use REAL accelerometer data when Fleet Telemetry streaming is on (accel_source='imu', high confidence); otherwise they're derived from speed samples and under-report at coarse cadence (score_low shows the cadence-corrected worst case). Speed is scored against posted limits when available. Avg/max speed, night %, and mileage are reliable at any cadence.",
  };
}

/**
 * Maps a 0–100 behaviour score to a population percentile against a reference
 * safe-driving distribution (piecewise; a bare 82 becomes "76th percentile").
 * Values are a defensible stand-in until a real UBI reference set is licensed.
 */
export function scoreToPercentile(score: number): number {
  const table: Array<[number, number]> = [
    [100, 99], [95, 94], [90, 86], [85, 76], [80, 64], [75, 52], [70, 40], [65, 30], [60, 21], [50, 10], [40, 4], [0, 1],
  ];
  for (let i = 0; i < table.length - 1; i++) {
    const [s1, p1] = table[i]!;
    const [s2, p2] = table[i + 1]!;
    if (score >= s2) {
      const t = s1 === s2 ? 0 : (score - s2) / (s1 - s2);
      return Math.round(p2 + t * (p1 - p2));
    }
  }
  return 1;
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
  const d = drive as { vin: string; start_ts: number; end_ts: number | null };
  const media = d.end_ts != null ? await mediaTrackChanges(env, d.vin, d.start_ts, d.end_ts).catch(() => []) : [];
  return { drive, path: path.results ?? [], media };
}

/**
 * Household driver roster: the people the car is SHARED with (from Tesla's
 * drivers endpoint, by name + key-hash count) merged with anyone already
 * tagged on drives. Tesla exposes no active-driver-per-trip field, so this
 * seeds the manual/assisted tagging picker — it does not auto-attribute.
 */
export async function getDrivers(env: Env, vin: string): Promise<unknown> {
  await ensureSchema(env);
  // Cache the Tesla roster (5-min TTL): list_drivers is read-scope (any device
  // token can call it), so without this a tight loop would hammer the shared
  // Fleet API OAuth client and risk Tesla-side rate-limiting for every
  // integration. The tagged-drivers D1 merge below stays live (cheap, local).
  const CACHE_KEY = `drivers:${vin}`;
  let roster = await env.TESLA_KV.get<Awaited<ReturnType<typeof getVehicleDrivers>>>(CACHE_KEY, "json").catch(() => null);
  if (!roster) {
    roster = await getVehicleDrivers(env, vin);
    await env.TESLA_KV.put(CACHE_KEY, JSON.stringify(roster), { expirationTtl: 300 }).catch(() => {});
  }
  const taggedRs = await env.DB.prepare(
    `SELECT driver, COUNT(*) AS n FROM drives WHERE vin = ?1 AND driver IS NOT NULL AND status = 'complete' GROUP BY driver`,
  ).bind(vin).all<{ driver: string; n: number }>();
  const taggedCounts = new Map((taggedRs.results ?? []).map((r) => [r.driver.toLowerCase(), r.n]));

  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const d of roster) {
    const name = [d.driver_first_name, d.driver_last_name].filter(Boolean).join(" ").trim() || `Driver ${d.user_id ?? ""}`.trim();
    const key = name.toLowerCase();
    seen.add(key);
    out.push({
      name,
      first_name: d.driver_first_name ?? null,
      last_name: d.driver_last_name ?? null,
      user_id: d.user_id ?? null,
      granular_access: d.granular_access ?? null,
      pubkey_count: Array.isArray(d.active_pubkeys) ? d.active_pubkeys.length : 0,
      source: "tesla",
      drives_tagged: taggedCounts.get(key) ?? 0,
    });
  }
  // Tagged drivers not present in the Tesla roster (free-text names).
  for (const [key, n] of taggedCounts) {
    if (seen.has(key)) continue;
    const original = (taggedRs.results ?? []).find((r) => r.driver.toLowerCase() === key)?.driver ?? key;
    out.push({ name: original, source: "tagged", drives_tagged: n, pubkey_count: 0 });
  }
  return {
    vin,
    drivers: out,
    note: "Roster from Tesla's shared-driver list plus tagged names. Tesla can't report who drove a given trip, so drives are tagged manually/assisted.",
  };
}

/** Signs a tamper-evident risk certificate for one drive. */
export async function getDriveCertificate(env: Env, id: number, issuedTs: number): Promise<unknown> {
  await ensureSchema(env);
  const drive = await env.DB.prepare(`SELECT * FROM drives WHERE id = ?1`).bind(id).first<Record<string, unknown>>();
  if (!drive) return { error: "drive not found" };
  const path = await env.DB.prepare(
    `SELECT ts, lat, lon, speed FROM positions WHERE drive_id = ?1 ORDER BY ts ASC`,
  ).bind(id).all<Record<string, unknown>>();
  return signDriveCertificate(env, drive, path.results ?? [], issuedTs);
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

/** charging_state values that mean "plugged in" but not actively drawing power. */
const CONNECTED_NOT_CHARGING = new Set(["Complete", "Stopped", "NoPower"]);

/** Finer-grained than vehicle_states: splits "idle" into resting (unplugged) vs connected (plugged in, not charging). */
function batteryStage(activity: string | null, chargingState: string | null): string {
  if (activity === "driving") return "driving";
  if (activity === "charging") return "charging";
  return chargingState != null && CONNECTED_NOT_CHARGING.has(chargingState) ? "connected" : "resting";
}

/**
 * SoC over time with a driving/charging/resting/connected-not-charging stage per
 * sample, for a stock-chart-style timeline (issue: click-through from Overview's
 * charge-level widget). Built from `positions` (already-derived activity +
 * charging_state), not from vehicle_states, since vehicle_states only tracks
 * driving/charging/online/asleep/updating — it has no "plugged in but idle" state.
 *
 * Points are downsampled evenly to <=2000 (same approach as getTirePressures) so
 * a 30-day window stays payload-sane; segments are computed from the FULL,
 * unsampled series first so short stage changes between kept points aren't lost.
 */
export async function getBatteryTimeline(env: Env, vin: string, hours = 24): Promise<unknown> {
  await ensureSchema(env);
  const since = Math.floor(Date.now() / 1000) - Math.round(hours * 3600);
  const rs = await env.DB.prepare(
    `SELECT ts, soc, activity, charging_state FROM positions
     WHERE vin = ?1 AND ts >= ?2 AND soc IS NOT NULL ORDER BY ts ASC`,
  )
    .bind(vin, since)
    .all<{ ts: number; soc: number; activity: string | null; charging_state: string | null }>();
  const rows = rs.results ?? [];

  const segments: { stage: string; start_ts: number; end_ts: number }[] = [];
  const stageSeconds: Record<string, number> = { driving: 0, charging: 0, resting: 0, connected: 0 };
  for (const r of rows) {
    const stage = batteryStage(r.activity, r.charging_state);
    const last = segments[segments.length - 1];
    if (last && last.stage === stage) last.end_ts = r.ts;
    else segments.push({ stage, start_ts: r.ts, end_ts: r.ts });
  }
  for (const seg of segments) stageSeconds[seg.stage] = (stageSeconds[seg.stage] ?? 0) + (seg.end_ts - seg.start_ts);

  const step = Math.max(1, Math.ceil(rows.length / 2000));
  const points = rows
    .filter((_, i) => i % step === 0 || i === rows.length - 1)
    .map((r) => ({ ts: r.ts, soc: round(r.soc, 1), stage: batteryStage(r.activity, r.charging_state) }));

  return {
    vin,
    hours,
    points,
    segments,
    stage_hours: {
      driving: round((stageSeconds.driving ?? 0) / 3600, 2),
      charging: round((stageSeconds.charging ?? 0) / 3600, 2),
      resting: round((stageSeconds.resting ?? 0) / 3600, 2),
      connected: round((stageSeconds.connected ?? 0) / 3600, 2),
    },
  };
}

// ---------------------------------------------------------------------------
// Chart explorer — multi-signal overlay timeline
// ---------------------------------------------------------------------------

/**
 * Point budgets for the explorer's activity-aware downsampling: driving keeps
 * ~4x the resolution of everything else, because that's where per-second
 * signals (speed, IMU, pedals) actually carry information — an hour of
 * charging or sleeping is happy with a handful of points.
 */
const EXPLORER_DRIVING_BUDGET = 2400;
const EXPLORER_OTHER_BUDGET = 600;
const EXPLORER_MAX_FIELDS = 8;
/** Harsh-event marker thresholds — the same ~0.25-0.3 g industry lines scoring.ts uses. */
const MARKER_ACCEL = 2.5; // m/s²
const MARKER_BRAKE = 3.0; // m/s²
/** One physical maneuver spans several 1 Hz samples — merge qualifying samples
 * within this gap into ONE marker at the peak (the drive-audit lesson about
 * per-sample counting inflating events). */
const MARKER_DEBOUNCE_S = 8;
/** Per-kind marker caps so a marker-storm can't bloat the payload; the counts
 * of what was dropped are reported in `marker_overflow`. */
const MARKER_CAPS: Record<string, number> = { harsh_brake: 120, harsh_accel: 120, music: 150, alert: 100 };

/**
 * Everything the Chart explorer screen needs in one call: any mix of signals
 * (positions columns full-fidelity where it matters + EAV fields), the
 * driving/charging/connected/resting stage layer, and event markers (harsh
 * brake/accel, track changes, alerts) — over one shared time window.
 */
export async function getTimelineChart(
  env: Env,
  vin: string,
  hours = 24,
  fields: string[] = ["speed", "soc", "inside_temp", "outside_temp"],
  endTs?: number,
): Promise<unknown> {
  await ensureSchema(env);
  // Stock-chart-style windowing: the window ENDS at `endTs` (default: now),
  // so the dashboard can pan back through history and drag-zoom into a
  // region instead of always being anchored to the present.
  const end = endTs && Number.isFinite(endTs) ? Math.round(endTs) : Math.floor(Date.now() / 1000);
  const since = end - Math.round(hours * 3600);

  // Requested fields split by storage: positions columns are validated against
  // the POSITION_COLUMNS whitelist (they are interpolated into SQL), EAV field
  // names are only ever bound as parameters (shape-checked to keep junk out).
  const wanted = [...new Set(fields)].slice(0, EXPLORER_MAX_FIELDS);
  const posFields = wanted.filter((f) => POSITION_COLUMNS.has(f));
  const eavFields = wanted.filter((f) => !POSITION_COLUMNS.has(f) && /^[a-z0-9_]{1,64}$/.test(f));

  const cols = [...new Set(["activity", "charging_state", "lon_accel", ...posFields])];
  const rs = await env.DB.prepare(
    `SELECT ts, ${cols.join(", ")} FROM positions WHERE vin = ?1 AND ts >= ?2 AND ts <= ?3 ORDER BY ts ASC`,
  )
    .bind(vin, since, end)
    .all<Record<string, unknown> & { ts: number; activity: string | null; charging_state: string | null; lon_accel: number | null }>();
  const rows = rs.results ?? [];

  // Stage layer — same derivation as the Battery timeline screen.
  const segments: { stage: string; start_ts: number; end_ts: number }[] = [];
  const stageSeconds: Record<string, number> = { driving: 0, charging: 0, resting: 0, connected: 0 };
  for (const r of rows) {
    const stage = batteryStage(r.activity, r.charging_state);
    const last = segments[segments.length - 1];
    if (last && last.stage === stage) last.end_ts = r.ts;
    else segments.push({ stage, start_ts: r.ts, end_ts: r.ts });
  }
  for (const seg of segments) stageSeconds[seg.stage] = (stageSeconds[seg.stage] ?? 0) + (seg.end_ts - seg.start_ts);

  // Activity-aware downsampling: independent strides for driving vs everything
  // else, plus every activity-boundary row so stage edges stay sharp.
  const nDriving = rows.reduce((n, r) => n + (r.activity === "driving" ? 1 : 0), 0);
  const strideDriving = Math.max(1, Math.ceil(nDriving / EXPLORER_DRIVING_BUDGET));
  const strideOther = Math.max(1, Math.ceil((rows.length - nDriving) / EXPLORER_OTHER_BUDGET));
  const sampled: typeof rows = [];
  let iDriving = 0;
  let iOther = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const driving = r.activity === "driving";
    const boundary = i === 0 || i === rows.length - 1 || (rows[i - 1]?.activity === "driving") !== driving;
    const keep = boundary || (driving ? iDriving % strideDriving === 0 : iOther % strideOther === 0);
    if (driving) iDriving++;
    else iOther++;
    if (keep) sampled.push(r);
  }

  const series: Record<string, [number, number][]> = {};
  for (const f of posFields) {
    series[f] = sampled
      .filter((r) => typeof (r as Record<string, unknown>)[f] === "number" && Number.isFinite((r as Record<string, unknown>)[f] as number))
      .map((r) => [r.ts, round((r as Record<string, unknown>)[f] as number, 2)] as [number, number]);
  }
  for (const f of eavFields) {
    const ev = await env.DB.prepare(
      `SELECT ts, value_num FROM telemetry_events
       WHERE vin = ?1 AND field = ?2 AND ts >= ?3 AND ts <= ?4 AND value_num IS NOT NULL ORDER BY ts ASC LIMIT 5000`,
    )
      .bind(vin, f, since, end)
      .all<{ ts: number; value_num: number }>();
    const evRows = ev.results ?? [];
    const step = Math.max(1, Math.ceil(evRows.length / EXPLORER_OTHER_BUDGET));
    series[f] = evRows
      .filter((_, i) => i % step === 0 || i === evRows.length - 1)
      .map((r) => [r.ts, round(r.value_num, 2)] as [number, number]);
  }

  // Markers -------------------------------------------------------------------
  const markers: { ts: number; kind: string; label: string }[] = [];

  // Harsh accel/brake from the FULL-resolution IMU stream (never the sampled
  // one — downsampling must not eat safety events), debounced to peaks.
  let run: { kind: string; peakTs: number; peak: number; lastTs: number } | null = null;
  const flushRun = () => {
    if (!run) return;
    const g = run.peak / 9.81;
    markers.push({
      ts: run.peakTs,
      kind: run.kind,
      label: `${run.kind === "harsh_brake" ? "Hard brake" : "Hard acceleration"} ${g > 0 ? "+" : ""}${round(g, 2)} g`,
    });
    run = null;
  };
  for (const r of rows) {
    const a = typeof r.lon_accel === "number" && Number.isFinite(r.lon_accel) ? r.lon_accel : null;
    const kind = r.activity !== "driving" || a === null ? null
      : a <= -MARKER_BRAKE ? "harsh_brake"
      : a >= MARKER_ACCEL ? "harsh_accel"
      : null;
    if (run && (r.ts - run.lastTs > MARKER_DEBOUNCE_S || (kind !== null && kind !== run.kind))) flushRun();
    if (kind === null) continue;
    if (!run) run = { kind, peakTs: r.ts, peak: a as number, lastTs: r.ts };
    else {
      run.lastTs = r.ts;
      if (Math.abs(a as number) > Math.abs(run.peak)) {
        run.peak = a as number;
        run.peakTs = r.ts;
      }
    }
  }
  flushRun();

  // Track changes: every NEW media_title (consecutive repeats collapsed), with
  // the artist matched from its own event stream when one landed nearby.
  const [titles, artists] = await Promise.all([
    env.DB.prepare(
      `SELECT ts, value_text FROM telemetry_events
       WHERE vin = ?1 AND field = 'media_title' AND ts >= ?2 AND ts <= ?3 AND value_text IS NOT NULL AND value_text != ''
       ORDER BY ts ASC LIMIT 2000`,
    ).bind(vin, since, end).all<{ ts: number; value_text: string }>(),
    env.DB.prepare(
      `SELECT ts, value_text FROM telemetry_events
       WHERE vin = ?1 AND field = 'media_artist' AND ts >= ?2 AND ts <= ?3 AND value_text IS NOT NULL AND value_text != ''
       ORDER BY ts ASC LIMIT 2000`,
    ).bind(vin, since, end).all<{ ts: number; value_text: string }>(),
  ]);
  const artistRows = artists.results ?? [];
  const artistNear = (ts: number): string | null => {
    let best: { d: number; v: string } | null = null;
    for (const a of artistRows) {
      const d = Math.abs(a.ts - ts);
      if (d <= 90 && (best === null || d < best.d)) best = { d, v: a.value_text };
    }
    return best?.v ?? null;
  };
  let prevTitle = "";
  for (const t of titles.results ?? []) {
    if (t.value_text === prevTitle) continue;
    prevTitle = t.value_text;
    const artist = artistNear(t.ts);
    markers.push({ ts: t.ts, kind: "music", label: artist ? `${t.value_text} — ${artist}` : t.value_text });
  }

  // Warnings: everything the worker itself alerted on in the window (rule
  // fires, watchdogs, budget warnings — vin-specific or global).
  const al = await env.DB.prepare(
    `SELECT ts, message FROM alert_log WHERE ts >= ?1 AND ts <= ?2 AND (vin = ?3 OR vin IS NULL) ORDER BY ts ASC LIMIT 200`,
  )
    .bind(since, end, vin)
    .all<{ ts: number; message: string }>();
  for (const a of al.results ?? []) markers.push({ ts: a.ts, kind: "alert", label: String(a.message ?? "").slice(0, 140) });

  // Chronological + per-kind caps (report what was dropped — no silent truncation).
  markers.sort((a, b) => a.ts - b.ts);
  const counts: Record<string, number> = {};
  const overflow: Record<string, number> = {};
  const capped = markers.filter((m) => {
    const n = (counts[m.kind] ?? 0) + 1;
    counts[m.kind] = n;
    if (n <= (MARKER_CAPS[m.kind] ?? 100)) return true;
    overflow[m.kind] = (overflow[m.kind] ?? 0) + 1;
    return false;
  });

  return {
    vin,
    hours,
    window: { start_ts: since, end_ts: end, live: endTs === undefined },
    fields: [...posFields, ...eavFields],
    series,
    segments,
    stage_hours: {
      driving: round((stageSeconds.driving ?? 0) / 3600, 2),
      charging: round((stageSeconds.charging ?? 0) / 3600, 2),
      resting: round((stageSeconds.resting ?? 0) / 3600, 2),
      connected: round((stageSeconds.connected ?? 0) / 3600, 2),
    },
    markers: capped,
    marker_overflow: overflow,
    resolution: { rows: rows.length, kept: sampled.length, stride_driving: strideDriving, stride_other: strideOther },
  };
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
// Derived: Sentry Mode event log
// ---------------------------------------------------------------------------

const SENTRY_ARMED_STATES = new Set(["armed", "aware", "panic"]);
const SENTRY_TRIGGER_STATES = new Set(["aware", "panic"]);
/** States that prove the account streams the full SentryModeState enum, not just booleans. */
const SENTRY_ENUM_ONLY_STATES = new Set(["idle", "aware", "panic"]);

/** Nearest position row to `ts` — prefers the closest preceding sample, falls back to the closest following one. */
async function nearestPositionAt(
  env: Env,
  vin: string,
  ts: number,
): Promise<{ lat: number; lon: number } | null> {
  const before = await env.DB.prepare(
    `SELECT lat, lon, ts FROM positions WHERE vin = ?1 AND ts <= ?2 AND lat IS NOT NULL AND lon IS NOT NULL
     ORDER BY ts DESC LIMIT 1`,
  ).bind(vin, ts).first<{ lat: number; lon: number; ts: number }>();
  const after = await env.DB.prepare(
    `SELECT lat, lon, ts FROM positions WHERE vin = ?1 AND ts >= ?2 AND lat IS NOT NULL AND lon IS NOT NULL
     ORDER BY ts ASC LIMIT 1`,
  ).bind(vin, ts).first<{ lat: number; lon: number; ts: number }>();
  if (!before && !after) return null;
  if (!before) return { lat: after!.lat, lon: after!.lon };
  if (!after) return { lat: before.lat, lon: before.lon };
  const nearest = ts - before.ts <= after.ts - ts ? before : after;
  return { lat: nearest.lat, lon: nearest.lon };
}

/**
 * Sentry Mode event log over the trailing `days`. Reads the `sentry` EAV
 * field with a query that's backward-compatible with rows recorded before
 * normalizeSentryState() existed (legacy rows stored a bare 0/1 in
 * value_num; new rows store the normalized string in value_text) —
 * COALESCE reads both shapes uniformly.
 *
 * `enum_available` is only true once the account has actually streamed one
 * of the enum-only states (idle/aware/panic) — on a boolean-only account
 * (REST poll, or a telemetry config not yet upgraded) it stays false and
 * `events` will always be empty, since "armed" vs "off" alone can't tell an
 * actual proximity/motion trigger apart from someone just enabling Sentry.
 * The `note` field explains that gap rather than silently showing zero
 * events forever.
 */
export async function getSentryLog(env: Env, vin: string, days = 30): Promise<unknown> {
  await ensureSchema(env);
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
  const rs = await env.DB.prepare(
    `SELECT ts, COALESCE(value_text, CASE WHEN value_num = 1 THEN 'armed' WHEN value_num = 0 THEN 'off' END) AS state
     FROM telemetry_events
     WHERE vin = ?1 AND field = 'sentry' AND ts >= ?2
     ORDER BY ts ASC`,
  ).bind(vin, sinceTs).all<{ ts: number; state: string | null }>();
  const rows = (rs.results ?? []).filter((r) => r.state != null) as { ts: number; state: string }[];

  if (!rows.length) {
    return {
      vin, days, has_data: false,
      note: "No Sentry Mode telemetry recorded yet.",
    };
  }

  const enumAvailable = rows.some((r) => SENTRY_ENUM_ONLY_STATES.has(r.state));

  let armedSeconds = 0;
  const nowTs = Math.floor(Date.now() / 1000);
  const rawEvents: { ts: number; from: string; to: string }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const prev = i > 0 ? rows[i - 1]! : null;
    const nextTs = i + 1 < rows.length ? rows[i + 1]!.ts : nowTs;
    if (SENTRY_ARMED_STATES.has(row.state)) armedSeconds += Math.max(0, nextTs - row.ts);
    if (prev && prev.state !== row.state && SENTRY_TRIGGER_STATES.has(row.state)) {
      rawEvents.push({ ts: row.ts, from: prev.state, to: row.state });
    }
  }

  const events = await Promise.all(
    rawEvents.map(async (e) => {
      const pos = await nearestPositionAt(env, vin, e.ts);
      return { ts: e.ts, from: e.from, to: e.to, lat: pos?.lat ?? null, lon: pos?.lon ?? null };
    }),
  );

  return {
    vin,
    days,
    has_data: true,
    enum_available: enumAvailable,
    note: enumAvailable
      ? undefined
      : "This account only streams Sentry Mode as on/off (armed/off) — Tesla's richer Idle/Aware/Panic states aren't in the telemetry config yet, so real trigger events (someone approaching, an impact) can't be distinguished from just enabling Sentry. Armed-time is still tracked below. Streaming the full enum (via configure_telemetry) would unlock actual event detection.",
    armed_hours: round(armedSeconds / 3600, 1),
    event_count: events.length,
    panic_count: events.filter((e) => e.to === "panic").length,
    events: events.slice(-50).reverse(),
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
    api_budget: await getBudgetStatus(env)
      .then(async (status) => ({ ...status, forecast: await getBudgetForecast(env).catch(() => null) }))
      .catch(() => null),
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
// Media — "most played" from Fleet Telemetry's MediaNowPlaying* fields
// ---------------------------------------------------------------------------

/**
 * Groups a media field's (title/artist/source/station) generic EAV history
 * into "plays": a play starts whenever the value changes from the previous
 * sample, and runs until the next change (or now, for whatever's still
 * playing) — so repeated identical samples of the same track don't inflate
 * the count. Requires Fleet Telemetry streaming to have been configured with
 * the Media* fields (see configure_telemetry) — this is closed-form on
 * whatever's already in telemetry_events, no new collection.
 */
async function mediaLeaderboard(
  env: Env,
  vin: string,
  field: string,
  sinceTs: number,
  nowTs: number,
): Promise<{ name: string; plays: number; seconds: number }[]> {
  // Empty samples ('' = playback stopped) are KEPT in raw/starts as span
  //   terminators and only excluded from the final aggregation. Filtering
  //   them out earlier had two observed corruptions: every session's last
  //   track absorbed the following silence until the NEXT track started --
  //   hours later, capped at exactly 600s, so the whole leaderboard read as
  //   uniform 5-10-minute plays -- and track -> stop -> same track again
  //   collapsed into one play because the LAG never saw the stop between.
  const rs = await env.DB.prepare(
    `WITH raw AS (
       SELECT ts, COALESCE(value_text, '') AS v,
              LAG(COALESCE(value_text, '')) OVER (ORDER BY ts) AS prev_v
       FROM telemetry_events
       WHERE vin = ?1 AND field = ?2 AND ts >= ?3
     ),
     starts AS (
       SELECT ts, v FROM raw WHERE prev_v IS NULL OR prev_v != v
     ),
     spans AS (
       SELECT v, ts, COALESCE(LEAD(ts) OVER (ORDER BY ts), ?4) AS end_ts FROM starts
     )
     -- Cap each span at 10 min: an open-ended "still playing" span otherwise
     -- runs to wall-clock "now", so a car idle for days since its last sample
     -- would count that whole gap as listening time for whatever was last playing.
     SELECT v AS name, COUNT(*) AS plays, SUM(MAX(0, MIN(end_ts - ts, 600))) AS seconds
     FROM spans WHERE v != '' GROUP BY v ORDER BY plays DESC`,
  )
    .bind(vin, field, sinceTs, nowTs)
    .all<{ name: string; plays: number; seconds: number }>();
  return rs.results ?? [];
}

/**
 * Ordered track-change events within a time window (a drive's start/end) —
 * for marking "what was playing" on the drive-detail chart. Unlike
 * mediaLeaderboard this returns the raw sequence, not an aggregated
 * leaderboard, and best-effort attaches whichever artist value was current
 * as of each title change (a second field, sampled independently, so it's a
 * nearest-preceding-value join rather than a guaranteed exact pairing).
 */
export async function mediaTrackChanges(
  env: Env,
  vin: string,
  sinceTs: number,
  untilTs: number,
): Promise<{ ts: number; title: string; artist: string | null }[]> {
  await ensureSchema(env);
  const titleRows = await env.DB.prepare(
    `WITH raw AS (
       SELECT ts, value_text AS v, LAG(value_text) OVER (ORDER BY ts) AS prev_v
       FROM telemetry_events
       WHERE vin = ?1 AND field = 'media_title' AND ts BETWEEN ?2 AND ?3
     )
     SELECT ts, v AS title FROM raw
     WHERE (prev_v IS NULL OR prev_v != v) AND v IS NOT NULL AND v != ''
     ORDER BY ts ASC`,
  )
    .bind(vin, sinceTs, untilTs)
    .all<{ ts: number; title: string }>();
  const titles = titleRows.results ?? [];
  if (!titles.length) return [];

  const artistRows = await env.DB.prepare(
    `SELECT ts, value_text AS artist FROM telemetry_events
     WHERE vin = ?1 AND field = 'media_artist' AND ts BETWEEN ?2 AND ?3
     ORDER BY ts ASC`,
  )
    .bind(vin, sinceTs, untilTs)
    .all<{ ts: number; artist: string | null }>();
  const artists = artistRows.results ?? [];
  let ai = 0;
  let currentArtist: string | null = null;
  const artistAt = (ts: number): string | null => {
    while (ai < artists.length && artists[ai]!.ts <= ts) { currentArtist = artists[ai]!.artist; ai++; }
    return currentArtist;
  };
  return titles.map((r) => ({ ts: r.ts, title: r.title, artist: artistAt(r.ts) }));
}

/**
 * Same value-change play-counting as mediaLeaderboard, but attributed to
 * whichever driver was assigned to the drive each play fell inside (a plain
 * LEFT JOIN on time range — plays outside any drive, or inside an
 * unassigned one, land in "Unassigned"). No duration/seconds here: a
 * per-driver breakdown is about WHO listens to WHAT, and play count alone
 * answers that honestly without the span-capping complexity of the overall
 * leaderboard.
 */
async function mediaLeaderboardByDriver(
  env: Env,
  vin: string,
  field: string,
  sinceTs: number,
): Promise<{ driver: string; name: string; plays: number }[]> {
  const rs = await env.DB.prepare(
    `WITH raw AS (
       SELECT ts, COALESCE(value_text, '') AS v,
              LAG(COALESCE(value_text, '')) OVER (ORDER BY ts) AS prev_v
       FROM telemetry_events
       WHERE vin = ?1 AND field = ?2 AND ts >= ?3
     ),
     starts AS (
       -- Empty samples ('' = stopped) stay in raw as play boundaries (same
       -- rationale as mediaLeaderboard) but never count as plays themselves.
       SELECT ts, v FROM raw WHERE (prev_v IS NULL OR prev_v != v) AND v != ''
     )
     SELECT COALESCE(d.driver, 'Unassigned') AS driver, s.v AS name, COUNT(*) AS plays
     FROM starts s
     LEFT JOIN drives d ON d.vin = ?1 AND d.status = 'complete' AND s.ts BETWEEN d.start_ts AND d.end_ts
     GROUP BY driver, name
     ORDER BY driver ASC, plays DESC`,
  )
    .bind(vin, field, sinceTs)
    .all<{ driver: string; name: string; plays: number }>();
  return rs.results ?? [];
}

/** "Most played" leaderboards broken down per assigned driver, over the trailing `days`. */
export async function getMediaStatsByDriver(env: Env, vin: string, days = 90): Promise<unknown> {
  await ensureSchema(env);
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
  const [titleRows, artistRows, sourceRows] = await Promise.all([
    mediaLeaderboardByDriver(env, vin, "media_title", sinceTs),
    mediaLeaderboardByDriver(env, vin, "media_artist", sinceTs),
    mediaLeaderboardByDriver(env, vin, "media_source", sinceTs),
  ]);
  if (!titleRows.length && !artistRows.length && !sourceRows.length) {
    return {
      vin, days, has_data: false,
      note: "No media telemetry recorded yet — see get_media_stats. Per-driver breakdown also needs those drives to have an assigned driver (Drives page).",
    };
  }
  const driverNames = new Set<string>();
  for (const r of [...titleRows, ...artistRows, ...sourceRows]) driverNames.add(r.driver);
  const forDriver = (rows: typeof titleRows, driver: string, key: string, limit: number) =>
    rows.filter((r) => r.driver === driver).slice(0, limit).map((r) => ({ [key]: r.name, plays: r.plays }));

  return {
    vin,
    days,
    has_data: true,
    drivers: [...driverNames].sort((a, b) => a.localeCompare(b)).map((driver) => ({
      driver,
      total_plays: titleRows.filter((r) => r.driver === driver).reduce((s, r) => s + r.plays, 0),
      top_tracks: forDriver(titleRows, driver, "title", 10),
      top_artists: forDriver(artistRows, driver, "artist", 10),
      top_sources: forDriver(sourceRows, driver, "source", 5),
    })),
  };
}

/**
 * Idea #2/#95: what's playing when traffic gets bad vs. when the road is
 * clear. Each track-start is paired with the nearest-preceding
 * nav_traffic_delay_min reading (a plain "as of that moment" lookup, same
 * idea as mediaTrackChanges' artist pairing) and bucketed heavy (>10 min
 * delay) vs light (<=5 min). Returns null (not an empty result) when
 * nav_traffic_delay_min has never been streamed, so the caller can omit the
 * section entirely rather than show two empty lists.
 */
async function mediaTrafficMood(env: Env, vin: string, sinceTs: number): Promise<{ heavy: { title: string; plays: number }[]; light: { title: string; plays: number }[] } | null> {
  const hasTraffic = await env.DB.prepare(
    `SELECT 1 FROM telemetry_events WHERE vin = ?1 AND field = 'nav_traffic_delay_min' AND ts >= ?2 LIMIT 1`,
  ).bind(vin, sinceTs).first();
  if (!hasTraffic) return null;

  const rs = await env.DB.prepare(
    `WITH raw AS (
       SELECT ts, value_text AS v, LAG(value_text) OVER (ORDER BY ts) AS prev_v
       FROM telemetry_events
       WHERE vin = ?1 AND field = 'media_title' AND ts >= ?2 AND value_text IS NOT NULL AND value_text != ''
     ),
     starts AS (
       SELECT ts, v FROM raw WHERE prev_v IS NULL OR prev_v != v
     )
     SELECT s.v AS title,
       (SELECT t.value_num FROM telemetry_events t
        WHERE t.vin = ?1 AND t.field = 'nav_traffic_delay_min' AND t.ts <= s.ts
        ORDER BY t.ts DESC LIMIT 1) AS delay
     FROM starts s`,
  )
    .bind(vin, sinceTs)
    .all<{ title: string; delay: number | null }>();

  const counts = { heavy: new Map<string, number>(), light: new Map<string, number>() };
  for (const r of rs.results ?? []) {
    if (r.delay == null) continue;
    const bucket = r.delay > 10 ? counts.heavy : r.delay <= 5 ? counts.light : null;
    if (bucket) bucket.set(r.title, (bucket.get(r.title) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([title, plays]) => ({ title, plays }));
  return { heavy: top(counts.heavy), light: top(counts.light) };
}

/** "Most played" leaderboards (tracks/artists/sources/stations) over the trailing `days`. */
export async function getMediaStats(env: Env, vin: string, days = 90): Promise<unknown> {
  await ensureSchema(env);
  const nowTs = Math.floor(Date.now() / 1000);
  const sinceTs = nowTs - days * 86400;
  const [tracks, artists, sources, stations] = await Promise.all([
    mediaLeaderboard(env, vin, "media_title", sinceTs, nowTs),
    mediaLeaderboard(env, vin, "media_artist", sinceTs, nowTs),
    mediaLeaderboard(env, vin, "media_source", sinceTs, nowTs),
    mediaLeaderboard(env, vin, "media_station", sinceTs, nowTs),
  ]);

  if (!tracks.length && !artists.length && !sources.length && !stations.length) {
    return {
      vin, days, has_data: false,
      note: "No media telemetry recorded yet. Stream MediaNowPlayingTitle, MediaNowPlayingArtist, " +
        "MediaNowPlayingStation and MediaPlaybackSource via configure_telemetry to start tracking what's played.",
    };
  }

  const totalPlays = tracks.reduce((s, r) => s + r.plays, 0);
  const totalSeconds = tracks.reduce((s, r) => s + (r.seconds || 0), 0);
  const top = (rows: { name: string; plays: number; seconds: number }[], key: string, limit: number) =>
    rows.slice(0, limit).map((r) => ({ [key]: r.name, plays: r.plays, minutes: round(r.seconds / 60, 0) }));

  return {
    vin,
    days,
    has_data: true,
    total_plays: totalPlays,
    total_listening_hours: round(totalSeconds / 3600, 1),
    top_tracks: top(tracks, "title", 15),
    top_artists: top(artists, "artist", 15),
    top_sources: top(sources, "source", 10),
    top_stations: top(stations, "station", 10),
    traffic_mood: await mediaTrafficMood(env, vin, sinceTs),
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
    balance: await tireBalance(env, vin, since),
  };
}

/**
 * Long-term side-to-side/front-to-rear pressure balance: pairs same-timestamp
 * samples (the 4 TPMS values normally arrive together in one poll/telemetry
 * batch) and averages the delta, rather than just comparing the latest
 * reading — a single stale sample shouldn't read as "asymmetric wear".
 * `asymmetric: true` flags a persistent >0.15 bar gap on any axis, which
 * over thousands of miles is a real early alignment/wear signal (idea #67).
 */
async function tireBalance(env: Env, vin: string, since: number): Promise<unknown> {
  const rs = await env.DB.prepare(
    `SELECT AVG(fl.value_num - fr.value_num) AS fl_fr, AVG(rl.value_num - rr.value_num) AS rl_rr,
            AVG(fl.value_num - rl.value_num) AS fl_rl, AVG(fr.value_num - rr.value_num) AS fr_rr,
            COUNT(*) AS n
     FROM (SELECT ts, value_num FROM telemetry_events WHERE vin = ?1 AND field = 'tpms_fl' AND ts >= ?2 AND value_num IS NOT NULL) fl
     JOIN (SELECT ts, value_num FROM telemetry_events WHERE vin = ?1 AND field = 'tpms_fr' AND ts >= ?2 AND value_num IS NOT NULL) fr ON fr.ts = fl.ts
     JOIN (SELECT ts, value_num FROM telemetry_events WHERE vin = ?1 AND field = 'tpms_rl' AND ts >= ?2 AND value_num IS NOT NULL) rl ON rl.ts = fl.ts
     JOIN (SELECT ts, value_num FROM telemetry_events WHERE vin = ?1 AND field = 'tpms_rr' AND ts >= ?2 AND value_num IS NOT NULL) rr ON rr.ts = fl.ts`,
  )
    .bind(vin, since)
    .first<{ fl_fr: number | null; rl_rr: number | null; fl_rl: number | null; fr_rr: number | null; n: number }>();
  if (!rs || !rs.n) return null;
  const deltas = { fl_fr: rs.fl_fr, rl_rr: rs.rl_rr, fl_rl: rs.fl_rl, fr_rr: rs.fr_rr };
  const maxAbs = Math.max(...Object.values(deltas).map((v) => Math.abs(v ?? 0)));
  return {
    paired_samples: rs.n,
    fl_fr_bar: round(rs.fl_fr ?? 0, 3),
    rl_rr_bar: round(rs.rl_rr ?? 0, 3),
    fl_rl_bar: round(rs.fl_rl ?? 0, 3),
    fr_rr_bar: round(rs.fr_rr ?? 0, 3),
    asymmetric: maxAbs > 0.15,
  };
}

// ---------------------------------------------------------------------------
// Derived: lifetime charging taper curve (idea #51 — how charging power
// actually falls off as SoC rises, from every session ever logged, not just
// one at a time like the per-session charge-curve chart already shows).
// ---------------------------------------------------------------------------

export async function getChargeTaperCurve(env: Env, vin: string): Promise<unknown> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT CAST(FLOOR(soc / 5) * 5 AS INTEGER) AS soc_bin,
            AVG(charger_power) AS avg_power_kw, MAX(charger_power) AS max_power_kw, COUNT(*) AS samples
     FROM charges
     WHERE vin = ?1 AND soc IS NOT NULL AND charger_power IS NOT NULL AND charger_power > 0
     GROUP BY soc_bin ORDER BY soc_bin ASC`,
  )
    .bind(vin)
    .all<{ soc_bin: number; avg_power_kw: number; max_power_kw: number; samples: number }>();
  const bins = rs.results ?? [];
  return {
    vin,
    bins: bins.map((b) => ({
      soc_min: b.soc_bin,
      soc_max: b.soc_bin + 5,
      avg_power_kw: round(b.avg_power_kw, 1),
      max_power_kw: round(b.max_power_kw, 1),
      samples: b.samples,
    })),
    note: bins.length < 4 ? "Needs more charge sessions across a range of SoC to draw a full taper curve." : null,
  };
}

// ---------------------------------------------------------------------------
// Small EAV aggregate helpers shared by the safety/climate derivations below.
// ---------------------------------------------------------------------------

async function boolFieldFraction(env: Env, vin: string, field: string, sinceTs: number): Promise<{ frac_on: number | null; samples: number }> {
  const rs = await env.DB.prepare(
    `SELECT AVG(value_num) AS frac_on, COUNT(*) AS n FROM telemetry_events WHERE vin = ?1 AND field = ?2 AND ts >= ?3 AND value_num IS NOT NULL`,
  )
    .bind(vin, field, sinceTs)
    .first<{ frac_on: number | null; n: number }>();
  return { frac_on: rs?.frac_on ?? null, samples: rs?.n ?? 0 };
}

async function avgFieldValue(env: Env, vin: string, field: string, sinceTs: number): Promise<{ avg: number | null; samples: number }> {
  const rs = await env.DB.prepare(
    `SELECT AVG(value_num) AS avg, COUNT(*) AS n FROM telemetry_events WHERE vin = ?1 AND field = ?2 AND ts >= ?3 AND value_num IS NOT NULL`,
  )
    .bind(vin, field, sinceTs)
    .first<{ avg: number | null; n: number }>();
  return { avg: rs?.avg ?? null, samples: rs?.n ?? 0 };
}

/** Counts 0→1 transitions of a boolean field — "how many times did this fire", not "how long was it on". */
async function countActivations(env: Env, vin: string, field: string, sinceTs: number): Promise<number> {
  const rs = await env.DB.prepare(
    `WITH raw AS (
       SELECT ts, value_num AS v, LAG(value_num) OVER (ORDER BY ts) AS prev
       FROM telemetry_events WHERE vin = ?1 AND field = ?2 AND ts >= ?3 AND value_num IS NOT NULL
     )
     SELECT COUNT(*) AS n FROM raw WHERE v = 1 AND (prev IS NULL OR prev = 0)`,
  )
    .bind(vin, field, sinceTs)
    .first<{ n: number }>();
  return rs?.n ?? 0;
}

async function mostCommonEnumValue(env: Env, vin: string, field: string, sinceTs: number): Promise<string | null> {
  const rs = await env.DB.prepare(
    `SELECT value_text AS v FROM telemetry_events
     WHERE vin = ?1 AND field = ?2 AND ts >= ?3 AND value_text IS NOT NULL AND value_text != ''
     GROUP BY value_text ORDER BY COUNT(*) DESC LIMIT 1`,
  )
    .bind(vin, field, sinceTs)
    .first<{ v: string }>();
  return rs?.v ?? null;
}

// ---------------------------------------------------------------------------
// Derived: safety/ADAS feature adoption (idea #62/#70) — how much your
// driving style interacts with the car's own safety systems.
// ---------------------------------------------------------------------------

export async function getSafetyFeatureStats(env: Env, vin: string, days = 90): Promise<unknown> {
  await ensureSchema(env);
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
  const [aeb, blindSpotChimes, laneDeparture, fcwSensitivity] = await Promise.all([
    boolFieldFraction(env, vin, "aeb_off", sinceTs),
    countActivations(env, vin, "blind_spot_chime", sinceTs),
    mostCommonEnumValue(env, vin, "lane_departure", sinceTs),
    mostCommonEnumValue(env, vin, "fcw_sensitivity", sinceTs),
  ]);
  if (!aeb.samples && !blindSpotChimes && !laneDeparture && !fcwSensitivity) {
    return {
      vin, days, has_data: false,
      note: "No ADAS telemetry recorded yet — stream AutomaticEmergencyBrakingOff, BlindSpotCollisionWarningChime, " +
        "LaneDepartureAvoidance and ForwardCollisionWarning via configure_telemetry.",
    };
  }
  return {
    vin,
    days,
    has_data: true,
    aeb_disabled_pct: aeb.frac_on != null ? round(aeb.frac_on * 100, 1) : null,
    aeb_samples: aeb.samples,
    blind_spot_chime_count: blindSpotChimes,
    lane_departure_setting: laneDeparture,
    forward_collision_warning_setting: fcwSensitivity,
  };
}

// ---------------------------------------------------------------------------
// Derived: climate/comfort habits (idea #33/#38) — also the same signal
// suggestDriverForDrive already leans on for auto-assignment, surfaced here
// as its own human-readable report instead of just an internal fingerprint.
// ---------------------------------------------------------------------------

export async function getClimateHabits(env: Env, vin: string, days = 90): Promise<unknown> {
  await ensureSchema(env);
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
  const [autoL, autoR, heaterL, heaterR, coolFL, coolFR] = await Promise.all([
    boolFieldFraction(env, vin, "auto_seat_climate_l", sinceTs),
    boolFieldFraction(env, vin, "auto_seat_climate_r", sinceTs),
    avgFieldValue(env, vin, "seat_heater_l", sinceTs),
    avgFieldValue(env, vin, "seat_heater_r", sinceTs),
    avgFieldValue(env, vin, "seat_cool_fl", sinceTs),
    avgFieldValue(env, vin, "seat_cool_fr", sinceTs),
  ]);
  const totalSamples = autoL.samples + autoR.samples + heaterL.samples + heaterR.samples + coolFL.samples + coolFR.samples;
  if (!totalSamples) {
    return {
      vin, days, has_data: false,
      note: "No climate-habit telemetry recorded yet — stream AutoSeatClimateLeft/Right, SeatHeaterLeft/Right " +
        "and ClimateSeatCoolingFrontLeft/Right via configure_telemetry.",
    };
  }
  return {
    vin,
    days,
    has_data: true,
    auto_climate_left_pct: autoL.frac_on != null ? round(autoL.frac_on * 100, 0) : null,
    auto_climate_right_pct: autoR.frac_on != null ? round(autoR.frac_on * 100, 0) : null,
    avg_seat_heater_left: heaterL.avg != null ? round(heaterL.avg, 1) : null,
    avg_seat_heater_right: heaterR.avg != null ? round(heaterR.avg, 1) : null,
    seat_heater_divergence: heaterL.avg != null && heaterR.avg != null ? round(Math.abs(heaterL.avg - heaterR.avg), 2) : null,
    avg_seat_cool_left: coolFL.avg != null ? round(coolFL.avg, 1) : null,
    avg_seat_cool_right: coolFR.avg != null ? round(coolFR.avg, 1) : null,
    seat_cool_divergence: coolFL.avg != null && coolFR.avg != null ? round(Math.abs(coolFL.avg - coolFR.avg), 2) : null,
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

/** Independent same-place+same-time-bucket historical drives required before the system trusts itself to auto-assign without asking. */
const AUTO_ASSIGN_MIN_MATCHES = 3;
/** ...and the winner must clear the runner-up by this much combined weight — otherwise it's ambiguous, ask instead. */
const AUTO_ASSIGN_MIN_MARGIN = 1.5;

/**
 * Infers a driver for a just-closed drive from tagged history — Tesla exposes
 * no actual "who's driving" field, so this leans on the next-best signals:
 * place + time-of-week (weekday/weekend × 3-hour block) match against each
 * driver's own history, corroborated by two fields that track with the
 * active driver profile (driver-side climate setpoint, seat-heater habit —
 * a stand-in for seat-position memory).
 *
 * Two-tier outcome:
 *   - CONFIDENT (≥3 independent supporting drives, clearly ahead of any other
 *     candidate): the system assigns `driver` itself, tagged driver_source =
 *     'auto' — no human action needed. Still just as correctable as a manual
 *     tag (setDriveDriver always overrides it and flips the tag to 'manual').
 *   - WEAKER (some signal, but too thin or ambiguous to trust unsupervised):
 *     falls back to today's behaviour — stored in suggested_driver as a
 *     one-tap confirmation, never silently written to `driver`.
 *   - Otherwise: nothing (not enough signal to say anything useful).
 */
export async function suggestDriverForDrive(env: Env, driveId: number, vin: string): Promise<void> {
  const d = await env.DB.prepare(
    `SELECT start_ts, start_lat, start_lon, start_location_id, driver, fp_temp_set, fp_seat_heater
     FROM drives WHERE id = ?1`,
  )
    .bind(driveId)
    .first<{ start_ts: number; start_lat: number | null; start_lon: number | null; start_location_id: number | null; driver: string | null; fp_temp_set: number | null; fp_seat_heater: number | null }>();
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
    `SELECT driver, start_ts, start_lat, start_lon, start_location_id, fp_temp_set, fp_seat_heater FROM drives
     WHERE vin = ?1 AND status = 'complete' AND driver IS NOT NULL AND id != ?2
     ORDER BY start_ts DESC LIMIT 500`,
  )
    .bind(vin, driveId)
    .all<{ driver: string; start_ts: number; start_lat: number | null; start_lon: number | null; start_location_id: number | null; fp_temp_set: number | null; fp_seat_heater: number | null }>();

  // Weighted voting: same place + same day/hour bucket is the strong signal;
  // a matching active-driver-profile fingerprint (climate setpoint + seat-heater
  // habit) adds a corroborating vote — the exposed stand-in for a seat-position
  // memory, since these fields track with the active driver. `matches` counts
  // only the strong place+time signal (not fingerprint-only), so a single
  // suspiciously-perfect fingerprint match can't alone clear the auto-assign bar.
  const votes = new Map<string, { weight: number; matches: number }>();
  const add = (driver: string, w: number, isPlaceTimeMatch: boolean) => {
    const cur = votes.get(driver) ?? { weight: 0, matches: 0 };
    cur.weight += w;
    if (isPlaceTimeMatch) cur.matches += 1;
    votes.set(driver, cur);
  };
  const fpMatch = (a: number | null, b: number | null, tol: number): boolean =>
    a != null && b != null && Math.abs(a - b) <= tol;

  for (const c of candidates.results ?? []) {
    const samePlace =
      (d.start_location_id != null && c.start_location_id === d.start_location_id) ||
      (d.start_lat != null && d.start_lon != null && c.start_lat != null && c.start_lon != null &&
        haversineMeters(d.start_lat, d.start_lon, c.start_lat, c.start_lon) <= 1000);
    const placeTimeMatch = samePlace && bucketOf(c.start_ts) === targetBucket;
    let w = 0;
    if (placeTimeMatch) w += 1; // place + time
    // Fingerprint corroboration: driver climate setpoint (±0.5°C) + seat heater.
    if (fpMatch(d.fp_temp_set, c.fp_temp_set, 0.5)) w += 0.5;
    if (fpMatch(d.fp_seat_heater, c.fp_seat_heater, 0)) w += 0.3;
    if (w > 0) add(c.driver, w, placeTimeMatch);
  }
  let best: { driver: string; weight: number; matches: number } | null = null;
  let runnerUp: { driver: string; weight: number; matches: number } | null = null;
  for (const [driver, v] of votes) {
    if (!best || v.weight > best.weight) { runnerUp = best; best = { driver, ...v }; }
    else if (!runnerUp || v.weight > runnerUp.weight) runnerUp = { driver, ...v };
  }
  if (!best) return; // no signal at all

  const confidentAuto =
    best.matches >= AUTO_ASSIGN_MIN_MATCHES &&
    (!runnerUp || best.weight - runnerUp.weight >= AUTO_ASSIGN_MIN_MARGIN);
  if (confidentAuto) {
    await env.DB.prepare(`UPDATE drives SET driver = ?2, driver_source = 'auto' WHERE id = ?1`).bind(driveId, best.driver).run();
  } else if (best.weight >= 1.5) {
    // Require a place+time match's worth of confidence (≥1.5 combined weight).
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

  // The state timeline has the same failure mode but was never swept: a
  // stream dying mid-drive while Sentry keeps the car "online" leaves the
  // open 'driving'/'charging'/'updating' row untouched (the cron
  // connectivity check defers to it), and whenever data finally resumes the
  // row closes at that far-future ts -- a multi-day phantom span in the
  // permanent timeline (same family as the historical 70h 'driving' entry).
  // Close any such row older than the cutoff at the vin's last-heard-from
  // time; the next real signal simply opens a fresh row.
  let closedStates = 0;
  const staleStates = await env.DB.prepare(
    `SELECT id, vin, state, start_ts FROM vehicle_states
     WHERE end_ts IS NULL AND state IN ('driving','charging','updating') AND start_ts < ?1`,
  ).bind(cutoff).all<{ id: number; vin: string; state: string; start_ts: number }>();
  for (const s of staleStates.results ?? []) {
    const latest = await getLatest(env, s.vin).catch(() => null);
    const lastHeard = Math.min(
      Math.max(s.start_ts, num(latest?.updated_at) ?? s.start_ts),
      Math.floor(Date.now() / 1000),
    );
    if (lastHeard >= cutoff) continue; // still receiving data -- not stale, leave it
    await env.DB.prepare(`UPDATE vehicle_states SET end_ts = ?2 WHERE id = ?1 AND end_ts IS NULL`)
      .bind(s.id, lastHeard).run();
    closedStates++;
  }

  return { closed_drives: closedDrives, closed_charges: closedCharges, closed_states: closedStates };
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
