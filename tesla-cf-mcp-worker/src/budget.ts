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

/**
 * The spend table is (re)ensured on every call rather than guarded by a
 * per-isolate flag: a flag would leak across the many fresh in-memory DBs in
 * tests, and in production CREATE TABLE IF NOT EXISTS is a trivial no-op.
 * The one-time legacy KV → D1 fold-in only runs on the READ path (spentMicro)
 * — gates read through there, so ordering is safe.
 */
async function ensureSpendTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS api_spend (month TEXT PRIMARY KEY, micro INTEGER NOT NULL)`,
  ).run();
}

export async function recordSpend(env: Env, kind: BillableKind, count = 1): Promise<void> {
  try {
    await ensureSpendTable(env);
    await env.DB.prepare(
      `INSERT INTO api_spend (month, micro) VALUES (?1, ?2)
       ON CONFLICT(month) DO UPDATE SET micro = micro + excluded.micro`,
    )
      .bind(monthKey(), COST_MICRO[kind] * count)
      .run();
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
): number {
  if (budgetMicro <= 0) return 60;
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const elapsedFrac =
    (now.getUTCDate() - 1 + now.getUTCHours() / 24) / daysInMonth;
  const remainingFrac = Math.max(0.02, 1 - elapsedFrac);
  const remainingBudgetFrac = Math.max(0, budgetMicro - spentMicroNow) / budgetMicro;
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
): number {
  return pacedDrivingIntervalS(spentMicroNow, budgetMicro, now) === 10 ? 60 : 150;
}
