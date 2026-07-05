/**
 * Digital Twin: k-nearest historical-drive retrieval + similarity-weighted
 * prediction, and the trip-question router.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { looksLikeTripQuestion } from "../src/ai";
import { ensureSchema, resetSchemaCacheForTests } from "../src/store";
import { findSimilarDrives } from "../src/twin";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINTWIN000001";

function makeEnv(): Env {
  resetSchemaCacheForTests();
  return {
    TESLA_KV: new FakeKV() as unknown as KVNamespace,
    DB: new FakeD1() as unknown as D1Database,
    TESLA_REGION: "eu", PUBLIC_ORIGIN: "https://t.example.com",
    TESLA_CLIENT_ID: "c", TESLA_CLIENT_SECRET: "s", TESLA_PRIVATE_KEY: "k",
    MCP_AUTH_TOKEN: "tok",
  } as Env;
}

async function drive(env: Env, o: { id: number; dist: number; temp: number; eff: number; speed: number; driver?: string; synthetic?: number }) {
  await env.DB.prepare(
    `INSERT INTO drives (id, vin, start_ts, status, synthetic, distance_km, outside_temp_avg, avg_speed, night_frac, efficiency_wh_km, energy_used_kwh, start_soc, end_soc, driver, start_address, end_address)
     VALUES (?1, ?2, ?3, 'complete', ?4, ?5, ?6, ?7, 0, ?8, ?9, 90, ?10, ?11, 'A', 'B')`,
  ).bind(o.id, VIN, 1_750_000_000 + o.id, o.synthetic ?? 0, o.dist, o.temp, o.speed, o.eff, (o.eff * o.dist) / 1000, 90 - Math.round((o.eff * o.dist / 1000) / 0.6), o.driver ?? "Adam").run();
}

describe("digital twin — findSimilarDrives", () => {
  let env: Env;
  beforeEach(async () => { env = makeEnv(); await ensureSchema(env); });

  it("ranks the nearest drive first and predicts from the matches", async () => {
    await drive(env, { id: 1, dist: 340, temp: 30, eff: 190, speed: 95 });  // Eilat-like: hot, fast, long
    await drive(env, { id: 2, dist: 10, temp: 12, eff: 260, speed: 25 });   // short cold city
    await drive(env, { id: 3, dist: 320, temp: 28, eff: 200, speed: 90 });  // near the Eilat query
    const res = await findSimilarDrives(env, VIN, { distance_km: 330, temp_c: 29, avg_speed: 92 }, 3) as any;
    // The two long/hot/fast drives (1 & 3) must rank above the short city drive (2).
    expect(res.matches[0].drive_id === 1 || res.matches[0].drive_id === 3).toBe(true);
    expect(res.matches[res.matches.length - 1].drive_id).toBe(2);
    expect(res.matches[0].similarity_pct).toBeGreaterThan(res.matches[2].similarity_pct);
    // Prediction blends the matched efficiencies (≈190-200), not the 260 outlier.
    expect(res.prediction.efficiency_wh_km).toBeLessThan(230);
    expect(res.prediction.energy_kwh).toBeGreaterThan(0);
  });

  it("excludes synthetic (odometer-recovered) drives from the twin", async () => {
    await drive(env, { id: 1, dist: 100, temp: 20, eff: 160, speed: 60, synthetic: 1 });
    const res = await findSimilarDrives(env, VIN, { distance_km: 100 }, 5) as any;
    expect(res.matches.length).toBe(0);
  });

  it("empty state is graceful", async () => {
    const res = await findSimilarDrives(env, VIN, { distance_km: 50 }, 5) as any;
    expect(res.matches).toEqual([]);
  });
});

describe("trip-question router", () => {
  it("routes trip/range questions to the twin, not general questions", () => {
    expect(looksLikeTripQuestion("driving to Eilat this weekend, what range?")).toBe(true);
    expect(looksLikeTripQuestion("will I make it to Haifa on 60%?")).toBe(true);
    expect(looksLikeTripQuestion("how much charge do I need to reach the airport")).toBe(true);
    expect(looksLikeTripQuestion("how efficient was I this month?")).toBe(false);
    expect(looksLikeTripQuestion("who drives most safely?")).toBe(false);
  });
});
