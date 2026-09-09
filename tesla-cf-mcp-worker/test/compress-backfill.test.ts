/**
 * The retroactive sweep: what it removes, what it must never touch, and when it
 * has to stop.
 *
 * This is the destructive half of the feature, so the negative assertions carry
 * the weight — drive samples survive, recent days are left alone, and a run that
 * runs out of budget resumes rather than restarts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { compressOldHistory } from "../src/rules";
import { ensureSchema, resetSchemaCacheForTests } from "../src/store";
import { resetMeterForTests } from "../src/d1meter";
import { FIELD_GROUPS } from "../src/compress";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINBACKFILL01";
const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);
/** Start of a UTC day well inside the sweep's window (older than the 2-day lag). */
const OLD_DAY = Math.floor((NOW - 10 * DAY) / DAY) * DAY;
const RECENT_DAY = Math.floor((NOW - 1 * DAY) / DAY) * DAY;

function makeEnv(extra: Partial<Env> = {}): Env {
  resetSchemaCacheForTests();
  resetMeterForTests();
  return {
    TESLA_KV: new FakeKV() as unknown as KVNamespace,
    DB: new FakeD1() as unknown as D1Database,
    TESLA_REGION: "eu",
    PUBLIC_ORIGIN: "https://test.example.com",
    TESLA_CLIENT_ID: "cid",
    TESLA_CLIENT_SECRET: "csecret",
    TESLA_PRIVATE_KEY: "pk",
    MCP_AUTH_TOKEN: "tok",
    POLL_VINS: VIN,
    ...extra,
  } as Env;
}

async function seed(env: Env, field: string, dayStart: number, value: (i: number) => number | string, n = 300): Promise<void> {
  const stmt = env.DB.prepare(
    `INSERT OR REPLACE INTO telemetry_events (vin, ts, field, value_num, value_text) VALUES (?1, ?2, ?3, ?4, ?5)`,
  );
  const rows = [];
  for (let i = 0; i < n; i++) {
    const v = value(i);
    rows.push(
      stmt.bind(VIN, dayStart + i * 60, field, typeof v === "number" ? v : null, typeof v === "number" ? null : v),
    );
  }
  await env.DB.batch(rows);
}

async function count(env: Env, field: string, from?: number, to?: number): Promise<number> {
  const sql =
    from === undefined
      ? `SELECT COUNT(*) AS n FROM telemetry_events WHERE vin = ?1 AND field = ?2`
      : `SELECT COUNT(*) AS n FROM telemetry_events WHERE vin = ?1 AND field = ?2 AND ts >= ?3 AND ts < ?4`;
  const stmt =
    from === undefined
      ? env.DB.prepare(sql).bind(VIN, field)
      : env.DB.prepare(sql).bind(VIN, field, from, to);
  return (await stmt.first<{ n: number }>())?.n ?? 0;
}

