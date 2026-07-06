/**
 * Backend for the shortlisted "100 telemetry ideas" features: lifetime
 * charging taper curve, tire side-to-side balance, ADAS feature adoption,
 * climate/comfort habits, and the media/traffic-mood correlation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ensureSchema, resetSchemaCacheForTests, recordEvents } from "../src/store";
import {
  getChargeTaperCurve,
  getClimateHabits,
  getMediaStats,
  getSafetyFeatureStats,
  getTirePressures,
} from "../src/tracking";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINSHORTLIST1";
const NOW = Math.floor(Date.now() / 1000);

function makeEnv(): Env {
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
  } as Env;
}

describe("getChargeTaperCurve", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  async function insertSession(): Promise<number> {
    const res = await env.DB.prepare(
      `INSERT INTO charge_sessions (vin, start_ts, end_ts, status) VALUES (?1, ?2, ?3, 'complete')`,
    ).bind(VIN, NOW - 3600, NOW - 3000).run();
    return Number(res.meta.last_row_id ?? 0);
  }
  async function insertCurvePoint(sessionId: number, ts: number, soc: number, power: number): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO charges (session_id, vin, ts, soc, charger_power) VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(sessionId, VIN, ts, soc, power).run();
  }

  it("bins charge samples by 5% SoC and averages the power", async () => {
    const s = await insertSession();
    await insertCurvePoint(s, NOW - 3600, 22, 150); // bin 20
    await insertCurvePoint(s, NOW - 3590, 23, 140); // bin 20
    await insertCurvePoint(s, NOW - 3580, 61, 60); // bin 60
    const res = (await getChargeTaperCurve(env, VIN)) as { bins: { soc_min: number; soc_max: number; avg_power_kw: number; samples: number }[] };
    const bin20 = res.bins.find((b) => b.soc_min === 20);
    const bin60 = res.bins.find((b) => b.soc_min === 60);
    expect(bin20).toMatchObject({ soc_max: 25, avg_power_kw: 145, samples: 2 });
    expect(bin60).toMatchObject({ soc_max: 65, avg_power_kw: 60, samples: 1 });
  });

  it("notes when there's not enough spread to draw a real curve", async () => {
    const res = (await getChargeTaperCurve(env, VIN)) as { bins: unknown[]; note: string | null };
    expect(res.bins).toEqual([]);
    expect(res.note).toMatch(/more charge sessions/);
  });
});

describe("tire balance (getTirePressures)", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("averages paired same-timestamp samples and flags a persistent asymmetry", async () => {
    // FL consistently ~0.3 bar above FR — a real, sustained gap (over the 0.15 threshold).
    for (let i = 0; i < 5; i++) {
      const ts = NOW - i * 3600;
      await recordEvents(env, VIN, [
        { field: "tpms_fl", value: 2.9, ts },
        { field: "tpms_fr", value: 2.6, ts },
        { field: "tpms_rl", value: 2.8, ts },
        { field: "tpms_rr", value: 2.8, ts },
      ]);
    }
    const res = (await getTirePressures(env, VIN, 30)) as { balance: { fl_fr_bar: number; rl_rr_bar: number; asymmetric: boolean; paired_samples: number } };
    expect(res.balance.paired_samples).toBe(5);
    expect(res.balance.fl_fr_bar).toBeCloseTo(0.3, 2);
    expect(res.balance.rl_rr_bar).toBeCloseTo(0, 2);
    expect(res.balance.asymmetric).toBe(true);
  });

  it("does not flag a small, normal difference as asymmetric", async () => {
    const ts = NOW;
    await recordEvents(env, VIN, [
      { field: "tpms_fl", value: 2.75, ts },
      { field: "tpms_fr", value: 2.7, ts },
      { field: "tpms_rl", value: 2.7, ts },
      { field: "tpms_rr", value: 2.7, ts },
    ]);
    const res = (await getTirePressures(env, VIN, 30)) as { balance: { asymmetric: boolean } | null };
    expect(res.balance?.asymmetric).toBe(false);
  });

  it("returns null balance with no paired TPMS samples", async () => {
    const res = (await getTirePressures(env, VIN, 30)) as { balance: unknown };
    expect(res.balance).toBeNull();
  });
});

describe("getSafetyFeatureStats", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("reports has_data:false with no ADAS telemetry", async () => {
    const res = (await getSafetyFeatureStats(env, VIN, 90)) as { has_data: boolean };
    expect(res.has_data).toBe(false);
  });

  it("computes AEB-disabled %, blind-spot chime activation count, and the most common settings", async () => {
    const t0 = NOW - 3600;
    await recordEvents(env, VIN, [
      { field: "aeb_off", value: false, ts: t0 },
      { field: "aeb_off", value: true, ts: t0 + 60 }, // disabled for 3 of 4 samples
      { field: "aeb_off", value: true, ts: t0 + 120 },
      { field: "aeb_off", value: true, ts: t0 + 180 },
      // Two separate chime activations (0->1 transitions), not just "on for a while".
      { field: "blind_spot_chime", value: false, ts: t0 },
      { field: "blind_spot_chime", value: true, ts: t0 + 10 },
      { field: "blind_spot_chime", value: false, ts: t0 + 20 },
      { field: "blind_spot_chime", value: true, ts: t0 + 30 },
      { field: "lane_departure", value: "Warning", ts: t0 },
      { field: "lane_departure", value: "Warning", ts: t0 + 60 },
      { field: "lane_departure", value: "Assist", ts: t0 + 120 },
    ]);
    const res = (await getSafetyFeatureStats(env, VIN, 90)) as {
      has_data: boolean; aeb_disabled_pct: number; blind_spot_chime_count: number; lane_departure_setting: string;
    };
    expect(res.has_data).toBe(true);
    expect(res.aeb_disabled_pct).toBe(75);
    expect(res.blind_spot_chime_count).toBe(2);
    expect(res.lane_departure_setting).toBe("Warning");
  });
});

describe("getClimateHabits", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("reports has_data:false with no climate telemetry", async () => {
    const res = (await getClimateHabits(env, VIN, 90)) as { has_data: boolean };
    expect(res.has_data).toBe(false);
  });

  it("averages seat-heater levels per side and computes the divergence", async () => {
    const t0 = NOW - 3600;
    await recordEvents(env, VIN, [
      { field: "seat_heater_l", value: 3, ts: t0 },
      { field: "seat_heater_l", value: 3, ts: t0 + 60 },
      { field: "seat_heater_r", value: 1, ts: t0 },
      { field: "seat_heater_r", value: 1, ts: t0 + 60 },
      { field: "auto_seat_climate_l", value: true, ts: t0 },
      { field: "auto_seat_climate_l", value: false, ts: t0 + 60 },
    ]);
    const res = (await getClimateHabits(env, VIN, 90)) as {
      has_data: boolean; avg_seat_heater_left: number; avg_seat_heater_right: number;
      seat_heater_divergence: number; auto_climate_left_pct: number;
    };
    expect(res.has_data).toBe(true);
    expect(res.avg_seat_heater_left).toBe(3);
    expect(res.avg_seat_heater_right).toBe(1);
    expect(res.seat_heater_divergence).toBe(2);
    expect(res.auto_climate_left_pct).toBe(50);
  });
});

describe("getMediaStats — traffic mood", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("omits traffic_mood entirely when no traffic telemetry has ever been recorded", async () => {
    const t0 = NOW - 3600;
    await recordEvents(env, VIN, [{ field: "media_title", value: "Track", ts: t0 }]);
    const res = (await getMediaStats(env, VIN, 90)) as { traffic_mood: unknown };
    expect(res.traffic_mood).toBeNull();
  });

  it("buckets track plays by the traffic delay at the time they started", async () => {
    const t0 = NOW - 7200;
    await recordEvents(env, VIN, [
      { field: "nav_traffic_delay_min", value: 2, ts: t0 - 10 }, // light traffic, before "Chill Song"
      { field: "media_title", value: "Chill Song", ts: t0 },
      { field: "nav_traffic_delay_min", value: 25, ts: t0 + 290 }, // heavy traffic, before "Rage Song"
      { field: "media_title", value: "Rage Song", ts: t0 + 300 },
    ]);
    const res = (await getMediaStats(env, VIN, 90)) as { traffic_mood: { heavy: { title: string }[]; light: { title: string }[] } };
    expect(res.traffic_mood.light.map((r) => r.title)).toContain("Chill Song");
    expect(res.traffic_mood.heavy.map((r) => r.title)).toContain("Rage Song");
  });
});
