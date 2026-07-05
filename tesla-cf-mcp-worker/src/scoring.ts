/**
 * Driving-behaviour scoring — turns a drive's samples into insurance-style
 * metrics and a 0–100 score (100 = safest), with the rigour an actuary needs:
 *
 *  - Longitudinal/lateral acceleration use the REAL onboard IMU
 *    (lon_accel/lat_accel from Fleet Telemetry) when present; otherwise they
 *    fall back to the Δv/Δt (and heading-rate) proxy the REST poller must
 *    derive. `accel_source` records which was used.
 *  - Speeding is measured against the ACTUAL posted limit per sample (OSM
 *    maxspeed via roadlimits.ts) when available, not a flat line; both the
 *    fraction over and the average severity (km/h over) are reported.
 *  - "Night" is astronomical darkness at the drive's own lat/lon (solar.ts),
 *    not a fixed clock window.
 *  - The score carries a CONFIDENCE INTERVAL: at coarse sampling, harsh events
 *    are undercounted, so the true score could be lower than observed. We
 *    estimate a detection probability from the sampling cadence and widen the
 *    band accordingly (real IMU ⇒ tight band, high confidence).
 */

import { isNight } from "./solar";

export interface BehaviorSample {
  ts: number; // unix seconds
  speed: number | null; // km/h
  heading?: number | null; // degrees
  lat?: number | null;
  lon?: number | null;
  lon_accel?: number | null; // real longitudinal accel, m/s² (+ accel, − brake)
  lat_accel?: number | null; // real lateral accel, m/s²
}

export interface BehaviorMetrics {
  max_accel_ms2: number | null;
  max_decel_ms2: number | null; // positive magnitude
  max_lat_accel_ms2: number | null;
  max_jerk_ms3: number | null;
  harsh_accel_count: number;
  harsh_brake_count: number;
  harsh_turn_count: number;
  over_limit_frac: number | null;
  over_limit_severity: number | null; // avg km/h over the posted limit while over
  speed_limit_source: "osm" | "partial" | "none";
  night_frac: number | null;
  behavior_score: number | null;
  score_low: number | null;
  score_high: number | null;
  score_confidence: "high" | "medium" | "low" | null;
  accel_source: "imu" | "derived";
  samples_per_km: number | null;
  usable_pairs: number;
}

// Telematics thresholds (1 g = 9.81 m/s²). ~0.25–0.3 g is the industry line.
const HARSH_ACCEL = 2.5; // m/s²
const HARSH_BRAKE = 3.0; // m/s²
const HARSH_LAT = 3.5; // m/s² lateral (real cornering g)
const HARSH_TURN_DEG_PER_S = 12; // heading-change proxy when no IMU
const TURN_MIN_SPEED = 25; // km/h
const FALLBACK_LIMIT_KMH = 120; // used only where no posted limit is known
const OVER_TOLERANCE = 5; // km/h grace over the posted limit before it counts
const MAX_GAP_S = 300;
const EVENT_S = 3; // a harsh event lasts ~3s — the basis for detection probability
const KMH_TO_MS = 1 / 3.6;

function headingDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

interface ScoreOpts {
  distanceKm?: number | null;
  tzOffsetMin?: number;
  /** Posted limit (km/h) per sample, aligned to `samples`; null where unknown. */
  postedLimits?: Array<number | null>;
  speedLimitSource?: "osm" | "partial" | "none";
}

