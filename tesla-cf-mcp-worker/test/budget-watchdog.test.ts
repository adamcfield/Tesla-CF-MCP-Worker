/**
 * budgetWatchdog: dashboard-visible early warning at ≥95% of BUDGET_POLL_USD.
 * Streaming signal spend has no worker-side stop, so this alert is the layer
 * in front of the $9.70 ceiling / Tesla's $10 suspend — it must fire once,
 * respect its 24h cooldown, and stay silent below the threshold.
 */
import { describe, it, expect } from "vitest";
import { budgetWatchdog } from "../src/rules";
import { recordSpend, forceBudgetCeiling } from "../src/budget";
import { resetSchemaCacheForTests } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

function makeEnv(budget = "9.5"): Env {
  resetSchemaCacheForTests();
  return {
    TESLA_KV: new FakeKV() as unknown as KVNamespace,
    DB: new FakeD1() as unknown as D1Database,
    TESLA_REGION: "eu",
    PUBLIC_ORIGIN: "https://test.example.com",
    TESLA_CLIENT_ID: "cid",
    TESLA_CLIENT_SECRET: "csecret",
    TESLA_PRIVATE_KEY: "pk",
    MCP_AUTH_TOKEN: "tok",
    BUDGET_POLL_USD: budget,
  } as Env;
}

async function alertRows(env: Env): Promise<Array<{ kind: string; message: string }>> {
  try {
    const rs = await env.DB.prepare(`SELECT kind, message FROM alert_log`).all<{ kind: string; message: string }>();
    return rs.results ?? [];
  } catch {
    return []; // table not created yet — nothing was ever logged
  }
}

describe("budgetWatchdog", () => {
  it("stays silent below 95% of the cap", async () => {
    const env = makeEnv();
    await recordSpend(env, "wake", 100); // $2.00 of a $9.50 cap ≈ 21%
    const summary: Record<string, unknown> = {};
    await budgetWatchdog(env, summary);
    expect(await alertRows(env)).toHaveLength(0);
    expect(summary.budget_watchdog).toBeUndefined();
  });

  it("logs one budget alert at/above 95% and annotates the tick summary", async () => {
    const env = makeEnv();
    await forceBudgetCeiling(env); // pins the month at $9.70 ≥ 95% of $9.50
    const summary: Record<string, unknown> = {};
    await budgetWatchdog(env, summary);
    const rows = await alertRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("budget");
    expect(rows[0].message).toContain("% of the $9.5 monthly cap");
    expect(summary.budget_watchdog).toEqual({ spent_usd: 9.7, cap_usd: 9.5 });
  });

  it("respects the 24h cooldown between alerts", async () => {
    const env = makeEnv();
    await forceBudgetCeiling(env);
    await budgetWatchdog(env, {});
    await budgetWatchdog(env, {}); // immediately again — same day
    expect(await alertRows(env)).toHaveLength(1);
  });

  it("never fires when no budget is configured (defaults are sane)", async () => {
    const env = makeEnv("");
    await recordSpend(env, "wake", 10);
    await budgetWatchdog(env, {});
    expect(await alertRows(env)).toHaveLength(0);
  });
});
