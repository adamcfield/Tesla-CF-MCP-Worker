/**
 * The write-side gate: what recordEvents actually stores, and what it drops.
 *
 * This is the half that stops the bleeding on every ingest, so the assertions
 * that matter are the negative ones — a parked car re-reporting the same value
 * must cost nothing, and a drive must still cost everything.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { applyIngest } from "../src/ingest";
import { ensureSchema, recordEvents, resetSchemaCacheForTests } from "../src/store";
import { DEFAULT_MAX_GAP_S } from "../src/compress";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
});
afterEach(() => vi.restoreAllMocks());

const VIN = "TESTVINWRITEGATE1";
const T = Math.floor(Date.now() / 1000) - 7200;

function makeEnv(extra: Partial<Env> = {}): Env {
  resetSchemaCacheForTests();
  return {
    TESLA_KV: new FakeKV() as unknown as KVNamespace,
    DB: new FakeD1() as unknown as D1Database,
    TESLA_REGION: "eu",
    PUBLIC_ORIGIN: "https://test.example.com",
    TESLA_CLIENT_ID: "cid",
    TESLA_CLIENT_SECRET: "secret",
    TESLA_PRIVATE_KEY: "pk",
    MCP_AUTH_TOKEN: "tok",
    ...extra,
  } as Env;
}

async function countRows(env: Env, field?: string): Promise<number> {
  const sql = field
    ? `SELECT COUNT(*) AS n FROM telemetry_events WHERE vin = ?1 AND field = ?2`
    : `SELECT COUNT(*) AS n FROM telemetry_events WHERE vin = ?1`;
  const stmt = field ? env.DB.prepare(sql).bind(VIN, field) : env.DB.prepare(sql).bind(VIN);
  return (await stmt.first<{ n: number }>())?.n ?? 0;
}

describe("write gate — step fields", () => {
  it("stores an unchanged value once, not once per sample", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    for (let i = 0; i < 30; i++) {
      await recordEvents(env, VIN, [{ field: "locked", value: true, ts: T + i * 60 }], { compress: true });
    }
    expect(await countRows(env, "locked")).toBe(1);
  });

  it("stores the transition, so the moment it changed is exact", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    for (let i = 0; i < 10; i++) {
      await recordEvents(env, VIN, [{ field: "locked", value: true, ts: T + i * 60 }], { compress: true });
    }
    await recordEvents(env, VIN, [{ field: "locked", value: false, ts: T + 600 }], { compress: true });

    const rs = await env.DB.prepare(
      `SELECT ts, value_num FROM telemetry_events WHERE vin = ?1 AND field = 'locked' ORDER BY ts`,
    ).bind(VIN).all<{ ts: number; value_num: number }>();
    expect(rs.results).toEqual([
      { ts: T, value_num: 1 },
      { ts: T + 600, value_num: 0 },
    ]);
  });

  it("re-anchors once maxGapS has passed, so a gap still means lost data", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    // Twelve hours of an unchanging value, one sample a minute.
    for (let i = 0; i <= 720; i++) {
      await recordEvents(env, VIN, [{ field: "sentry", value: "armed", ts: T + i * 60 }], { compress: true });
    }
    const rs = await env.DB.prepare(
      `SELECT ts FROM telemetry_events WHERE vin = ?1 AND field = 'sentry' ORDER BY ts`,
    ).bind(VIN).all<{ ts: number }>();
    const stamps = (rs.results ?? []).map((r) => r.ts);
    expect(stamps.length).toBe(1 + Math.floor((720 * 60) / DEFAULT_MAX_GAP_S)); // first + one per anchor interval
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]! - stamps[i - 1]!).toBeLessThanOrEqual(DEFAULT_MAX_GAP_S + 60);
    }
  });
});

describe("write gate — analog deadband", () => {
  it("drops wobble inside epsilon and keeps a real excursion", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    // tpms_fl epsilon is 0.02 bar.
    const vals = [2.9, 2.905, 2.895, 2.91, 2.9, 2.95];
    for (let i = 0; i < vals.length; i++) {
      await recordEvents(env, VIN, [{ field: "tpms_fl", value: vals[i], ts: T + i * 300 }], { compress: true });
    }
    const rs = await env.DB.prepare(
      `SELECT value_num FROM telemetry_events WHERE vin = ?1 AND field = 'tpms_fl' ORDER BY ts`,
    ).bind(VIN).all<{ value_num: number }>();
    expect((rs.results ?? []).map((r) => r.value_num)).toEqual([2.9, 2.95]);
  });
});

describe("write gate — field groups", () => {
  it("writes every member of a group whenever any one of them is written", async () => {
    // Otherwise the pack-health join (ON equal ts) stops finding pairs.
    const env = makeEnv();
    await ensureSchema(env);
    const send = (i: number, current: number) =>
      recordEvents(
        env,
        VIN,
        [
          { field: "brick_v_max", value: 3.91, ts: T + i * 60 },
          { field: "brick_v_min", value: 3.9, ts: T + i * 60 },
          { field: "pack_current", value: current, ts: T + i * 60 },
        ],
        { compress: true },
      );
    await send(0, 0.1);
    await send(1, 0.1); // nothing moved — no rows at all
    await send(2, 40); // pack_current jumps; the whole group must land

    const rs = await env.DB.prepare(
      `SELECT ts, COUNT(*) AS n FROM telemetry_events
       WHERE vin = ?1 AND field IN ('brick_v_max','brick_v_min','pack_current')
       GROUP BY ts ORDER BY ts`,
    ).bind(VIN).all<{ ts: number; n: number }>();
    expect(rs.results).toEqual([
      { ts: T, n: 3 },
      { ts: T + 120, n: 3 },
    ]);
  });
});

describe("write gate — when it must not apply", () => {
  it("stores every sample while the car is driving", async () => {
    const env = makeEnv();
    for (let i = 0; i < 10; i++) {
      await applyIngest(
        env,
        { vin: VIN, ts: T + i * 60, fields: { Gear: "D", VehicleSpeed: 60, Locked: true, SentryMode: "off" } },
      );
    }
    // `locked` is a step field that never changes here, so a compressed write
    // would collapse it to one row. Driving must not compress.
    expect(await countRows(env, "locked")).toBe(10);
  });

  it("stores every sample when COMPRESS_ENABLED is off", async () => {
    const env = makeEnv({ COMPRESS_ENABLED: "0" });
    await ensureSchema(env);
    for (let i = 0; i < 10; i++) {
      await recordEvents(env, VIN, [{ field: "locked", value: true, ts: T + i * 60 }], { compress: true });
    }
    expect(await countRows(env, "locked")).toBe(10);
  });

  it("stores an unclassified field in full", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    for (let i = 0; i < 10; i++) {
      await recordEvents(env, VIN, [{ field: "brand_new_field", value: 1, ts: T + i * 60 }], { compress: true });
    }
    expect(await countRows(env, "brand_new_field")).toBe(10);
  });
});

describe("write gate — end to end on a parked car", () => {
  it("collapses an hour of parked telemetry to a handful of rows", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    let written = 0;
    for (let i = 0; i < 60; i++) {
      const ts = T + i * 60;
      await recordEvents(
        env,
        VIN,
        [
          { field: "locked", value: true, ts },
          { field: "sentry", value: "armed", ts },
          { field: "door_state", value: "Closed", ts },
          { field: "hvac_power", value: false, ts },
          { field: "odometer", value: 51234.5, ts },
          { field: "isolation_resistance", value: 900 + (i % 3), ts },
          { field: "tpms_fl", value: 2.9 + (i % 2) * 0.004, ts },
        ],
        { compress: true },
      );
      written += 7;
    }
    const stored = await countRows(env);
    expect(written).toBe(420);
    // Only isolation_resistance genuinely moves (epsilon 5, wobble 0-2 -> flat),
    // so almost everything collapses to first-sample plus the hourly anchor.
    expect(stored).toBeLessThan(20);
  });
});