export function scoreDrive(samples: BehaviorSample[], opts: ScoreOpts = {}): BehaviorMetrics {
  const empty: BehaviorMetrics = {
    max_accel_ms2: null, max_decel_ms2: null, max_lat_accel_ms2: null, max_jerk_ms3: null,
    harsh_accel_count: 0, harsh_brake_count: 0, harsh_turn_count: 0,
    over_limit_frac: null, over_limit_severity: null, speed_limit_source: opts.speedLimitSource ?? "none",
    night_frac: null, behavior_score: null, score_low: null, score_high: null,
    score_confidence: null, accel_source: "derived", samples_per_km: null, usable_pairs: 0,
  };
  // Keep original indices so postedLimits stay aligned after the speed filter.
  const idx = samples.map((s, i) => i).filter((i) => typeof samples[i]!.speed === "number");
  const pts = idx.map((i) => samples[i]!);
  if (pts.length < 2) return empty;
  const limitAt = (origI: number): number | null => opts.postedLimits?.[origI] ?? null;

  const hasImu = pts.some((p) => typeof p.lon_accel === "number");
  const accelSource: "imu" | "derived" = hasImu ? "imu" : "derived";

  let maxAccel = 0, maxDecel = 0, maxLat = 0, maxJerk = 0;
  let harshAccel = 0, harshBrake = 0, harshTurn = 0;
  let overCount = 0, overExcessSum = 0, speedCount = 0, usable = 0;
  let prevAccel: number | null = null, prevPairEndTs: number | null = null;
  const tz = opts.tzOffsetMin ?? 0;
  const dts: number[] = [];

  // Speeding vs the posted limit (per sample).
  for (let k = 0; k < pts.length; k++) {
    const sp = pts[k]!.speed as number;
    speedCount++;
    const limit = limitAt(idx[k]!) ?? FALLBACK_LIMIT_KMH;
    const excess = sp - (limit + OVER_TOLERANCE);
    if (excess > 0) { overCount++; overExcessSum += excess; }
    // Real lateral g (cornering) when present.
    const la = pts[k]!.lat_accel;
    if (typeof la === "number") {
      const mag = Math.abs(la);
      if (mag > maxLat) maxLat = mag;
      if (mag >= HARSH_LAT) harshTurn++;
    }
  }

  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1]!, b = pts[k]!;
    const dt = b.ts - a.ts;
    if (dt <= 0 || dt > MAX_GAP_S) { prevAccel = null; continue; }
    usable++;
    dts.push(dt);

    // Prefer real IMU longitudinal accel; else derive from Δv/Δt.
    let accel: number;
    if (hasImu && typeof b.lon_accel === "number") {
      accel = b.lon_accel;
    } else {
      accel = ((b.speed as number) - (a.speed as number)) * KMH_TO_MS / dt;
    }
    if (prevAccel !== null && prevPairEndTs === a.ts) {
      const jerk = Math.abs(accel - prevAccel) / dt;
      if (jerk > maxJerk) maxJerk = jerk;
    }
    prevAccel = accel; prevPairEndTs = b.ts;
    if (accel > 0) {
      if (accel > maxAccel) maxAccel = accel;
      if (accel >= HARSH_ACCEL) harshAccel++;
    } else if (accel < 0) {
      const decel = -accel;
      if (decel > maxDecel) maxDecel = decel;
      if (decel >= HARSH_BRAKE) harshBrake++;
    }
    // Cornering proxy whenever THIS sample lacks real lateral g — per-sample,
    // not drive-wide. lon_accel/lat_accel stream independently, so a drive with
    // IMU can still have per-sample lateral-g gaps; the lateral-g loop above
    // already counts samples that DO have lat_accel, so gating here on its
    // absence means at most one of {measured, proxy} fires per sample (no
    // double-count, no silent gap).
    if (typeof b.lat_accel !== "number" && typeof a.heading === "number" && typeof b.heading === "number" && (b.speed as number) >= TURN_MIN_SPEED) {
      const rate = Math.abs(headingDelta(a.heading, b.heading)) / dt;
      if (rate >= HARSH_TURN_DEG_PER_S) harshTurn++;
    }
  }

  // Night fraction — astronomical (solar) when we have coordinates, else tz clock.
  let nightSamples = 0, nightDenom = 0;
  for (const p of pts) {
    nightDenom++;
    if (typeof p.lat === "number" && typeof p.lon === "number") {
      if (isNight(p.lat, p.lon, p.ts)) nightSamples++;
    } else {
      const localHour = Math.floor((((p.ts / 3600 + tz / 60) % 24) + 24) % 24);
      if (localHour >= 22 || localHour < 6) nightSamples++;
    }
  }
  const nightFrac = nightDenom ? nightSamples / nightDenom : null;
  const overFrac = speedCount ? overCount / speedCount : null;
  const overSeverity = overCount ? overExcessSum / overCount : null;
  const distKm = opts.distanceKm && opts.distanceKm > 0 ? opts.distanceKm : null;
  const per100 = (n: number) => (distKm ? (n / distKm) * 100 : n);

  // Composite score from a set of (possibly inflated) event counts.
  const composite = (hb: number, ha: number, ht: number): number => {
    let score = 100;
    score -= Math.min(30, per100(hb) * 6);
    score -= Math.min(20, per100(ha) * 4);
    score -= Math.min(15, per100(ht) * 3);
    score -= Math.min(20, (overFrac ?? 0) * 100 * 0.8);
    score -= Math.min(10, (nightFrac ?? 0) * 100 * 0.15);
    score -= Math.min(15, Math.max(0, maxDecel - HARSH_BRAKE) * 3);
    return Math.max(0, Math.round(score));
  };

  const observed = composite(harshBrake, harshAccel, harshTurn);

  // Detection probability from cadence: a ~3s event is caught with prob
  // ≈ EVENT_S / sample_interval (capped at 1). Real IMU measures g directly ⇒ 1.
  const medianDt = dts.length ? dts.slice().sort((a, b) => a - b)[Math.floor(dts.length / 2)]! : EVENT_S;
  const p = hasImu ? 1 : Math.max(0.05, Math.min(1, EVENT_S / Math.max(EVENT_S, medianDt)));
  // Worst case: events we could have missed (observed / p) → lower score.
  const scoreLow = p >= 0.999 ? observed : composite(harshBrake / p, harshAccel / p, harshTurn / p);
  const confidence: "high" | "medium" | "low" = p >= 0.8 ? "high" : p >= 0.3 ? "medium" : "low";

  return {
    max_accel_ms2: round(maxAccel, 2),
    max_decel_ms2: round(maxDecel, 2),
    max_lat_accel_ms2: maxLat > 0 ? round(maxLat, 2) : null,
    max_jerk_ms3: maxJerk > 0 ? round(maxJerk, 3) : null,
    harsh_accel_count: harshAccel,
    harsh_brake_count: harshBrake,
    harsh_turn_count: harshTurn,
    over_limit_frac: overFrac === null ? null : round(overFrac, 4),
    over_limit_severity: overSeverity === null ? null : round(overSeverity, 1),
    speed_limit_source: opts.speedLimitSource ?? "none",
    night_frac: nightFrac === null ? null : round(nightFrac, 4),
    behavior_score: observed,
    score_low: scoreLow,
    score_high: observed,
    score_confidence: confidence,
    accel_source: accelSource,
    samples_per_km: distKm ? round(pts.length / distKm, 2) : null,
    usable_pairs: usable,
  };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