describe("compressOldHistory", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("thins an old day and leaves the newest days alone", async () => {
    await seed(env, "locked", OLD_DAY, () => 1);
    await seed(env, "locked", RECENT_DAY, () => 1);

    const summary: Record<string, unknown> = {};
    await compressOldHistory(env, summary);

    // The old day collapses to the run start plus its hourly anchors.
    expect(await count(env, "locked", OLD_DAY, OLD_DAY + DAY)).toBeLessThan(20);
    // The last two days are still being written and are already write-filtered.
    expect(await count(env, "locked", RECENT_DAY, RECENT_DAY + DAY)).toBe(300);
    expect(summary.compressed).toMatchObject({ rows_removed: expect.any(Number) });
  });

  it("never removes a sample recorded during a drive", async () => {
    await seed(env, "isolation_resistance", OLD_DAY, () => 900);
    // A drive covering the middle third of that day.
    const driveStart = OLD_DAY + 100 * 60;
    const driveEnd = OLD_DAY + 200 * 60;
    await env.DB.prepare(
      `INSERT INTO drives (vin, start_ts, end_ts, status) VALUES (?1, ?2, ?3, 'complete')`,
    ).bind(VIN, driveStart, driveEnd).run();

    await compressOldHistory(env, {});

    const inDrive = await count(env, "isolation_resistance", driveStart, driveEnd + 1);
    expect(inDrive).toBe(101); // every sample in the drive window survives
    expect(await count(env, "isolation_resistance")).toBeLessThan(140);
  });

  it("keeps group members on identical timestamps", async () => {
    for (const field of FIELD_GROUPS.pack_brick!) {
      await seed(env, field, OLD_DAY, (i) => (field === "pack_current" ? Math.sin(i / 5) : 3.9 + Math.sin(i / 5) / 500));
    }
    await compressOldHistory(env, {});

    const stamps: number[][] = [];
    for (const field of FIELD_GROUPS.pack_brick!) {
      const rs = await env.DB.prepare(
        `SELECT ts FROM telemetry_events WHERE vin = ?1 AND field = ?2 ORDER BY ts`,
      ).bind(VIN, field).all<{ ts: number }>();
      stamps.push((rs.results ?? []).map((r) => r.ts));
    }
    for (const s of stamps) expect(s).toEqual(stamps[0]);
    expect(stamps[0]!.length).toBeLessThan(300);
  });

  it("is idempotent — a second run finds nothing left to do", async () => {
    await seed(env, "locked", OLD_DAY, () => 1);
    const first: Record<string, unknown> = {};
    await compressOldHistory(env, first);
    const afterFirst = await count(env, "locked");

    const second: Record<string, unknown> = {};
    await compressOldHistory(env, second);
    expect(await count(env, "locked")).toBe(afterFirst);
    // The cursor has passed that day, so the second run does not re-read it.
    expect((second.compressed as { rows_removed: number } | undefined)?.rows_removed ?? 0).toBe(0);
  });

  it("resumes from the cursor instead of restarting", async () => {
    // Three old days; a tight row budget stops the first run partway.
    for (const d of [0, 1, 2]) await seed(env, "locked", OLD_DAY + d * DAY, () => 1);
    const tight = makeEnv({ COMPRESS_BACKFILL_ROWS_PER_RUN: "100" });
    await ensureSchema(tight);
    tight.DB = env.DB; // same database, tighter budget

    await compressOldHistory(tight, {});
    const afterFirst = await count(env, "locked");
    expect(afterFirst).toBeLessThan(900);
    expect(afterFirst).toBeGreaterThan(20); // did not get through all three days

    await compressOldHistory(tight, {});
    expect(await count(env, "locked")).toBeLessThan(afterFirst);
  });

  it("does nothing at all when the read budget is already spent", async () => {
    await seed(env, "locked", OLD_DAY, () => 1);
    const capped = makeEnv({ D1_READ_SOFT_LIMIT: "10" });
    capped.DB = env.DB;
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS d1_usage (day TEXT PRIMARY KEY, rows_read INTEGER NOT NULL, updated_ts INTEGER)`,
    ).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO d1_usage (day, rows_read, updated_ts) VALUES (?1, ?2, ?3)`)
      .bind(new Date().toISOString().slice(0, 10), 5_000_000, NOW)
      .run();

    const summary: Record<string, unknown> = {};
    await compressOldHistory(capped, summary);
    expect(summary.compress_skipped).toBe("read_budget");
    expect(await count(env, "locked")).toBe(300);
  });

  it("is disabled by COMPRESS_ENABLED=0", async () => {
    await seed(env, "locked", OLD_DAY, () => 1);
    const off = makeEnv({ COMPRESS_ENABLED: "0" });
    off.DB = env.DB;
    await compressOldHistory(off, {});
    expect(await count(env, "locked")).toBe(300);
  });

  it("leaves an unclassified field untouched", async () => {
    await seed(env, "some_unmapped_field", OLD_DAY, () => 1);
    await compressOldHistory(env, {});
    expect(await count(env, "some_unmapped_field")).toBe(300);
  });
});
