import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pollOnce } from "../src/poll";
import { resetSchemaCacheForTests } from "../src/store";
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

  it("driving → fast interval, active", async () => {
    stubTesla({ state: "online", shift: "D", speed: 45 });
    const r = await pollOnce(makeEnv(kv), VIN);
    expect(r.activity).toBe("driving");
    expect(r.active).toBe(true);
    expect(r.next_interval_s).toBe(30); // budget-tuned driving cadence
    expect(r.polled).toBe(true);
  });

  it("charging → medium interval, active", async () => {
    stubTesla({ state: "online", charging_state: "Charging", shift: "P" });
    const r = await pollOnce(makeEnv(kv), VIN);
    expect(r.activity).toBe("charging");
    expect(r.active).toBe(true);
    expect(r.next_interval_s).toBe(90);
  });

  it("idle-online → watch at 60s while recently active, then suspend so it can sleep", async () => {
    const env = makeEnv(kv);
    // Fresh idle: last_active defaults to now → watch cadence, still active.
    stubTesla({ state: "online", shift: "P", speed: 0 });
    const first = await pollOnce(env, VIN);
    expect(first.activity).toBe("idle");
    expect(first.active).toBe(true);
    expect(first.next_interval_s).toBe(60);

    // Simulate 15 min of idle by ageing the stored marker, then poll again.
    await kv.put(`poll_state:${VIN}`, JSON.stringify({ last_active_ts: Math.floor(Date.now() / 1000) - 15 * 60 }));
    const later = await pollOnce(env, VIN);
    expect(later.activity).toBe("idle");
    expect(later.active).toBe(false); // suspended → loop stops, car allowed to sleep
  });
});
