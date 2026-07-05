import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pacedChargingIntervalS, pacedDrivingIntervalS } from "../src/budget";
import { pollOnce } from "../src/poll";
import { putAppState, resetSchemaCacheForTests } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINPOLL000001";

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

/**
 * Routes Tesla Fleet API calls: token refresh, the connectivity check
 * (/vehicles/VIN), and vehicle_data. `state` and `driveData` are closed over
 * so each test controls what the car reports.
 */
function stubTesla(opts: { state: string; charging_state?: string; shift?: string | null; speed?: number }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/oauth2/v3/token")) {
      return new Response(JSON.stringify({ access_token: "A", refresh_token: "R", expires_in: 3600, token_type: "Bearer" }), { status: 200 });
    }
    if (u.includes("/vehicle_data")) {
      return new Response(JSON.stringify({ response: {
        charge_state: { battery_level: 70, charging_state: opts.charging_state ?? "Disconnected", battery_range: 200 },
        climate_state: { inside_temp: 22, outside_temp: 18 },
        drive_state: { shift_state: opts.shift ?? null, speed: opts.speed ?? null, latitude: 32.1, longitude: 34.8, power: 0 },
        vehicle_state: { odometer: 1000, locked: true },
        vehicle_config: { car_type: "model3" },
      } }), { status: 200 });
    }
    // connectivity check /api/1/vehicles/VIN
    return new Response(JSON.stringify({ response: { vin: VIN, state: opts.state } }), { status: 200 });
  }));
}

describe("pollOnce adaptive interval", () => {
  let kv: FakeKV;
  beforeEach(async () => {
    kv = new FakeKV();
    await kv.put("tesla:refresh_token", "R0"); // so getOwnerToken reaches the fetch stub
  });
  afterEach(() => vi.restoreAllMocks());

  it("asleep → no data poll, inactive, back off (never wakes)", async () => {
    stubTesla({ state: "asleep" });
    const r = await pollOnce(makeEnv(kv), VIN);
    expect(r.state).toBe("asleep");
    expect(r.polled).toBe(false);
    expect(r.active).toBe(false);
    expect(r.next_interval_s).toBeGreaterThanOrEqual(120);
  });

  it("driving with a fresh budget → burst cadence (10s), active", async () => {
    stubTesla({ state: "online", shift: "D", speed: 45 });
    const r = await pollOnce(makeEnv(kv), VIN);
    expect(r.activity).toBe("driving");
    expect(r.active).toBe(true);
    // Zero spend → always at/ahead of monthly pace → maximum-fidelity burst.
    expect(r.next_interval_s).toBe(10);
    expect(r.polled).toBe(true);
  });

  it("charging with a fresh budget → 60s curve cadence, active", async () => {
    stubTesla({ state: "online", charging_state: "Charging", shift: "P" });
    const r = await pollOnce(makeEnv(kv), VIN);
    expect(r.activity).toBe("charging");
    expect(r.active).toBe(true);
    expect(r.next_interval_s).toBe(60);
  });

  it("dedups billed reads across overlapping pollers (no double-bill)", async () => {
    const env = makeEnv(kv);
    let vehicleDataCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/oauth2/v3/token")) {
        return new Response(JSON.stringify({ access_token: "A", refresh_token: "R", expires_in: 3600, token_type: "Bearer" }), { status: 200 });
      }
      if (u.includes("/vehicle_data")) {
        vehicleDataCalls++;
        return new Response(JSON.stringify({ response: {
          charge_state: { battery_level: 70, charging_state: "Charging", battery_range: 200 },
          climate_state: {}, drive_state: { shift_state: "P", speed: 0, latitude: 32.1, longitude: 34.8, power: 0 },
          vehicle_state: { odometer: 1000, locked: true }, vehicle_config: {},
        } }), { status: 200 });
      }
      return new Response(JSON.stringify({ response: { vin: VIN, state: "online" } }), { status: 200 });
    }));
    // First poll bills; an immediate second poll (another poller) must be
    // throttled to the free check only — total billed reads stays 1.
    const first = await pollOnce(env, VIN);
    expect(first.polled).toBe(true);
    const second = await pollOnce(env, VIN);
    expect(second.activity).toBe("throttled");
    expect(second.polled).toBe(false);
    expect(second.active).toBe(true);
    expect(vehicleDataCalls).toBe(1); // NOT 2 — the second poll didn't double-bill
  });

  it("idle-online → watch at the idle cadence while recently active, then suspend so it can sleep", async () => {
    const env = makeEnv(kv);
    // Fresh idle: last_active defaults to now → watch cadence, still active.
    stubTesla({ state: "online", shift: "P", speed: 0 });
    const first = await pollOnce(env, VIN);
    expect(first.activity).toBe("idle");
    expect(first.active).toBe(true);
    expect(first.next_interval_s).toBe(90);

    // Simulate 15 min of idle by ageing the stored marker (now in D1
    // app_state — the KV copy is only a migration fallback), then poll again.
    // Also age the billed-read stamp so the cross-poller dedup doesn't throttle
    // this (in reality these two polls are 15 min apart, not back-to-back).
    const ago = Math.floor(Date.now() / 1000) - 15 * 60;
    await putAppState(env, `poll_state:${VIN}`, JSON.stringify({ last_active_ts: ago }));
    await putAppState(env, `billed_ts:${VIN}`, String(ago));
    const later = await pollOnce(env, VIN);
    expect(later.activity).toBe("idle");
    expect(later.active).toBe(false); // suspended → loop stops, car allowed to sleep
  });
});

describe("budget pacing", () => {
  const mid = new Date(Date.UTC(2026, 6, 16)); // July 16 — ~48% through the month

  it("bursts at 10s when at/ahead of pace and decays as budget falls behind", () => {
    // July 16: elapsed ≈ 48.4% of the month → remainingFrac ≈ 0.516.
    // ratio = remainingBudgetFrac / remainingFrac, tiers 1 / 0.75 / 0.5.
    const budget = 9_000_000;
    expect(pacedDrivingIntervalS(0, budget, mid)).toBe(10); // untouched budget
    expect(pacedDrivingIntervalS(Math.round(budget * 0.45), budget, mid)).toBe(10); // on pace (ratio ≈ 1.07)
    expect(pacedDrivingIntervalS(Math.round(budget * 0.55), budget, mid)).toBe(15); // slightly behind (≈ 0.87)
    expect(pacedDrivingIntervalS(Math.round(budget * 0.7), budget, mid)).toBe(30); // behind (≈ 0.58)
    expect(pacedDrivingIntervalS(Math.round(budget * 0.9), budget, mid)).toBe(60); // nearly spent (≈ 0.19)
  });

  it("end-of-month leftover budget re-opens the burst", () => {
    const endOfMonth = new Date(Date.UTC(2026, 6, 30, 12));
    expect(pacedDrivingIntervalS(4_000_000, 9_000_000, endOfMonth)).toBe(10);
  });

  it("charging cadence follows the same pace signal", () => {
    expect(pacedChargingIntervalS(0, 9_000_000, mid)).toBe(60);
    expect(pacedChargingIntervalS(8_500_000, 9_000_000, mid)).toBe(150);
  });
});
