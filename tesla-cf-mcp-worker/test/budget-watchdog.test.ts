/**
 * budgetWatchdog: graduated crossing alerts (50/75/90/100% of BUDGET_POLL_USD)
 * plus a predictive alert when the forecast projects exhaustion before
 * month-end (2-tick hysteresis). Replaced the old flat 95%+24h-cooldown rule,
 * which by design could only fire once the month was already lost (July 2026:
 * first alert at 97%, drained the next day).
 *
 * nextTelemetryPlanStep: the pure ladder decision that steps streaming
 * fidelity down before the wall and restores the permanent plan on the 1st.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { budgetWatchdog, nextTelemetryPlanStep } from "../src/rules";
import { recordSpend, forceBudgetCeiling } from "../src/budget";
import { logAlert, resetSchemaCacheForTests } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

afterEach(() => vi.restoreAllMocks());

function makeEnv(budget = "9.5", extra: Partial<Env> = {}): Env {
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
    ...extra,
  } as Env;
}

async function alertRows(env: Env): Promise<Array<{ kind: string; message: string; delivered: number }>> {
  try {
    const rs = await env.DB.prepare(`SELECT kind, message, delivered FROM alert_log ORDER BY id`).all<{ kind: string; message: string; delivered: number }>();
    return rs.results ?? [];
  } catch {
    return []; // table not created yet — nothing was ever logged
  }
}

describe("budgetWatchdog", () => {
  it("stays silent below the first threshold (but still annotates the summary)", async () => {
    const env = makeEnv();
    await recordSpend(env, "wake", 100); // $2.00 of a $9.50 cap ≈ 21%
    const summary: Record<string, unknown> = {};
    await budgetWatchdog(env, summary);
    expect(await alertRows(env)).toHaveLength(0);
    expect(summary.budget_watchdog).toEqual({ spent_usd: 2, cap_usd: 9.5 });
  });

  it("fires each graduated threshold exactly once as spend climbs", async () => {
    const env = makeEnv();
    await recordSpend(env, "wake", 260); // $5.20 ≈ 55%
    await budgetWatchdog(env, {});
    let rows = await alertRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("crossed 50%");

    await budgetWatchdog(env, {}); // same spend — no re-fire
    expect(await alertRows(env)).toHaveLength(1);

    await recordSpend(env, "wake", 130); // +$2.60 → $7.80 ≈ 82%
    await budgetWatchdog(env, {});
    rows = await alertRows(env);
    expect(rows).toHaveLength(2);
    expect(rows[1].message).toContain("crossed 75%");
  });

  it("skipping straight past several thresholds fires only the highest", async () => {
    const env = makeEnv();
    await forceBudgetCeiling(env); // $9.70 ≥ 100% of $9.50 in one jump
    const summary: Record<string, unknown> = {};
    await budgetWatchdog(env, summary);
    const rows = await alertRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("budget");
    expect(rows[0].message).toContain("crossed 100% of the $9.5 monthly cap");
    expect(summary.budget_watchdog).toEqual({ spent_usd: 9.7, cap_usd: 9.5 });
  });

  it("predictive alert needs two consecutive projecting ticks (hysteresis) and fires once", async () => {
    const env = makeEnv();
    // Seed a daily-spend series whose OLS slope projects exhaustion well
    // before month-end: three straight days at ~$1.5/day against a $9.5 cap.
    const day = (offset: number) => {
      const d = new Date(Date.now() - offset * 86400_000);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    };
    await recordSpend(env, "wake", 75); // $1.50 today, creates tables + month total
    for (const [off, micro] of [[2, 1_500_000], [1, 1_500_000]] as const) {
      // getBudgetForecast's OLS runs over api_spend_daily (same-month rows).
      await env.DB.prepare(
        `INSERT INTO api_spend_daily (day, micro) VALUES (?1, ?2)`,
      ).bind(day(off), micro).run();
      await env.DB.prepare(`UPDATE api_spend SET micro = micro + ?1`).bind(micro).run();
    }

    await budgetWatchdog(env, {}); // tick 1: projecting — streak 1, no alert yet
    const afterFirst = (await alertRows(env)).filter((r) => r.message.includes("runs out in"));
    expect(afterFirst).toHaveLength(0);

    await budgetWatchdog(env, {}); // tick 2: still projecting — fires
    const predictive = (await alertRows(env)).filter((r) => r.message.includes("runs out in"));
    expect(predictive).toHaveLength(1);

    await budgetWatchdog(env, {}); // tick 3: already fired this streak — silent
    expect((await alertRows(env)).filter((r) => r.message.includes("runs out in"))).toHaveLength(1);
  });

  it("never fires when no budget is configured (defaults are sane)", async () => {
    const env = makeEnv("");
    await recordSpend(env, "wake", 10);
    await budgetWatchdog(env, {});
    expect(await alertRows(env)).toHaveLength(0);
  });
});

describe("logAlert ALERT_WEBHOOK fallback delivery", () => {
  it("POSTs the message and stamps delivered=1 on success", async () => {
    const env = makeEnv("9.5", { ALERT_WEBHOOK: "https://ntfy.sh/test-topic" } as Partial<Env>);
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body });
      return new Response("ok", { status: 200 });
    }));
    await logAlert(env, { ruleId: "budget_watchdog", kind: "budget", message: "test alert", delivered: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://ntfy.sh/test-topic");
    expect(calls[0].body).toBe("test alert");
    const rows = await alertRows(env);
    expect(rows[0].delivered).toBe(1);
  });

  it("a failed webhook leaves delivered=0 (surfaced by the dashboard Alerts screen)", async () => {
    const env = makeEnv("9.5", { ALERT_WEBHOOK: "https://ntfy.sh/test-topic" } as Partial<Env>);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    await logAlert(env, { ruleId: "r", kind: "budget", message: "m", delivered: false });
    expect((await alertRows(env))[0].delivered).toBe(0);
  });
});

describe("nextTelemetryPlanStep — the pure ladder decision", () => {
  const M = "2026-07";
  it("restores the permanent plan on month rollover (replaces the manual restore chore)", () => {
    expect(nextTelemetryPlanStep(M, "2026-06 minimal", 3)).toBe("permanent");
    expect(nextTelemetryPlanStep(M, null, 3)).toBe("permanent");
  });
  it("steps down to lean at 75% and minimal at 90%", () => {
    expect(nextTelemetryPlanStep(M, `${M} permanent`, 80)).toBe("lean");
    expect(nextTelemetryPlanStep(M, `${M} lean`, 92)).toBe("minimal");
    expect(nextTelemetryPlanStep(M, `${M} permanent`, 95)).toBe("minimal");
  });
  it("a mid-crisis first run goes straight to the right step, not a restore first", () => {
    expect(nextTelemetryPlanStep(M, null, 96)).toBe("minimal");
    expect(nextTelemetryPlanStep(M, null, 80)).toBe("lean");
  });
  it("never upgrades mid-month and no-ops when already at the right step", () => {
    expect(nextTelemetryPlanStep(M, `${M} lean`, 80)).toBeNull();
    expect(nextTelemetryPlanStep(M, `${M} lean`, 50)).toBeNull(); // no upgrade despite low pct
    expect(nextTelemetryPlanStep(M, `${M} minimal`, 99)).toBeNull();
    expect(nextTelemetryPlanStep(M, `${M} minimal`, 10)).toBeNull();
    expect(nextTelemetryPlanStep(M, `${M} permanent`, 30)).toBeNull();
  });
});
