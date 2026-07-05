/**
 * Driving-behaviour scoring — turns a drive's position samples into
 * insurance-style metrics (harsh braking/acceleration, cornering, speeding,
 * night driving) and a 0–100 composite score (100 = safest).
 *
 * Longitudinal acceleration is DERIVED from consecutive speed samples
 * (a = Δv/Δt), since Tesla's REST vehicle_data exposes no accelerometer.
 * Accuracy therefore scales with polling cadence: at 60 s between samples a
 * real 3-second hard brake is smeared out and undetectable; ~10 s polling
 * gives a rough proxy; only ~1 s Fleet Telemetry (or a native acceleration
 * signal) makes true per-event g-force reliable. The engine is cadence-
 * agnostic — feed it whatever samples exist and it reports what they support;
 * `samples_per_km` on the result tells you how much to trust the harsh counts.
 */

export interface BehaviorSample {
  ts: number; // unix seconds
  speed: number | null; // km/h
  heading?: number | null; // degrees
}

export interface BehaviorMetrics {
  max_accel_ms2: number | null;
  max_decel_ms2: number | null; // positive magnitude
  harsh_accel_count: number;
  harsh_brake_count: number;
  harsh_turn_count: number;
  over_limit_frac: number | null;
  night_frac: number | null;
  behavior_score: number | null;
  samples_per_km: number | null; // fidelity hint
  usable_pairs: number;
}

// Telematics thresholds (1 g = 9.81 m/s²). ~0.25–0.3 g is the industry line
// for a "harsh" event.
const HARSH_ACCEL = 2.5; // m/s²
const HARSH_BRAKE = 3.0; // m/s²
const HARSH_TURN_DEG_PER_S = 12; // heading change rate at speed
const TURN_MIN_SPEED = 25; // km/h — ignore heading swings while crawling/parking
const OVER_SPEED_KMH = 120; // configurable "speeding" line
const MAX_GAP_S = 300; // ignore pairs across a telemetry gap
const NIGHT_START = 22;
const NIGHT_END = 6;

const KMH_TO_MS = 1 / 3.6;

/** Smallest signed angle between two headings, degrees (−180..180). */
function headingDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

export function scoreDrive(
  samples: BehaviorSample[],
  opts: { distanceKm?: number | null; tzOffsetMin?: number } = {},
): BehaviorMetrics {
  const empty: BehaviorMetrics = {
    max_accel_ms2: null, max_decel_ms2: null,
    harsh_accel_count: 0, harsh_brake_count: 0, harsh_turn_count: 0,
    over_limit_frac: null, night_frac: null, behavior_score: null,
    samples_per_km: null, usable_pairs: 0,
  };
  const pts = samples.filter((s) => typeof s.speed === "number").sort((a, b) => a.ts - b.ts);
  if (pts.length < 2) return empty;

  let maxAccel = 0, maxDecel = 0, harshAccel = 0, harshBrake = 0, harshTurn = 0;
  let overCount = 0, speedCount = 0, usable = 0;
  const tz = opts.tzOffsetMin ?? 0;

  for (const p of pts) {
    speedCount++;
    if ((p.speed as number) > OVER_SPEED_KMH) overCount++;
  }

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const dt = b.ts - a.ts;
    if (dt <= 0 || dt > MAX_GAP_S) continue;
    usable++;
    const accel = ((b.speed as number) - (a.speed as number)) * KMH_TO_MS / dt; // m/s²
    if (accel > 0) {
      if (accel > maxAccel) maxAccel = accel;
      if (accel >= HARSH_ACCEL) harshAccel++;
    } else if (accel < 0) {
      const decel = -accel;
      if (decel > maxDecel) maxDecel = decel;
      if (decel >= HARSH_BRAKE) harshBrake++;
    }
    if (typeof a.heading === "number" && typeof b.heading === "number" && (b.speed as number) >= TURN_MIN_SPEED) {
      const rate = Math.abs(headingDelta(a.heading, b.heading)) / dt;
      if (rate >= HARSH_TURN_DEG_PER_S) harshTurn++;
    }
  }

  // Night fraction from sample timestamps in local time.
  let nightSamples = 0;
  for (const p of pts) {
    const localHour = Math.floor((((p.ts / 3600 + tz / 60) % 24) + 24) % 24);
    if (localHour >= NIGHT_START || localHour < NIGHT_END) nightSamples++;
  }
  const nightFrac = pts.length ? nightSamples / pts.length : null;
  const overFrac = speedCount ? overCount / speedCount : null;
  const distKm = opts.distanceKm && opts.distanceKm > 0 ? opts.distanceKm : null;
  const per100 = (n: number) => (distKm ? (n / distKm) * 100 : n);

  // Composite: start at 100, deduct for risk signals. Weights are a sensible
  // default telematics profile; harsh-event weights only bite with fast data.
  let score = 100;
  score -= Math.min(30, per100(harshBrake) * 6);
  score -= Math.min(20, per100(harshAccel) * 4);
  score -= Math.min(15, per100(harshTurn) * 3);
  score -= Math.min(20, (overFrac ?? 0) * 100 * 0.8);
  score -= Math.min(10, (nightFrac ?? 0) * 100 * 0.15);
  score -= Math.min(15, Math.max(0, maxDecel - HARSH_BRAKE) * 3);
  score = Math.max(0, Math.round(score));

  return {
    max_accel_ms2: round(maxAccel, 2),
    max_decel_ms2: round(maxDecel, 2),
    harsh_accel_count: harshAccel,
    harsh_brake_count: harshBrake,
    harsh_turn_count: harshTurn,
    over_limit_frac: overFrac === null ? null : round(overFrac, 4),
    night_frac: nightFrac === null ? null : round(nightFrac, 4),
    behavior_score: score,
    samples_per_km: distKm ? round(pts.length / distKm, 2) : null,
    usable_pairs: usable,
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
