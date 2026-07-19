import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pacedChargingIntervalS, pacedDrivingIntervalS } from "../src/budget";
import { pollOnce } from "../src/poll";
import { nextAlarmDelayS } from "../src/scheduler";
import { getAppState, putAppState, resetSchemaCacheForTests } from "../src/store";
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

describe("cross-poller billed-read gap scales with the paced cadence", () => {
  let kv: FakeKV;
  beforeEach(async () => {
    kv = new FakeKV();
    await kv.put("tesla:refresh_token", "R0");
  });
  afterEach(() => vi.restoreAllMocks());

  it("a billed read stamps its paced interval next to the timestamp", async () => {
    const env = makeEnv(kv);
    stubTesla({ state: "online", charging_state: "Charging", shift: "P" });
    const r = await pollOnce(env, VIN);
    expect(r.polled).toBe(true);
    expect(r.next_interval_s).toBe(60); // fresh budget → 60s charging cadence
    const stamp = await getAppState(env, `billed_ts:${VIN}`);
    expect(stamp).toMatch(/^\d+ 60$/);
  });

  it("throttles a second poller for ~80% of the stamped interval, not just 8s", async () => {
    // Regression: DO alarm (90s) + GH loop (150s) interleaved >8s apart, so
    // both billed at full rate — ~2x the paced spend for every charging hour.
    const env = makeEnv(kv);
    stubTesla({ state: "online", charging_state: "Charging", shift: "P" });
    const now = Math.floor(Date.now() / 1000);
    // Another poller billed 20s ago at the 60s charging cadence → gap 48s.
    await putAppState(env, `billed_ts:${VIN}`, `${now - 20} 60`);
    const r = await pollOnce(env, VIN);
    expect(r.activity).toBe("throttled");
    expect(r.polled).toBe(false);
    // Remaining gap ≈ 48 - 20 = 28s (±1s clock jitter), not the 8s minimum.
    expect(r.next_interval_s).toBeGreaterThanOrEqual(26);
    expect(r.next_interval_s).toBeLessThanOrEqual(30);
  });

  it("bills again once the scaled gap has elapsed", async () => {
    const env = makeEnv(kv);
    stubTesla({ state: "online", charging_state: "Charging", shift: "P" });
    const now = Math.floor(Date.now() / 1000);
    await putAppState(env, `billed_ts:${VIN}`, `${now - 50} 60`); // 50s ≥ 48s gap
    const r = await pollOnce(env, VIN);
    expect(r.polled).toBe(true);
    expect(r.activity).toBe("charging");
  });

  it("legacy ts-only stamps keep the 8s minimum (backward compatible)", async () => {
    const env = makeEnv(kv);
    stubTesla({ state: "online", charging_state: "Charging", shift: "P" });
    const now = Math.floor(Date.now() / 1000);
    await putAppState(env, `billed_ts:${VIN}`, String(now - 10)); // pre-upgrade format
    const r = await pollOnce(env, VIN);
    expect(r.polled).toBe(true); // 10s ≥ 8s minimum → not throttled
  });

  it("driving cadence keeps the 8s minimum (burst fidelity unchanged)", async () => {
    const env = makeEnv(kv);
    stubTesla({ state: "online", shift: "D", speed: 45 });
    const now = Math.floor(Date.now() / 1000);
    await putAppState(env, `billed_ts:${VIN}`, `${now - 9} 10`); // 0.8*10 = 8s gap
    const r = await pollOnce(env, VIN);
    expect(r.polled).toBe(true); // 9s ≥ 8s → the 10s driving burst still flows
  });
});

