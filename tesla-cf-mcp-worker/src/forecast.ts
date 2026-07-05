/**
 * Forward-looking prediction — turns the backward-looking derivations into
 * forecasts:
 *   - getBatteryForecast: projects the degradation slope + odometer-accrual
 *     rate against the Model 3/Y 8-year / distance / 70%-retention warranty to
 *     answer "which cap binds first, and when".
 *   - predictRange: a small ordinary-least-squares model of efficiency vs
 *     ambient temp + average speed (+ per-driver offset), fit on the logged
 *     drives, so a candidate trip returns an expected Wh/km, kWh and SoC used.
 *
 * All math is closed-form on data already in D1 — no new collection, $0.
 */

import { ensureSchema } from "./store";
import { Env } from "./types";

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// --- battery / warranty forecast -------------------------------------------

const YEAR_S = 365.25 * 86400;
// Tesla Model 3/Y battery warranty: 8 years, 70% minimum retention. Distance
// cap varies by pack (Standard 160,000 km; Long Range/Performance 192,000 km).
const WARRANTY_YEARS = 8;
const WARRANTY_FLOOR_PCT = 70;

export async function getBatteryForecast(env: Env, vin: string, warrantyKm = 192_000): Promise<unknown> {
  await ensureSchema(env);
  // Degradation points: projected range at 100% from clean-ish charge endings.
  const rs = await env.DB.prepare(
    `SELECT end_ts AS ts, end_soc, end_rated_range
     FROM charge_sessions
     WHERE vin = ?1 AND status = 'complete' AND end_soc > 50 AND end_rated_range > 0
     ORDER BY end_ts ASC`,
  )
    .bind(vin)
    .all<{ ts: number; end_soc: number; end_rated_range: number }>();
  const pts = (rs.results ?? []).map((r) => ({ x: r.ts, y: (r.end_rated_range / r.end_soc) * 100 }));

  // Odometer accrual rate from completed drives.
  const odo = await env.DB.prepare(
    `SELECT MIN(start_ts) AS t0, MAX(end_ts) AS t1, MIN(start_odometer) AS o0, MAX(end_odometer) AS o1
     FROM drives WHERE vin = ?1 AND status = 'complete' AND end_odometer IS NOT NULL`,
  )
    .bind(vin)
    .first<{ t0: number | null; t1: number | null; o0: number | null; o1: number | null }>();

  const nowTs = Math.floor(Date.now() / 1000);
  let kmPerYear: number | null = null;
  let currentOdo: number | null = odo?.o1 ?? null;
  if (odo && odo.t0 && odo.t1 && odo.o0 != null && odo.o1 != null && odo.t1 > odo.t0) {
    const km = odo.o1 - odo.o0;
    const yrs = (odo.t1 - odo.t0) / YEAR_S;
    if (yrs > 0.02 && km > 0) kmPerYear = km / yrs;
  }

  // Least-squares slope of projected range vs time.
  let slopePctPerYear: number | null = null;
  let r2: number | null = null;
  let currentPct: number | null = null;
  if (pts.length >= 3) {
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p.x, 0) / n;
    const my = pts.reduce((s, p) => s + p.y, 0) / n;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); syy += (p.y - my) ** 2; }
    if (sxx > 0 && syy > 0) {
      const slope = sxy / sxx; // km per second
      r2 = round((sxy * sxy) / (sxx * syy), 3);
      const baseline = pts[0]!.y; // ≈ range at 100% when new (first observation)
      const latest = pts[n - 1]!.y;
      currentPct = round((latest / baseline) * 100, 1);
      slopePctPerYear = round((-slope * YEAR_S / baseline) * 100, 2); // +ve = losing %/yr
    }
  }

  // Warranty start: optional KV override, else earliest data we have (a lower
  // bound — the real in-service date is likely earlier, so time-remaining is
  // optimistic and flagged).
  const startOverride = Number((await env.TESLA_KV.get(`warranty_start:${vin}`).catch(() => null)) ?? "");
  const warrantyStart = Number.isFinite(startOverride) && startOverride > 0 ? startOverride : (odo?.t0 ?? null);

  const cliff: Record<string, unknown> = { binding: "none", years_remaining: null };
  const candidates: Array<{ kind: string; years: number }> = [];
  // Time cap.
  if (warrantyStart) {
    const yrsElapsed = (nowTs - warrantyStart) / YEAR_S;
    candidates.push({ kind: "time", years: Math.max(0, WARRANTY_YEARS - yrsElapsed) });
  }
  // Odometer cap.
  if (currentOdo != null && kmPerYear && kmPerYear > 0) {
    candidates.push({ kind: "odometer", years: Math.max(0, (warrantyKm - currentOdo) / kmPerYear) });
  }
  // Health floor (when projected % crosses 70).
  if (currentPct != null && slopePctPerYear && slopePctPerYear > 0) {
    candidates.push({ kind: "health", years: Math.max(0, (currentPct - WARRANTY_FLOOR_PCT) / slopePctPerYear) });
  }
  if (candidates.length) {
    const soonest = candidates.reduce((a, b) => (b.years < a.years ? b : a));
    cliff.binding = soonest.kind;
    cliff.years_remaining = round(soonest.years, 1);
    cliff.all = candidates.map((c) => ({ kind: c.kind, years_remaining: round(c.years, 1) }));
    cliff.warranty_start_known = Boolean(startOverride);
  }

  // 5-year health projection.
  const projected: Array<{ year: number; pct: number }> = [];
  if (currentPct != null && slopePctPerYear != null) {
    for (let y = 0; y <= 5; y++) projected.push({ year: y, pct: round(Math.max(0, currentPct - slopePctPerYear * y), 1) });
  }

  return {
    vin,
    current_pct: currentPct,
    slope_pct_per_year: slopePctPerYear,
    r2,
    samples: pts.length,
    odometer_km: currentOdo != null ? round(currentOdo, 0) : null,
    km_per_year: kmPerYear != null ? round(kmPerYear, 0) : null,
    warranty: { years: WARRANTY_YEARS, km: warrantyKm, floor_pct: WARRANTY_FLOOR_PCT, start_ts: warrantyStart },
    cliff,
    projected_pct: projected,
    note:
      pts.length < 3
        ? "Need at least three charges above 50% to project degradation."
        : (cliff as { warranty_start_known?: boolean }).warranty_start_known
          ? "Forecast from your logged degradation + mileage rate."
          : "Warranty time-remaining assumes in-service = first logged data (a lower bound; set warranty_start:VIN in KV for accuracy).",
  };
}

