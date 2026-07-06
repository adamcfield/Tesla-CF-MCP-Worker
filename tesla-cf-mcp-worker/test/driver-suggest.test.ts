/**
 * suggestDriverForDrive's two-tier outcome: a confident, well-supported
 * place+time match auto-assigns `driver` itself (driver_source='auto');
 * a weaker or ambiguous match only populates `suggested_driver` for a human
 * to confirm, same as before. setDriveDriver (the human-facing write) always
 * tags driver_source='manual' and overrides whatever the system decided.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ensureSchema, resetSchemaCacheForTests } from "../src/store";
import { setDriveDriver, suggestDriverForDrive } from "../src/tracking";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINDRIVER0001";
// A fixed weekday timestamp; candidates offset by whole weeks land in the
// same weekday-type × 3-hour bucket (DEFAULT_TZ pinned to UTC below).
const BASE_TS = 1_750_000_000; // 2025-06-15 14:13 UTC — a Sunday
const WEEK = 7 * 86400;
const HOME = { lat: 32.05, lon: 34.78 };
const OTHER_PLACE = { lat: 31.9, lon: 34.6 }; // >1km away — no place match

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
    DEFAULT_TZ: "Etc/UTC",
  } as Env;
}

async function insertDrive(
  env: Env,
  o: { start_ts: number; lat: number; lon: number; driver: string | null; fp_temp_set?: number | null; fp_seat_heater?: number | null },
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO drives (vin, start_ts, end_ts, status, distance_km, start_lat, start_lon, driver, fp_temp_set, fp_seat_heater)
     VALUES (?1, ?2, ?3, 'complete', 5, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(VIN, o.start_ts, o.start_ts + 600, o.lat, o.lon, o.driver, o.fp_temp_set ?? null, o.fp_seat_heater ?? null)
    .run();
  return Number(res.meta.last_row_id ?? 0);
}

describe("suggestDriverForDrive — auto-assign vs suggest", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("auto-assigns when one driver has ≥3 unambiguous same place+time matches", async () => {
    for (let i = 1; i <= 3; i++) {
      await insertDrive(env, { start_ts: BASE_TS - i * WEEK, lat: HOME.lat, lon: HOME.lon, driver: "Adam" });
    }
    const targetId = await insertDrive(env, { start_ts: BASE_TS, lat: HOME.lat, lon: HOME.lon, driver: null });

    await suggestDriverForDrive(env, targetId, VIN);

    const row = await env.DB.prepare(`SELECT driver, suggested_driver, driver_source FROM drives WHERE id = ?1`).bind(targetId).first<{ driver: string | null; suggested_driver: string | null; driver_source: string | null }>();
    expect(row?.driver).toBe("Adam");
    expect(row?.driver_source).toBe("auto");
    expect(row?.suggested_driver).toBeNull();
  });

  it("only suggests (never auto-assigns) with just one or two supporting drives", async () => {
    await insertDrive(env, { start_ts: BASE_TS - WEEK, lat: HOME.lat, lon: HOME.lon, driver: "Adam" });
    await insertDrive(env, { start_ts: BASE_TS - 2 * WEEK, lat: HOME.lat, lon: HOME.lon, driver: "Adam" });
    const targetId = await insertDrive(env, { start_ts: BASE_TS, lat: HOME.lat, lon: HOME.lon, driver: null });

    await suggestDriverForDrive(env, targetId, VIN);

    const row = await env.DB.prepare(`SELECT driver, suggested_driver, driver_source FROM drives WHERE id = ?1`).bind(targetId).first<{ driver: string | null; suggested_driver: string | null; driver_source: string | null }>();
    expect(row?.driver).toBeNull();
    expect(row?.driver_source).toBeNull();
    expect(row?.suggested_driver).toBe("Adam");
  });

  it("falls back to a suggestion (not an auto-assign) when two drivers are both well-supported and close", async () => {
    // Both Adam and Sara have 3 matching drives each at the same place/time —
    // plenty of history, but no clear winner, so this must stay a suggestion.
    for (let i = 1; i <= 3; i++) {
      await insertDrive(env, { start_ts: BASE_TS - i * WEEK, lat: HOME.lat, lon: HOME.lon, driver: "Adam" });
      // A few minutes apart — same weekday-type/3-hour bucket as the target,
      // just a distinct row (drives can't share a start_ts with another distinct id here).
      await insertDrive(env, { start_ts: BASE_TS - i * WEEK - 60, lat: HOME.lat, lon: HOME.lon, driver: "Sara" });
    }
    const targetId = await insertDrive(env, { start_ts: BASE_TS, lat: HOME.lat, lon: HOME.lon, driver: null });

    await suggestDriverForDrive(env, targetId, VIN);

    const row = await env.DB.prepare(`SELECT driver, suggested_driver, driver_source FROM drives WHERE id = ?1`).bind(targetId).first<{ driver: string | null; suggested_driver: string | null; driver_source: string | null }>();
    expect(row?.driver).toBeNull();
    expect(row?.driver_source).toBeNull();
    expect(row?.suggested_driver).not.toBeNull();
  });

  it("does nothing when there's no place/time history at all", async () => {
    await insertDrive(env, { start_ts: BASE_TS - WEEK, lat: OTHER_PLACE.lat, lon: OTHER_PLACE.lon, driver: "Adam" });
    const targetId = await insertDrive(env, { start_ts: BASE_TS, lat: HOME.lat, lon: HOME.lon, driver: null });

    await suggestDriverForDrive(env, targetId, VIN);

    const row = await env.DB.prepare(`SELECT driver, suggested_driver FROM drives WHERE id = ?1`).bind(targetId).first<{ driver: string | null; suggested_driver: string | null }>();
    expect(row?.driver).toBeNull();
    expect(row?.suggested_driver).toBeNull();
  });

  it("leaves an already-tagged drive alone", async () => {
    const targetId = await insertDrive(env, { start_ts: BASE_TS, lat: HOME.lat, lon: HOME.lon, driver: "Sara" });
    await suggestDriverForDrive(env, targetId, VIN);
    const row = await env.DB.prepare(`SELECT driver, suggested_driver FROM drives WHERE id = ?1`).bind(targetId).first<{ driver: string | null; suggested_driver: string | null }>();
    expect(row?.driver).toBe("Sara");
    expect(row?.suggested_driver).toBeNull();
  });
});

describe("setDriveDriver — human assignment always tags 'manual' and overrides auto", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("tags a fresh manual assignment as driver_source='manual'", async () => {
    const id = await insertDrive(env, { start_ts: BASE_TS, lat: HOME.lat, lon: HOME.lon, driver: null });
    await setDriveDriver(env, id, "Adam");
    const row = await env.DB.prepare(`SELECT driver, driver_source FROM drives WHERE id = ?1`).bind(id).first<{ driver: string | null; driver_source: string | null }>();
    expect(row?.driver).toBe("Adam");
    expect(row?.driver_source).toBe("manual");
  });

  it("overrides a system auto-assignment and flips the source to manual", async () => {
    for (let i = 1; i <= 3; i++) {
      await insertDrive(env, { start_ts: BASE_TS - i * WEEK, lat: HOME.lat, lon: HOME.lon, driver: "Adam" });
    }
    const targetId = await insertDrive(env, { start_ts: BASE_TS, lat: HOME.lat, lon: HOME.lon, driver: null });
    await suggestDriverForDrive(env, targetId, VIN);
    let row = await env.DB.prepare(`SELECT driver, driver_source FROM drives WHERE id = ?1`).bind(targetId).first<{ driver: string | null; driver_source: string | null }>();
    expect(row?.driver).toBe("Adam");
    expect(row?.driver_source).toBe("auto");

    // The system got it wrong (or the human just wants to correct it) — a
    // manual assignment must always win and be clearly re-tagged.
    await setDriveDriver(env, targetId, "Sara");
    row = await env.DB.prepare(`SELECT driver, driver_source FROM drives WHERE id = ?1`).bind(targetId).first<{ driver: string | null; driver_source: string | null }>();
    expect(row?.driver).toBe("Sara");
    expect(row?.driver_source).toBe("manual");
  });

  it("clearing a driver (driver=null) also clears driver_source", async () => {
    const id = await insertDrive(env, { start_ts: BASE_TS, lat: HOME.lat, lon: HOME.lon, driver: null });
    await setDriveDriver(env, id, "Adam");
    await setDriveDriver(env, id, null);
    const row = await env.DB.prepare(`SELECT driver, driver_source FROM drives WHERE id = ?1`).bind(id).first<{ driver: string | null; driver_source: string | null }>();
    expect(row?.driver).toBeNull();
    expect(row?.driver_source).toBeNull();
  });
});
