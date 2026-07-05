import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { recordSpend, getBudgetStatus, forceBudgetCeiling } from "../src/budget";
import { pollOnce, inQuietHours } from "../src/poll";
import { resetSchemaCacheForTests } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINBUDGET0001";

function makeEnv(kv = new FakeKV()): Env {
  resetSchemaCacheForTests();
  return {
    TESLA_KV: kv as unknown as KVNamespace,
    DB: new FakeD1() as unknown as D1Database,
    TESLA_REGION: "eu",
    PUBLIC_ORIGIN: "https://test.example.com",
    TESLA_CLIENT_ID: "cid",
    TESLA_CLIENT_SECRET: "csecret",
    TESLA_PRIVATE_KEY: "pk",
    MCP_AUTH_TOKEN: "tok",
  } as Env;
}

describe("spend accounting", () => {
  it("accumulates micro-dollar costs per kind", async () => {
    const kv = new FakeKV();
    const env = makeEnv(kv);
    await recordSpend(env, "vehicle_data"); // $0.002
    await recordSpend(env, "vehicle_data");
    await recordSpend(env, "wake"); // $0.02
    await recordSpend(env, "command", 3); // 3 × $0.001
    const s = await getBudgetStatus(env);
    // spent_usd is rounded to cents for display (Tesla itself rounds to $0.01).
    expect(s.spent_usd).toBeCloseTo(0.03, 2);
    expect(s.poll_allowed).toBe(true);
    expect(s.commands_allowed).toBe(true);
  });

  it("closes the poll gate at the poll budget and the command gate at the ceiling", async () => {
    const kv = new FakeKV();
    const env = makeEnv(kv);
    // 4501 vehicle_data reads = $9.002 — past the $9 poll cap, under the $9.70 ceiling.
    await recordSpend(env, "vehicle_data", 4501);
    let s = await getBudgetStatus(env);
    expect(s.poll_allowed).toBe(false);
    expect(s.commands_allowed).toBe(true);
    // push over the $9.70 ceiling
    await recordSpend(env, "wake", 40); // +$0.80 → $9.802
    s = await getBudgetStatus(env);
    expect(s.commands_allowed).toBe(false);
  });

  it("honours a BUDGET_POLL_USD override, clamped to the ceiling", async () => {
    const env = { ...makeEnv(), BUDGET_POLL_USD: "2" } as Env;
    await recordSpend(env, "vehicle_data", 1001); // $2.002
    const s = await getBudgetStatus(env);
    expect(s.poll_budget_usd).toBe(2);
    expect(s.poll_allowed).toBe(false);
  });

  it("folds a legacy KV counter into the D1 ledger once (mid-month deploy)", async () => {
    const kv = new FakeKV();
    const month = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
    await kv.put(`api_spend:${month}`, "5000000"); // $5 counted by the old deployment
    const env = makeEnv(kv);
    const s = await getBudgetStatus(env);
    expect(s.spent_usd).toBeCloseTo(5, 2);
    // New spend accumulates ON TOP of the migrated figure, not from zero.
    await recordSpend(env, "vehicle_data", 500); // +$1
    const s2 = await getBudgetStatus(env);
    expect(s2.spent_usd).toBeCloseTo(6, 2);
  });

  it("forceBudgetCeiling (Tesla 403 EXCEEDED_LIMIT) closes every gate immediately", async () => {
    const env = makeEnv();
    await forceBudgetCeiling(env);
    const s = await getBudgetStatus(env);
    expect(s.poll_allowed).toBe(false);
    expect(s.commands_allowed).toBe(false);
  });

  it("records telemetry signal spend at the ingest boundary (not per-field double-count on poll)", async () => {
    const env = makeEnv();
    await recordSpend(env, "signal", 100_000); // 100k × 7µ$ = $0.70
    const s = await getBudgetStatus(env);
    expect(s.spent_micro).toBe(700_000);
    expect(s.spent_usd).toBeCloseTo(0.7, 2);
  });
});

describe("budget fails CLOSED on ledger read failure", () => {
  it("a thrown D1 read pins gates shut, never billing blind", async () => {
    // DB whose SELECT path throws — simulates a D1 outage.
    const brokenDb = {
      prepare() {
        return {
          bind() { return this; },
          run: async () => ({ meta: {} }),
          first: async () => { throw new Error("D1 down"); },
          all: async () => { throw new Error("D1 down"); },
        };
      },
    };
    const env = {
      TESLA_KV: new FakeKV() as unknown as KVNamespace,
      DB: brokenDb as unknown as D1Database,
      TESLA_REGION: "eu", PUBLIC_ORIGIN: "https://t.example.com",
      TESLA_CLIENT_ID: "c", TESLA_CLIENT_SECRET: "s", TESLA_PRIVATE_KEY: "k",
      MCP_AUTH_TOKEN: "tok",
    } as Env;
    const s = await getBudgetStatus(env);
    expect(s.poll_allowed).toBe(false);
    expect(s.commands_allowed).toBe(false);
  });
});

describe("pollOnce budget gate", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does only the free connectivity check when the poll budget is exhausted", async () => {
    const kv = new FakeKV();
    const env = makeEnv(kv);
    await kv.put("tesla:refresh_token", "R0");
    await recordSpend(env, "vehicle_data", 5000); // $10 — way past the poll cap

    let vehicleDataCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/oauth2/v3/token")) {
        return new Response(JSON.stringify({ access_token: "A", refresh_token: "R", expires_in: 3600, token_type: "Bearer" }), { status: 200 });
      }
      if (u.includes("/vehicle_data")) {
        vehicleDataCalls++;
        return new Response(JSON.stringify({ response: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ response: { vin: VIN, state: "online" } }), { status: 200 });
    }));

    const r = await pollOnce(env, VIN);
    expect(r.activity).toBe("budget_exhausted");
    expect(r.polled).toBe(false);
    expect(r.active).toBe(false);
    expect(vehicleDataCalls).toBe(0); // the billed endpoint was never touched
  });
});

describe("quiet hours", () => {
  it("matches a same-day window and a midnight-wrapping window", () => {
    expect(inQuietHours("21-3", 22)).toBe(true);
    expect(inQuietHours("21-3", 2)).toBe(true);
    expect(inQuietHours("21-3", 12)).toBe(false);
    expect(inQuietHours("1-5", 3)).toBe(true);
    expect(inQuietHours("1-5", 6)).toBe(false);
    expect(inQuietHours(undefined, 2)).toBe(false);
    expect(inQuietHours("junk", 2)).toBe(false);
  });
});