describe("telemetry-first: streaming suppresses billed REST reads", () => {
  let kv: FakeKV;
  beforeEach(async () => {
    kv = new FakeKV();
    await kv.put("tesla:refresh_token", "R0");
  });
  afterEach(() => vi.restoreAllMocks());

  it("skips the billed read while the stream stamp is fresh and a reconciliation read is recent", async () => {
    const env = makeEnv(kv);
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
    const now = Math.floor(Date.now() / 1000);
    await putAppState(env, `stream_ok_ts:${VIN}`, String(now - 30)); // stream alive
    await putAppState(env, `billed_ts:${VIN}`, `${now - 600} 90`); // reconciled 10 min ago
    const r = await pollOnce(env, VIN);
    expect(r.activity).toBe("stream_covered");
    expect(r.polled).toBe(false);
    expect(r.active).toBe(false);
    expect(vehicleDataCalls).toBe(0); // no billed read at all
  });

  it("still does an hourly reconciliation read despite a healthy stream", async () => {
    const env = makeEnv(kv);
    stubTesla({ state: "online", shift: "P", speed: 0 });
    const now = Math.floor(Date.now() / 1000);
    await putAppState(env, `stream_ok_ts:${VIN}`, String(now - 30)); // stream alive
    await putAppState(env, `billed_ts:${VIN}`, `${now - 2 * 3600} 90`); // last billed read 2h ago
    const r = await pollOnce(env, VIN);
    expect(r.polled).toBe(true); // reconciliation happened
  });

  it("falls back to normal REST pacing the moment the stream goes quiet", async () => {
    const env = makeEnv(kv);
    stubTesla({ state: "online", shift: "D", speed: 45 });
    const now = Math.floor(Date.now() / 1000);
    await putAppState(env, `stream_ok_ts:${VIN}`, String(now - 400)); // stale (> 330s window)
    const r = await pollOnce(env, VIN);
    expect(r.activity).toBe("driving"); // normal billed burst resumed
    expect(r.polled).toBe(true);
    expect(r.next_interval_s).toBe(10);
  });

  // "power" has no streaming equivalent at all (see power_ts in ingest.ts) --
  // while driving, the hour-long reconciliation gap left it stuck on one
  // stale reading for a whole day. These regression-test the shorter,
  // budget-paced reconciliation cadence used while streaming shows driving.
  it("while driving, reconciles at the paced cadence instead of waiting the full hour", async () => {
    const env = makeEnv(kv);
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
    const now = Math.floor(Date.now() / 1000);
    await putAppState(env, `stream_ok_ts:${VIN}`, String(now - 5)); // stream alive
    await putAppState(env, `latest:${VIN}`, JSON.stringify({ vin: VIN, updated_at: now, gear: "D", speed: 45 }));
    // Reconciled 30s ago -- well inside the hour-long gap, but past a fresh-budget
    // 10s driving pace. Should still skip the billed read (30s > 10s already
    // elapsed), but report active with a short remaining-gap interval, not 300s.
    await putAppState(env, `billed_ts:${VIN}`, `${now - 5} 90`);
    const r = await pollOnce(env, VIN);
    expect(r.activity).toBe("stream_covered");
    expect(r.polled).toBe(false);
    expect(vehicleDataCalls).toBe(0);
    expect(r.active).toBe(true); // NOT false -- driving must keep the loop going
    expect(r.next_interval_s).toBeLessThanOrEqual(10); // paced gap, not INTERVAL_SLEEP (300)
  });

  it("bills once the driving-paced reconciliation gap has actually elapsed", async () => {
    const env = makeEnv(kv);
    stubTesla({ state: "online", shift: "D", speed: 45 });
    const now = Math.floor(Date.now() / 1000);
    await putAppState(env, `stream_ok_ts:${VIN}`, String(now - 5)); // stream alive
    await putAppState(env, `latest:${VIN}`, JSON.stringify({ vin: VIN, updated_at: now, gear: "D", speed: 45 }));
    // Prior billed read was itself a driving reconciliation (stamped the
    // driving-paced interval) 15s ago -- past the fresh-budget 10s pace, and
    // past the cross-poller dedup gap (0.8*10=8s) too.
    await putAppState(env, `billed_ts:${VIN}`, `${now - 15} 10`);
    const r = await pollOnce(env, VIN);
    expect(r.polled).toBe(true); // reconciliation fired, refreshing "power"
    expect(r.activity).toBe("driving");
  });

  // Regression: today's real drives got ZERO power reconciliation reads
  // despite the paced-cadence fix above, because two OLDER gates -- designed
  // around REST's own staleness bookkeeping, not streaming -- independently
  // blocked the read using markers that go stale for hours under telemetry-
  // first (the REST side may not have billed in a very long time).
  it("a stale suspension marker doesn't block reconciliation once streaming shows driving", async () => {
    const env = makeEnv(kv);
    stubTesla({ state: "online", shift: "D", speed: 45 });
    const now = Math.floor(Date.now() / 1000);
    await putAppState(env, `stream_ok_ts:${VIN}`, String(now - 5)); // stream alive
    await putAppState(env, `latest:${VIN}`, JSON.stringify({ vin: VIN, updated_at: now, gear: "D", speed: 45 }));
    // REST hasn't seen activity in 3 hours (telemetry-first: no reason to
    // have billed) -- old code reads this as "idle 3h" >= IDLE_SUSPEND_MIN
    // (12min) and suspends, only probing every 15min. last_probe_ts is
    // recent, so probeDue is false too -- without the fix this returns
    // early as "idle" and never reaches the billed read at all.
    await putAppState(env, `poll_state:${VIN}`, JSON.stringify({
      last_active_ts: now - 3 * 3600, last_probe_ts: now - 60,
    }));
    await putAppState(env, `billed_ts:${VIN}`, `${now - 15} 10`); // clears both gap checks
    const r = await pollOnce(env, VIN);
    expect(r.polled).toBe(true);
    expect(r.activity).toBe("driving");
  });

  it("a stale cross-poller interval from the last non-driving read doesn't throttle the first driving reconciliation", async () => {
    const env = makeEnv(kv);
    stubTesla({ state: "online", shift: "D", speed: 45 });
    const now = Math.floor(Date.now() / 1000);
    await putAppState(env, `stream_ok_ts:${VIN}`, String(now - 5)); // stream alive
    await putAppState(env, `latest:${VIN}`, JSON.stringify({ vin: VIN, updated_at: now, gear: "D", speed: 45 }));
    // Not suspended -- isolates the OTHER stale-interval gate (3b).
    await putAppState(env, `poll_state:${VIN}`, JSON.stringify({ last_active_ts: now - 60, last_probe_ts: now - 60 }));
    // Last billed read was an idle-cadence reconciliation stamped 90s --
    // clears the telemetry-first driving-pace gap (20s > 10s) but, unfixed,
    // step 3b would scale ITS gap from the stale 90s (0.8*90=72s) and
    // throttle this for another 52s -- long enough to miss a short drive.
    await putAppState(env, `billed_ts:${VIN}`, `${now - 20} 90`);
    const r = await pollOnce(env, VIN);
    expect(r.polled).toBe(true);
    expect(r.activity).toBe("driving");
  });

  it("not driving (streaming shows idle) keeps the full hour-long reconciliation gap", async () => {
    const env = makeEnv(kv);
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
    const now = Math.floor(Date.now() / 1000);
    await putAppState(env, `stream_ok_ts:${VIN}`, String(now - 5)); // stream alive
    await putAppState(env, `latest:${VIN}`, JSON.stringify({ vin: VIN, updated_at: now, gear: "P", speed: 0 }));
    await putAppState(env, `billed_ts:${VIN}`, `${now - 600} 90`); // 10 min ago -- well within the hour
    const r = await pollOnce(env, VIN);
    expect(r.activity).toBe("stream_covered");
    expect(r.polled).toBe(false);
    expect(vehicleDataCalls).toBe(0);
    expect(r.active).toBe(false); // unaffected by the driving exception
    // Not 300s (INTERVAL_SLEEP): re-checks at STREAM_COVERED_IDLE_POLL_S so a
    // drive starting soon after is discovered promptly (free check only).
    expect(r.next_interval_s).toBe(30);
  });

  it("a stuck-driving merged doc doesn't bypass suspension once the stream itself has gone stale -- bounds cost exposure if the stream dies mid-drive", async () => {
    const env = makeEnv(kv);
    stubTesla({ state: "online", shift: "P", speed: 0 });
    const now = Math.floor(Date.now() / 1000);
    // Stream died 10 minutes ago (stale relative to STREAM_FRESH_S=330s), but
    // the merged "latest" doc is still stuck showing gear="D"/speed=45 from
    // right before it died -- adversarial review of the driving-cadence fix
    // flagged that gating suspension on deriveActivity(latest) alone, with no
    // check that the stream itself is still alive, would read this as
    // "driving forever" and permanently disable the suspension backstop,
    // unboundedly burning the poll budget instead of resuming normal pacing.
    await putAppState(env, `stream_ok_ts:${VIN}`, String(now - 600));
    await putAppState(env, `latest:${VIN}`, JSON.stringify({ vin: VIN, updated_at: now - 600, gear: "D", speed: 45 }));
    // REST-side bookkeeping reflects a long-idle car (the stream was covering
    // everything until it died) -- suspension SHOULD apply now that the
    // stream can no longer be trusted to say otherwise.
    await putAppState(env, `poll_state:${VIN}`, JSON.stringify({
      last_active_ts: now - 3 * 3600, last_probe_ts: now - 60,
    }));
    const r = await pollOnce(env, VIN);
    expect(r.activity).toBe("idle"); // suspended, NOT bypassed by the stale "driving" doc
    expect(r.polled).toBe(false);
    expect(r.active).toBe(false);
  });
});

describe("DO scheduler re-arm delay", () => {
  it("respects the paced interval instead of flooring it at 90s", () => {
    // Regression: the min() fold was seeded with the 90s default, so a 150s
    // charging pace re-armed at 90s anyway — ~1.7x the intended billed rate.
    expect(nextAlarmDelayS([150])).toBe(150);
    expect(nextAlarmDelayS([300])).toBe(300);
  });
  it("takes the fastest across VINs and clamps to [10, 300]", () => {
    expect(nextAlarmDelayS([10, 150])).toBe(10);
    expect(nextAlarmDelayS([3])).toBe(10);
    expect(nextAlarmDelayS([500])).toBe(300);
  });
  it("falls back to the 90s default when nothing reported", () => {
    expect(nextAlarmDelayS([])).toBe(90);
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
