/**
 * getPackHealth: brick-voltage spread (rest vs load, classified by the
 * pack_current sample at the SAME timestamp), weak-brick dominance, module
 * temp spread and the isolation-resistance trend. Pairs with no same-ts
 * pack_current must be SKIPPED, not guessed into a bucket — one wild
 * unclassifiable pair must not smear the averages.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ensureSchema, resetSchemaCacheForTests, recordEvents } from "../src/store";
import { getPackHealth } from "../src/tracking";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINPACKH00001";
const NOW = Math.floor(Date.now() / 1000);

// Noon UTC of the day containing ts — keeps a fixture cluster safely inside
// one daily bucket and one first/last-week window regardless of run time.
const noonOf = (ts: number): number => Math.floor(ts / 86400) * 86400 + 12 * 3600;
const dayOf = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10);

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

interface PackSample {
  vmax?: number; vmin?: number; current?: number;
  tmax?: number; tmin?: number; iso?: number; minNum?: number;
}

async function recordPackSample(env: Env, ts: number, o: PackSample): Promise<void> {
  const events: { field: string; value: unknown; ts: number }[] = [];
  if (o.vmax !== undefined) events.push({ field: "brick_v_max", value: o.vmax, ts });
  if (o.vmin !== undefined) events.push({ field: "brick_v_min", value: o.vmin, ts });
  if (o.current !== undefined) events.push({ field: "pack_current", value: o.current, ts });
  if (o.tmax !== undefined) events.push({ field: "module_temp_max", value: o.tmax, ts });
  if (o.tmin !== undefined) events.push({ field: "module_temp_min", value: o.tmin, ts });
  if (o.iso !== undefined) events.push({ field: "isolation_resistance", value: o.iso, ts });
  if (o.minNum !== undefined) events.push({ field: "brick_v_min_num", value: o.minNum, ts });
  await recordEvents(env, VIN, events);
}

describe("getPackHealth", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("reports has_data:false with guidance when the BMS fields have never streamed", async () => {
    const res = (await getPackHealth(env, VIN, 30)) as { has_data: boolean; note?: string };
    expect(res.has_data).toBe(false);
    expect(res.note).toMatch(/configure_telemetry/);
    expect(res.note).toMatch(/BrickVoltageMax/);
  });

  it("healthy pack: rest/load buckets from same-ts pairing, stable trends, healthy verdict", async () => {
    const t1 = noonOf(NOW - 29 * 86400); // first week of the 30-day window
    const t2 = noonOf(NOW - 86400); // last week
    // First week: three resting samples at a tight 10 mV spread, mild temps.
    for (const dt of [0, 60, 120]) {
      await recordPackSample(env, t1 + dt, { vmax: 3.91, vmin: 3.9, current: 0.8, tmax: 27.5, tmin: 25.0, iso: 3200 });
    }
    // Last week: two rest pairs (11 mV), one genuine load pair (35 mV @ -185 A),
    // one dead-band pair (10 A — belongs to NEITHER bucket), and one wild pair
    // with no same-ts pack_current at all (must be skipped, not classified —
    // its 1100 mV "spread" would wreck both averages if it leaked in).
    await recordPackSample(env, t2, { vmax: 3.906, vmin: 3.895, current: -1.2, iso: 3150 });
    await recordPackSample(env, t2 + 60, { vmax: 3.906, vmin: 3.895, current: -1.2 });
    await recordPackSample(env, t2 + 120, { vmax: 3.93, vmin: 3.895, current: -185 });
    await recordPackSample(env, t2 + 180, { vmax: 3.95, vmin: 3.9, current: 10 });
    await recordPackSample(env, t2 + 240, { vmax: 4.1, vmin: 3.0 });
    // brick_v_min_num rotates — no single brick dominates.
    const bricks = [3, 47, 12, 3, 96, 21];
    for (let i = 0; i < bricks.length; i++) {
      await recordPackSample(env, t1 + i, { minNum: bricks[i] });
    }

    const res = (await getPackHealth(env, VIN, 30)) as {
      has_data: boolean;
      daily: Record<string, unknown>[];
      weak_brick: unknown;
      isolation_trend: Record<string, unknown>;
      rest_spread_trend: Record<string, unknown>;
      summary: string;
    };
    expect(res.has_data).toBe(true);
    expect(res.weak_brick).toBeNull();
    expect(res.daily.find((d) => d.day === dayOf(t1))).toMatchObject({
      rest_avg_spread_mv: 10, rest_samples: 3, load_samples: 0,
      module_temp_spread_c: 2.5, min_isolation_kohm: 3200,
    });
    expect(res.daily.find((d) => d.day === dayOf(t2))).toMatchObject({
      rest_avg_spread_mv: 11, rest_max_spread_mv: 11, rest_samples: 2,
      load_avg_spread_mv: 35, load_samples: 1,
      min_isolation_kohm: 3150,
    });
    expect(res.rest_spread_trend).toMatchObject({ first_week_avg_mv: 10, last_week_avg_mv: 11, rising: false });
    expect(res.isolation_trend).toMatchObject({ first_week_avg_kohm: 3200, last_week_avg_kohm: 3150, declining: false });
    expect(res.summary).toMatch(/healthy/i);
  });

  it("flags a brick that dominates the minimum-voltage samples as the weak cell", async () => {
    const t0 = noonOf(NOW - 3 * 86400);
    const bricks = [42, 42, 42, 42, 42, 42, 42, 42, 17, 17]; // brick 42 lowest in 80%
    for (let i = 0; i < bricks.length; i++) {
      await recordPackSample(env, t0 + i * 60, { vmax: 3.902, vmin: 3.88, current: 0.5, minNum: bricks[i] });
    }
    const res = (await getPackHealth(env, VIN, 30)) as { weak_brick: { number: number; share: number }; summary: string };
    expect(res.weak_brick).toMatchObject({ number: 42, share: 0.8 });
    expect(res.summary).toMatch(/[Bb]rick 42/);
  });

  it("does not call a weak brick on a handful of samples", async () => {
    const t0 = noonOf(NOW - 2 * 86400);
    for (let i = 0; i < 4; i++) {
      await recordPackSample(env, t0 + i * 60, { minNum: 42 }); // 100% share but only 4 samples
    }
    const res = (await getPackHealth(env, VIN, 30)) as { has_data: boolean; weak_brick: unknown };
    expect(res.has_data).toBe(true);
    expect(res.weak_brick).toBeNull();
  });

  it("flags a >10% isolation-resistance decline as service-worthy", async () => {
    const t1 = noonOf(NOW - 28 * 86400);
    const t2 = noonOf(NOW - 86400);
    await recordPackSample(env, t1, { iso: 4200 });
    await recordPackSample(env, t1 + 3600, { iso: 4100 });
    await recordPackSample(env, t2, { iso: 3300 });
    await recordPackSample(env, t2 + 3600, { iso: 3200 });
    const res = (await getPackHealth(env, VIN, 30)) as {
      has_data: boolean;
      isolation_trend: { first_week_avg_kohm: number; last_week_avg_kohm: number; declining: boolean; note: string };
      summary: string;
    };
    expect(res.has_data).toBe(true);
    expect(res.isolation_trend).toMatchObject({ first_week_avg_kohm: 4150, last_week_avg_kohm: 3250, declining: true });
    expect(res.isolation_trend.note).toMatch(/service-worthy/);
    expect(res.summary).toMatch(/service/i);
  });
});