// --- range predictor (OLS) --------------------------------------------------

/** Solves a small linear system A·x = b by Gaussian elimination (k ≤ ~6). */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-9) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    const pv = M[col]![col]!;
    for (let c = col; c <= n; c++) M[col]![c]! /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r]![col]!;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  return M.map((row) => row[n]!);
}

interface RangeModel {
  coefficients: { intercept: number; temp: number; speed: number };
  r2: number;
  n: number;
  driver_offsets: Record<string, number>;
  global_wh_km: number;
}

/** Fits efficiency_wh_km ~ 1 + outside_temp_avg + avg_speed over logged drives. */
export async function fitRangeModel(env: Env, vin: string): Promise<RangeModel | null> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT efficiency_wh_km AS y, outside_temp_avg AS t, avg_speed AS s, driver
     FROM drives
     WHERE vin = ?1 AND status = 'complete' AND distance_km >= 2
       AND efficiency_wh_km IS NOT NULL AND efficiency_wh_km BETWEEN 80 AND 500
       AND outside_temp_avg IS NOT NULL AND avg_speed IS NOT NULL`,
  )
    .bind(vin)
    .all<{ y: number; t: number; s: number; driver: string | null }>();
  const rows = rs.results ?? [];
  const globalWhKm = rows.length ? rows.reduce((a, r) => a + r.y, 0) / rows.length : 160;
  if (rows.length < 8) return { coefficients: { intercept: globalWhKm, temp: 0, speed: 0 }, r2: 0, n: rows.length, driver_offsets: {}, global_wh_km: round(globalWhKm, 0) };

  // Normal equations for [1, t, s].
  const X = rows.map((r) => [1, r.t, r.s]);
  const y = rows.map((r) => r.y);
  const XtX = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const Xty = [0, 0, 0];
  for (let k = 0; k < rows.length; k++) {
    for (let i = 0; i < 3; i++) {
      Xty[i]! += X[k]![i]! * y[k]!;
      for (let j = 0; j < 3; j++) XtX[i]![j]! += X[k]![i]! * X[k]![j]!;
    }
  }
  const beta = solve(XtX, Xty);
  if (!beta) return { coefficients: { intercept: round(globalWhKm, 1), temp: 0, speed: 0 }, r2: 0, n: rows.length, driver_offsets: {}, global_wh_km: round(globalWhKm, 0) };

  // R².
  const my = y.reduce((a, v) => a + v, 0) / y.length;
  let ssRes = 0, ssTot = 0;
  const pred = (t: number, s: number) => beta[0]! + beta[1]! * t + beta[2]! * s;
  for (let k = 0; k < rows.length; k++) {
    ssRes += (y[k]! - pred(rows[k]!.t, rows[k]!.s)) ** 2;
    ssTot += (y[k]! - my) ** 2;
  }
  const r2 = ssTot > 0 ? round(1 - ssRes / ssTot, 3) : 0;

  // Per-driver mean residual (their efficiency offset vs the model).
  const dacc = new Map<string, { sum: number; n: number }>();
  for (let k = 0; k < rows.length; k++) {
    const d = rows[k]!.driver;
    if (!d) continue;
    const res = y[k]! - pred(rows[k]!.t, rows[k]!.s);
    const cur = dacc.get(d) ?? { sum: 0, n: 0 };
    cur.sum += res; cur.n += 1; dacc.set(d, cur);
  }
  const driver_offsets: Record<string, number> = {};
  for (const [d, v] of dacc) if (v.n >= 3) driver_offsets[d] = round(v.sum / v.n, 1);

  return {
    coefficients: { intercept: round(beta[0]!, 2), temp: round(beta[1]!, 3), speed: round(beta[2]!, 3) },
    r2, n: rows.length, driver_offsets, global_wh_km: round(globalWhKm, 0),
  };
}

export async function predictRange(
  env: Env,
  vin: string,
  opts: { distance_km?: number; temp_c?: number; driver?: string; elevation_gain_m?: number },
): Promise<unknown> {
  const model = await fitRangeModel(env, vin);
  if (!model) return { vin, ready: false, note: "No efficiency data yet." };
  const ready = model.n >= 8 && model.r2 > 0;
  const temp = opts.temp_c ?? 20;
  // Assume a typical mixed-driving average speed if not derivable.
  const speed = 45;
  let whKm = ready
    ? model.coefficients.intercept + model.coefficients.temp * temp + model.coefficients.speed * speed
    : model.global_wh_km;
  if (opts.driver && model.driver_offsets[opts.driver] != null) whKm += model.driver_offsets[opts.driver]!;
  // Elevation: ~ +? Wh per m climbed per km is complex; apply a light net-gain term.
  if (opts.elevation_gain_m && opts.distance_km && opts.distance_km > 0) {
    whKm += (opts.elevation_gain_m * 2.7) / opts.distance_km; // ~2.7 Wh per metre climbed (mgh @ ~85% eff, 2-ton car)
  }
  whKm = Math.max(80, Math.min(600, whKm));

  const out: Record<string, unknown> = {
    vin,
    ready,
    predicted_wh_km: round(whKm, 0),
    model: { r2: model.r2, n: model.n, coefficients: model.coefficients },
    note: ready
      ? "Predicted from your logged efficiency vs temperature & speed."
      : "Not enough drives yet for a fitted model — showing your average efficiency.",
  };
  if (opts.distance_km && opts.distance_km > 0) {
    const kwh = (whKm * opts.distance_km) / 1000;
    out.distance_km = opts.distance_km;
    out.predicted_kwh = round(kwh, 1);
    const pack = Number((await env.TESLA_KV.get(`pack_kwh:${vin}`).catch(() => null)) ?? "");
    if (Number.isFinite(pack) && pack > 0) out.predicted_soc_used_pct = round((kwh / pack) * 100, 1);
  }
  return out;
}
