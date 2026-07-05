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
 * Amounts are tracked in integer micro-dollars to avoid float drift.
 * The KV read-modify-write isn't atomic; the GH poll loop is serialized by a
 * concurrency group, so worst-case drift from a rare concurrent MCP command
 * is a fraction of a cent — the $10→cap margin absorbs it.
 */

import { Env } from "./types";

export const COST_MICRO = {
  vehicle_data: 2_000, // $0.002
  command: 1_000, // $0.001
  wake: 20_000, // $0.02
  signal: 7, // ~$0.0000067
} as const;
export type BillableKind = keyof typeof COST_MICRO;

/** Automated polling stops here (micro-dollars). Override with BUDGET_POLL_USD. */
const DEFAULT_POLL_BUDGET = 8_000_000; // $8.00
/** Absolute ceiling for ALL tracked spend, kept under Tesla's $10 disable line. */
const HARD_CEILING = 9_500_000; // $9.50

const monthKey = (): string => {
  const d = new Date();
  return `api_spend:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

export async function recordSpend(env: Env, kind: BillableKind, count = 1): Promise<void> {
  try {
    const key = monthKey();
    const cur = Number((await env.TESLA_KV.get(key)) ?? "0");
    // 40-day TTL: the key survives its month then self-cleans.
    await env.TESLA_KV.put(key, String(cur + COST_MICRO[kind] * count), { expirationTtl: 40 * 86400 });
  } catch {
    // Accounting must never break the actual operation.
  }
}

export interface BudgetStatus {
  month: string;
  spent_usd: number;
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
  const spent = Number((await env.TESLA_KV.get(monthKey()).catch(() => "0")) ?? "0");
  const pollBudget = pollBudgetMicro(env);
  return {
    month: monthKey().slice("api_spend:".length),
    spent_usd: Math.round(spent / 10_000) / 100,
    poll_budget_usd: pollBudget / 1_000_000,
    hard_ceiling_usd: HARD_CEILING / 1_000_000,
    poll_allowed: spent < pollBudget,
    commands_allowed: spent < HARD_CEILING,
  };
}
