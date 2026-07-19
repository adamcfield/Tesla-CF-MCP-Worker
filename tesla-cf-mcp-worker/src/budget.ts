/**
 * Tesla Fleet API spend governor.
 *
 * Tesla gives each developer account a $10/month credit and — with no payment
 * method on file — a $0 billing limit above it: exceeding the credit DISABLES
 * the app until the next cycle (and wipes any Fleet Telemetry configs), it
 * does not accrue a bill. So the goal here isn't to avoid charges (those are
 * structurally impossible) but to never hit Tesla's hard disable: we self-
 * track spend (Tesla exposes no usage API) and stop AUTOMATED polling at a
 * soft cap well under $10, keeping headroom for user-initiated commands.
 *
 * Prices (Tesla "Billing and Limits", 2026): vehicle_data $1/500, signed
 * command $1/1,000, wake $1/50, telemetry signal $1/150,000. The vehicle-list/
 * single-vehicle state endpoints and auth/partner endpoints are not billed.
 *
 * Amounts are tracked in integer micro-dollars to avoid float drift. The
 * ledger lives in D1 (atomic `UPDATE … SET micro = micro + n`, no KV
 * read-modify-write race, no KV write-cap pressure at burst cadence); a
 * legacy KV counter is folded in once on first read so mid-month deploys
 * don't reset the month's accounting.
 *
 * Defense-in-depth: if Tesla ever answers 403 EXCEEDED_LIMIT (i.e. our ledger
 * under-counted and the real meter hit $10), forceBudgetCeiling() pins the
 * month at the hard ceiling so every gate closes immediately.
 */

import { getAppState, putAppState } from "./store";
import { Env } from "./types";

export const COST_MICRO = {
  vehicle_data: 2_000, // $0.002
  command: 1_000, // $0.001
  wake: 20_000, // $0.02
  signal: 7, // ~$0.0000067
} as const;
export type BillableKind = keyof typeof COST_MICRO;

/** Automated polling stops here (micro-dollars). Override with BUDGET_POLL_USD. */
const DEFAULT_POLL_BUDGET = 9_000_000; // $9.00 — use most of the free $10 credit
/** Absolute ceiling for ALL tracked spend, kept just under Tesla's $10 disable line ($9.70). */
export const HARD_CEILING = 9_700_000;

const monthKey = (): string => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

const dayKey = (d: Date = new Date()): string => {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

/**
 * The spend tables are (re)ensured on every call rather than guarded by a
 * per-isolate flag: a flag would leak across the many fresh in-memory DBs in
 * tests, and in production CREATE TABLE IF NOT EXISTS is a trivial no-op.
 * The one-time legacy KV → D1 fold-in only runs on the READ path (spentMicro)
 * — gates read through there, so ordering is safe.
 *
 * api_spend_daily buckets the same spend by UTC day (in addition to the
 * month total in api_spend) purely so getBudgetForecast has a time series to
 * regress against — the month total alone can't say whether spend is
 * accelerating or flat.
 *
 * api_spend_calls further splits the daily bucket by billable kind
 * (vehicle_data/command/wake/signal) — one row per (day, kind), not one row
 * per HTTP call (telemetry signals alone would be thousands/day; this stays
 * a handful of rows/day forever) — so a "what are we actually spending on"
 * breakdown is answerable without a growing raw call log.
 */
async function ensureSpendTable(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS api_spend (month TEXT PRIMARY KEY, micro INTEGER NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS api_spend_daily (day TEXT PRIMARY KEY, micro INTEGER NOT NULL)`),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS api_spend_calls (
         day TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, micro INTEGER NOT NULL,
         PRIMARY KEY (day, kind)
       )`,
    ),
  ]);
}

