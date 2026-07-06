/**
 * compactOldHistory: thins (never deletes) a completed drive's route
 * positions / a completed charge session's curve samples once they're older
 * than COMPACT_AFTER_DAYS — the summary row itself (distance, cost, behavior
 * score, etc.) is the long-term "essence" and must always survive untouched.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { compactOldHistory } from "../src/rules";
import { ensureSchema, resetSchemaCacheForTests } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINCOMPACT001";
const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);
const OLD_TS = NOW - 400 * DAY; // well past the 365-day default
const RECENT_TS = NOW - 10 * DAY;

function makeEnv(overrides: Partial<Env> = {}): Env {
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
    ...overrides,
  } as Env;
}

async function insertDrive(env: Env, startTs: number, positionCount: number): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO drives (vin, start_ts, end_ts, status, distance_km, behavior_score, driver)
     VALUES (?1, ?2, ?3, 'complete', 42.5, 91, 'Adam')`,
  )
    .bind(VIN, startTs, startTs + 1800)
    .run();
  const driveId = Number(res.meta.last_row_id ?? 0);
  for (let i = 0; i < positionCount; i++) {
    await env.DB.prepare(
      `INSERT INTO positions (vin, ts, drive_id, lat, lon, speed) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(VIN, startTs + i * 10, driveId, 32.0 + i * 0.001, 34.7 + i * 0.001, 50 + i).run();
  }
  return driveId;
}

async function insertChargeSession(env: Env, startTs: number, curvePoints: number): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO charge_sessions (vin, start_ts, end_ts, status, start_soc, end_soc, energy_added_kwh, cost)
     VALUES (?1, ?2, ?3, 'complete', 20, 80, 35, 12.5)`,
  )
    .bind(VIN, startTs, startTs + 3600)
    .run();
  const sessionId = Number(res.meta.last_row_id ?? 0);
  for (let i = 0; i < curvePoints; i++) {
    await env.DB.prepare(
      `INSERT INTO charges (session_id, vin, ts, soc, charger_power) VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(sessionId, VIN, startTs + i * 60, 20 + i, 50).run();
  }
  return sessionId;
}

describe("compactOldHistory — drives/positions", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("thins an old drive's positions down to the target, keeping first/last and marking it compacted", async () => {
    const driveId = await insertDrive(env, OLD_TS, 500);
    await compactOldHistory(env, {});

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM positions WHERE drive_id = ?1`).bind(driveId).first<{ n: number }>();
    expect(count!.n).toBeLessThan(500);
    expect(count!.n).toBeGreaterThanOrEqual(2);
    expect(count!.n).toBeLessThanOrEqual(65); // default target 60, plus a little slack for endpoints

    const endpoints = await env.DB.prepare(`SELECT MIN(ts) AS first, MAX(ts) AS last FROM positions WHERE drive_id = ?1`).bind(driveId).first<{ first: number; last: number }>();
    expect(endpoints!.first).toBe(OLD_TS);
    expect(endpoints!.last).toBe(OLD_TS + 499 * 10); // the very last sample survives

    const drive = await env.DB.prepare(`SELECT positions_compacted, distance_km, behavior_score, driver FROM drives WHERE id = ?1`).bind(driveId).first<{ positions_compacted: number; distance_km: number; behavior_score: number; driver: string }>();
    expect(drive!.positions_compacted).toBe(1);
    // The essence — the summary row itself — must be completely untouched.
    expect(drive!.distance_km).toBe(42.5);
    expect(drive!.behavior_score).toBe(91);
    expect(drive!.driver).toBe("Adam");
  });

  it("leaves a drive with few positions alone (nothing to trim) but still marks it compacted", async () => {
    const driveId = await insertDrive(env, OLD_TS, 5);
    await compactOldHistory(env, {});
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM positions WHERE drive_id = ?1`).bind(driveId).first<{ n: number }>();
    expect(count!.n).toBe(5);
    const drive = await env.DB.prepare(`SELECT positions_compacted FROM drives WHERE id = ?1`).bind(driveId).first<{ positions_compacted: number }>();
    expect(drive!.positions_compacted).toBe(1);
  });

  it("never touches a recent drive's positions", async () => {
    const driveId = await insertDrive(env, RECENT_TS, 500);
    await compactOldHistory(env, {});
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM positions WHERE drive_id = ?1`).bind(driveId).first<{ n: number }>();
    expect(count!.n).toBe(500);
    const drive = await env.DB.prepare(`SELECT positions_compacted FROM drives WHERE id = ?1`).bind(driveId).first<{ positions_compacted: number | null }>();
    expect(drive!.positions_compacted ?? 0).toBe(0);
  });

  it("is a no-op entirely when COMPACT_AFTER_DAYS=0", async () => {
    const disabledEnv = makeEnv({ COMPACT_AFTER_DAYS: "0" });
    await ensureSchema(disabledEnv);
    const driveId = await insertDrive(disabledEnv, OLD_TS, 500);
    await compactOldHistory(disabledEnv, {});
    const count = await disabledEnv.DB.prepare(`SELECT COUNT(*) AS n FROM positions WHERE drive_id = ?1`).bind(driveId).first<{ n: number }>();
    expect(count!.n).toBe(500);
  });

  it("honours a custom COMPACT_MAX_POINTS", async () => {
    const customEnv = makeEnv({ COMPACT_MAX_POINTS: "20" });
    await ensureSchema(customEnv);
    const driveId = await insertDrive(customEnv, OLD_TS, 500);
    await compactOldHistory(customEnv, {});
    const count = await customEnv.DB.prepare(`SELECT COUNT(*) AS n FROM positions WHERE drive_id = ?1`).bind(driveId).first<{ n: number }>();
    expect(count!.n).toBeLessThanOrEqual(25);
  });

  it("is idempotent — running it again on an already-compacted drive is a no-op", async () => {
    const driveId = await insertDrive(env, OLD_TS, 500);
    await compactOldHistory(env, {});
    const first = await env.DB.prepare(`SELECT COUNT(*) AS n FROM positions WHERE drive_id = ?1`).bind(driveId).first<{ n: number }>();
    await compactOldHistory(env, {});
    const second = await env.DB.prepare(`SELECT COUNT(*) AS n FROM positions WHERE drive_id = ?1`).bind(driveId).first<{ n: number }>();
    expect(second!.n).toBe(first!.n);
  });
});

describe("compactOldHistory — charge sessions/curves", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("thins an old charge session's curve, keeps the session summary intact", async () => {
    const sessionId = await insertChargeSession(env, OLD_TS, 200);
    await compactOldHistory(env, {});

    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM charges WHERE session_id = ?1`).bind(sessionId).first<{ n: number }>();
    expect(count!.n).toBeLessThan(200);
    expect(count!.n).toBeGreaterThanOrEqual(2);

    const session = await env.DB.prepare(`SELECT curve_compacted, energy_added_kwh, cost FROM charge_sessions WHERE id = ?1`).bind(sessionId).first<{ curve_compacted: number; energy_added_kwh: number; cost: number }>();
    expect(session!.curve_compacted).toBe(1);
    expect(session!.energy_added_kwh).toBe(35);
    expect(session!.cost).toBe(12.5);
  });

  it("never touches a recent charge session's curve", async () => {
    const sessionId = await insertChargeSession(env, RECENT_TS, 200);
    await compactOldHistory(env, {});
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM charges WHERE session_id = ?1`).bind(sessionId).first<{ n: number }>();
    expect(count!.n).toBe(200);
  });

  it("reports counts in the summary object", async () => {
    await insertDrive(env, OLD_TS, 500);
    await insertChargeSession(env, OLD_TS, 200);
    const summary: Record<string, unknown> = {};
    await compactOldHistory(env, summary);
    expect(summary.compacted).toMatchObject({ drives: 1, sessions: 1 });
    const c = summary.compacted as { positions_removed: number; charge_points_removed: number };
    expect(c.positions_removed).toBeGreaterThan(0);
    expect(c.charge_points_removed).toBeGreaterThan(0);
  });
});