export async function recordSpend(env: Env, kind: BillableKind, count = 1): Promise<void> {
  try {
    await ensureSpendTable(env);
    const micro = COST_MICRO[kind] * count;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO api_spend (month, micro) VALUES (?1, ?2)
         ON CONFLICT(month) DO UPDATE SET micro = micro + excluded.micro`,
      ).bind(monthKey(), micro),
      env.DB.prepare(
        `INSERT INTO api_spend_daily (day, micro) VALUES (?1, ?2)
         ON CONFLICT(day) DO UPDATE SET micro = micro + excluded.micro`,
      ).bind(dayKey(), micro),
      env.DB.prepare(
        `INSERT INTO api_spend_calls (day, kind, count, micro) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(day, kind) DO UPDATE SET count = count + excluded.count, micro = micro + excluded.micro`,
      ).bind(dayKey(), kind, count, micro),
    ]);
  } catch {
    // Accounting must never break the actual operation.
  }
}

/**
 * Pins this month's ledger at the hard ceiling — called when Tesla itself
 * reports 403 EXCEEDED_LIMIT, meaning the real meter is past the credit
 * regardless of what we counted. Every budget gate closes until the 1st.
 */
export async function forceBudgetCeiling(env: Env): Promise<void> {
  try {
    await ensureSpendTable(env);
    await env.DB.prepare(
      `INSERT INTO api_spend (month, micro) VALUES (?1, ?2)
       ON CONFLICT(month) DO UPDATE SET micro = MAX(micro, excluded.micro)`,
    )
      .bind(monthKey(), HARD_CEILING)
      .run();
  } catch {
    /* best effort */
  }
}

async function spentMicro(env: Env): Promise<number> {
  await ensureSpendTable(env);
  const month = monthKey();
  // One-time fold-in of the legacy KV counter (pre-D1 deployments), so a
  // mid-month deploy doesn't reset the month's accounting. The migration
  // marker is set ONLY after a SUCCESSFUL KV read — a transient KV error must
  // not permanently drop pre-deploy spend (which would re-open a fresh $9 of
  // headroom on top of Tesla's real meter). The MAX() upsert is idempotent,
  // so retrying the fold-in across calls is safe.
  const marker = `spend_migrated:${month}`;
  if (!(await getAppState(env, marker))) {
    let legacyRaw: string | null = null;
    let kvReadOk = true;
    try {
      legacyRaw = await env.TESLA_KV.get(`api_spend:${month}`);
    } catch {
      kvReadOk = false;
    }
    if (kvReadOk) {
      const legacy = Number(legacyRaw ?? "0");
      if (Number.isFinite(legacy) && legacy > 0) {
        await env.DB.prepare(
          `INSERT INTO api_spend (month, micro) VALUES (?1, ?2)
           ON CONFLICT(month) DO UPDATE SET micro = MAX(micro, excluded.micro)`,
        )
          .bind(month, Math.round(legacy))
          .run();
      }
      await putAppState(env, marker, "1");
    }
  }
  const row = await env.DB.prepare(`SELECT micro FROM api_spend WHERE month = ?1`)
    .bind(month)
    .first<{ micro: number }>();
  return row?.micro ?? 0;
}

export interface BudgetStatus {
  month: string;
  spent_usd: number;
  spent_micro: number;
  poll_budget_usd: number;
  hard_ceiling_usd: number;
  poll_allowed: boolean;
  commands_allowed: boolean;
}

export function pollBudgetMicro(env: Env): number {
  const configured = Number(env.BUDGET_POLL_USD ?? "");
  return Number.isFinite(configured) && configured > 0
    ? Math.min(Math.round(configured * 1_000_000), HARD_CEILING)
    : DEFAULT_POLL_BUDGET;
}

export async function getBudgetStatus(env: Env): Promise<BudgetStatus> {
  // FAIL CLOSED: if the ledger can't be read (D1 outage), assume we're at the
  // ceiling so every gate closes and no billed read/command proceeds blind.
  // A transient blip just skips a poll cycle — far safer than fail-open, which
  // would bill at max rate with zero accounting during the outage.
  const spent = await spentMicro(env).catch(() => HARD_CEILING);
  const pollBudget = pollBudgetMicro(env);
  return {
    month: monthKey(),
    spent_usd: Math.round(spent / 10_000) / 100,
    spent_micro: spent,
    poll_budget_usd: pollBudget / 1_000_000,
    hard_ceiling_usd: HARD_CEILING / 1_000_000,
    poll_allowed: spent < pollBudget,
    commands_allowed: spent < HARD_CEILING,
  };
}

// ---------------------------------------------------------------------------
// Call log — per-day/per-kind spend breakdown for the "what are we spending
// on" drill-down (the sidebar widget only shows the running total).
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<BillableKind, string> = {
  vehicle_data: "Vehicle data read",
  command: "Command",
  wake: "Wake",
  signal: "Telemetry signal",
};

export interface BudgetCallLogEntry {
  day: string;
  kind: BillableKind;
  label: string;
  count: number;
  cost_usd: number;
}

export interface BudgetCallLog {
  days: number;
  entries: BudgetCallLogEntry[]; // most recent day first
  by_kind: { kind: BillableKind; label: string; count: number; cost_usd: number }[];
  total_cost_usd: number;
}

/** Per-day/per-kind spend breakdown over the trailing `days` — how the running total was actually earned. */
export async function getBudgetCallLog(env: Env, days = 30): Promise<BudgetCallLog> {
  await ensureSpendTable(env);
  const sinceDay = dayKey(new Date(Date.now() - days * 86400_000));
  const rs = await env.DB.prepare(
    `SELECT day, kind, count, micro FROM api_spend_calls WHERE day >= ?1 ORDER BY day DESC, micro DESC`,
  )
    .bind(sinceDay)
    .all<{ day: string; kind: BillableKind; count: number; micro: number }>();
  const rows = rs.results ?? [];

  const entries = rows.map((r) => ({
    day: r.day,
    kind: r.kind,
    label: KIND_LABEL[r.kind] ?? r.kind,
    count: r.count,
    cost_usd: Math.round((r.micro / 10_000)) / 100,
  }));

  const byKindMicro = new Map<BillableKind, { count: number; micro: number }>();
  for (const r of rows) {
    const acc = byKindMicro.get(r.kind) ?? { count: 0, micro: 0 };
    acc.count += r.count;
    acc.micro += r.micro;
    byKindMicro.set(r.kind, acc);
  }
  const by_kind = [...byKindMicro.entries()]
    .map(([kind, acc]) => ({ kind, label: KIND_LABEL[kind] ?? kind, count: acc.count, cost_usd: Math.round((acc.micro / 10_000)) / 100 }))
    .sort((a, b) => b.cost_usd - a.cost_usd);

  return {
    days,
    entries,
    by_kind,
    total_cost_usd: Math.round((rows.reduce((s, r) => s + r.micro, 0) / 10_000)) / 100,
  };
}

// ---------------------------------------------------------------------------
// Forecast — regress this month's daily spend to project month-end totals,
// so a dashboard can answer "at this rate, will we run out before the 1st?"
// instead of only showing the running total.
// ---------------------------------------------------------------------------

export interface BudgetForecast {
  method: "regression" | "average" | "insufficient_data";
  days_elapsed: number;
  days_in_month: number;
  days_remaining: number;
  daily_rate_usd: number;
  projected_month_usd: number;
  projected_over_budget: boolean;
  budget_exhausted_in_days: number | null; // null = not projected to run out before month-end at current rate
}

async function dailySpendRows(env: Env, month: string): Promise<{ day: string; micro: number }[]> {
  await ensureSpendTable(env);
  const rs = await env.DB.prepare(
    `SELECT day, micro FROM api_spend_daily WHERE day LIKE ?1 ORDER BY day ASC`,
  )
    .bind(`${month}-%`)
    .all<{ day: string; micro: number }>();
  return rs.results ?? [];
}

function finishForecast(
  daysElapsed: number,
  daysInMonth: number,
  daysRemaining: number,
  dailyRateMicro: number,
  projectedMicro: number,
  spentMicroNow: number,
  budgetMicro: number,
  method: BudgetForecast["method"],
): BudgetForecast {
  const rate = Math.max(0, dailyRateMicro);
  let budgetExhaustedInDays: number | null = null;
  if (rate > 0) {
    const remaining = budgetMicro - spentMicroNow;
    const days = remaining <= 0 ? 0 : remaining / rate;
    if (days <= daysRemaining) budgetExhaustedInDays = Math.round(days * 10) / 10;
  }
  return {
    method,
    days_elapsed: daysElapsed,
    days_in_month: daysInMonth,
    days_remaining: daysRemaining,
    daily_rate_usd: Math.round((rate / 10_000)) / 100,
    projected_month_usd: Math.round((Math.max(projectedMicro, spentMicroNow) / 10_000)) / 100,
    projected_over_budget: Math.max(projectedMicro, spentMicroNow) > budgetMicro,
    budget_exhausted_in_days: budgetExhaustedInDays,
  };
}

/**
 * Projects this month's total spend from the daily buckets logged so far.
 * With ≥2 days of history, fits an ordinary-least-squares line through
 * cumulative spend vs day-of-month (same closed-form approach as the battery
 * degradation forecast in forecast.ts) and extrapolates to the last day of
 * the month; with 0–1 days of history it falls back to a flat average-rate
 * projection (or "insufficient_data" on day one, before any rate is knowable).
 */
export async function getBudgetForecast(env: Env): Promise<BudgetForecast> {
  const month = monthKey();
  const [y, m] = month.split("-").map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const daysElapsed = new Date().getUTCDate();
  const daysRemaining = Math.max(0, daysInMonth - daysElapsed);

  const status = await getBudgetStatus(env);
  const budgetMicro = pollBudgetMicro(env);
  const rows = await dailySpendRows(env, month).catch(() => []);

  if (rows.length < 2) {
    const dailyRate = daysElapsed > 0 ? status.spent_micro / daysElapsed : 0;
    const projected = status.spent_micro + dailyRate * daysRemaining;
    return finishForecast(
      daysElapsed, daysInMonth, daysRemaining, dailyRate, projected, status.spent_micro, budgetMicro,
      rows.length === 0 ? "insufficient_data" : "average",
    );
  }

  // OLS slope of cumulative spend vs day-of-month index.
  let cum = 0;
  const pts = rows.map((r) => {
    cum += r.micro;
    return { x: Number(r.day.slice(-2)), y: cum };
  });
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0, sxy = 0;
  for (const p of pts) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); }
  const slope = sxx > 0 ? sxy / sxx : 0; // micro-dollars/day
  const intercept = my - slope * mx;
  const projected = intercept + slope * daysInMonth;
  return finishForecast(daysElapsed, daysInMonth, daysRemaining, slope, projected, status.spent_micro, budgetMicro, "regression");
}

// ---------------------------------------------------------------------------
// Pacing — spend the whole budget intelligently instead of a fixed cadence
// ---------------------------------------------------------------------------

/**
 * Budget-paced sampling interval while DRIVING. Compares the fraction of
 * budget remaining against the fraction of month remaining:
 *
 *   ratio ≥ 1   → at/ahead of pace → 10s (max fidelity: real harsh-brake proxy)
 *   ratio ≥ .75 → slightly behind  → 15s
 *   ratio ≥ .5  → behind           → 30s
 *   else        → way behind       → 60s (the old logging cadence)
 *
 * Self-correcting: heavy-driving weeks decay the cadence, idle weeks recover
 * it. The absolute stop stays with the poll gate at BUDGET_POLL_USD — this
 * only shapes HOW the allowed budget is spent. A month of typical driving
 * (~25 h) at sustained 10s costs ~$18 unpaced; pacing degrades it smoothly so
 * the month lands under the cap instead of hitting a wall mid-month.
 */
export function pacedDrivingIntervalS(
  spentMicroNow: number,
  budgetMicro: number,
  now: Date = new Date(),
  reservedMicro = 0,
): number {
  if (budgetMicro <= 0) return 60;
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsedFrac =
    (now.getUTCDate() - 1 + now.getUTCHours() / 24) / daysInMonth;
  const remainingFrac = Math.max(0.02, 1 - elapsedFrac);
  // reservedMicro: budget already committed to the rest of the month (the
  // streaming signal draw, which REST pacing can't throttle). Without it the
  // pacer hands streaming's share to the 10s driving burst early in the
  // month, then collapses far faster than the 15->30->60s ladder assumes --
  // the exact shape of the July 2026 early drain.
  const remainingBudgetFrac = Math.max(0, budgetMicro - spentMicroNow - reservedMicro) / budgetMicro;
  const ratio = remainingBudgetFrac / remainingFrac;
  if (ratio >= 1) return 10;
  if (ratio >= 0.75) return 15;
  if (ratio >= 0.5) return 30;
  return 60;
}

/** Charging cadence: 60s when ahead of budget pace (crisper charge curves), else 150s. */
export function pacedChargingIntervalS(
  spentMicroNow: number,
  budgetMicro: number,
  now: Date = new Date(),
  reservedMicro = 0,
): number {
  return pacedDrivingIntervalS(spentMicroNow, budgetMicro, now, reservedMicro) === 10 ? 60 : 150;
}

/** Whole+fractional days left in the current UTC month (for reserve projections). */
export function remainingDaysInMonth(now: Date = new Date()): number {
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.max(0, daysInMonth - (now.getUTCDate() - 1 + now.getUTCHours() / 24));
}

/**
 * Trailing signal-spend rate (micro-$/day, over up to `days` recent days with
 * data). Streaming bills whenever the car transmits -- an unstoppable
 * committed draw that REST pacing must treat as already spent for the rest of
 * the month rather than available headroom.
 */
export async function trailingSignalMicroPerDay(env: Env, days = 7): Promise<number> {
  await ensureSpendTable(env);
  const sinceDay = dayKey(new Date(Date.now() - days * 86400_000));
  const row = await env.DB.prepare(
    `SELECT SUM(micro) micro, COUNT(DISTINCT day) n FROM api_spend_calls
     WHERE kind = 'signal' AND day >= ?1`,
  ).bind(sinceDay).first<{ micro: number | null; n: number }>();
  const n = row?.n ?? 0;
  return n > 0 ? Math.round((row?.micro ?? 0) / n) : 0;
}
