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
import { backfillSyntheticDrives, getVampireDrain } from "../src/tracking";
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

  it("thins a three-month-old day harder than a ten-day-old one", async () => {
    // Age tiering: the same shape of day should cost fewer rows the older it
    // gets, because nobody trends month-old telemetry at four-hour resolution.
    const COLD_DAY = Math.floor((NOW - 200 * DAY) / DAY) * DAY;
    await seed(env, "locked", OLD_DAY, () => 1, 1440);
    await seed(env, "locked", COLD_DAY, () => 1, 1440);
    await compressOldHistory(env, {});

    const gaps = async (from: number): Promise<number[]> => {
      const rs = await env.DB.prepare(
        `SELECT ts FROM telemetry_events WHERE vin = ?1 AND field = 'locked' AND ts >= ?2 AND ts < ?3 ORDER BY ts`,
      ).bind(VIN, from, from + DAY).all<{ ts: number }>();
      const ts = (rs.results ?? []).map((r) => r.ts);
      return ts.slice(1).map((t, i) => t - ts[i]!);
    };
    const warm = await gaps(OLD_DAY);
    const cold = await gaps(COLD_DAY);

    // Both collapse from 1440 rows to a handful; what the tier changes is how
    // far apart the survivors are allowed to be.
    expect(warm.length + 1).toBeLessThan(10);
    expect(cold.length + 1).toBeLessThan(10);
    expect(Math.max(...cold)).toBeGreaterThan(Math.max(...warm));
    expect(cold.length).toBeGreaterThan(0); // still legible, just coarser
  });

  it("leaves an unclassified field untouched", async () => {
    await seed(env, "some_unmapped_field", OLD_DAY, () => 1);
    await compressOldHistory(env, {});
    expect(await count(env, "some_unmapped_field")).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// positions
// ---------------------------------------------------------------------------

interface PosRow {
  ts: number;
  soc: number;
  odometer: number;
  activity: string;
  charging_state: string | null;
  drive_id?: number | null;
}

async function seedPositions(env: Env, rows: PosRow[]): Promise<void> {
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO positions (vin, ts, soc, odometer, activity, charging_state, drive_id, lat, lon)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 32.1, 34.8)`,
    )
      .bind(VIN, r.ts, r.soc, r.odometer, r.activity, r.charging_state, r.drive_id ?? null)
      .run();
  }
}

async function positionCount(env: Env): Promise<number> {
  return (
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM positions WHERE vin = ?1`).bind(VIN).first<{ n: number }>())
      ?.n ?? 0
  );
}

/** A parked day: SoC drifting down slowly, odometer flat. */
function parkedDay(dayStart: number, odometer = 1000): PosRow[] {
  const rows: PosRow[] = [];
  for (let i = 0; i < 288; i++) {
    rows.push({
      ts: dayStart + i * 300,
      soc: Number((70 - i * 0.005).toFixed(3)),
      odometer,
      activity: "idle",
      charging_state: "Disconnected",
    });
  }
  return rows;
}

describe("compressOldHistory — positions", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("thins parked rows", async () => {
    await seedPositions(env, parkedDay(OLD_DAY));
    await compressOldHistory(env, {});
    const left = await positionCount(env);
    expect(left).toBeLessThan(288);
    expect(left).toBeGreaterThan(0);
  });

  it("never touches rows attached to a drive", async () => {
    await env.DB.prepare(
      `INSERT INTO drives (vin, start_ts, end_ts, status) VALUES (?1, ?2, ?3, 'complete')`,
    ).bind(VIN, OLD_DAY + 3600, OLD_DAY + 5400).run();
    const driveId = (
      await env.DB.prepare(`SELECT id FROM drives WHERE vin = ?1`).bind(VIN).first<{ id: number }>()
    )!.id;

    const rows: PosRow[] = [];
    for (let i = 0; i < 60; i++) {
      rows.push({
        ts: OLD_DAY + 3600 + i * 30,
        soc: 70,
        odometer: 1000 + i * 0.2,
        activity: "driving",
        charging_state: null,
        drive_id: driveId,
      });
    }
    await seedPositions(env, rows);
    await seedPositions(env, parkedDay(OLD_DAY + 2 * DAY));

    await compressOldHistory(env, {});
    const inDrive = (
      await env.DB.prepare(`SELECT COUNT(*) AS n FROM positions WHERE vin = ?1 AND drive_id IS NOT NULL`)
        .bind(VIN)
        .first<{ n: number }>()
    )?.n;
    expect(inDrive).toBe(60);
  });

  it("keeps every activity transition, so stage boundaries are unchanged", async () => {
    const rows: PosRow[] = [];
    for (let i = 0; i < 100; i++) {
      rows.push({ ts: OLD_DAY + i * 300, soc: 70, odometer: 1000, activity: "idle", charging_state: "Disconnected" });
    }
    rows.push({ ts: OLD_DAY + 100 * 300, soc: 70, odometer: 1000, activity: "charging", charging_state: "Charging" });
    for (let i = 101; i < 150; i++) {
      rows.push({ ts: OLD_DAY + i * 300, soc: 75, odometer: 1000, activity: "charging", charging_state: "Charging" });
    }
    await seedPositions(env, rows);
    await compressOldHistory(env, {});

    const rs = await env.DB.prepare(
      `SELECT ts FROM positions WHERE vin = ?1 AND activity = 'charging' ORDER BY ts LIMIT 1`,
    ).bind(VIN).first<{ ts: number }>();
    expect(rs?.ts).toBe(OLD_DAY + 100 * 300);
  });

  it("recovers the same synthetic drives after thinning as before", async () => {
    // THE hazard: backfillSyntheticDrives fabricates a drive from an odometer
    // jump between two ADJACENT rows. Deleting rows makes distant rows
    // adjacent, so a careless thinning could invent or lose drives outright —
    // and it WRITES to the drives table, so the damage would persist.
    // odometer is a counter, whose run endpoints are always retained, which is
    // what keeps the same pairs adjacent across the same gaps.
    const build = (): PosRow[] => {
      const rows = parkedDay(OLD_DAY, 1000);
      // Car driven away and back during a six-hour telemetry gap: a 40 km jump.
      // The gap has to be long enough that the implied speed stays under the
      // 160 km/h sanity ceiling, or no drive is synthesised at all.
      for (let i = 0; i < 288; i++) {
        rows.push({
          ts: OLD_DAY + DAY + 6 * 3600 + i * 300,
          soc: Number((60 - i * 0.005).toFixed(3)),
          odometer: 1040,
          activity: "idle",
          charging_state: "Disconnected",
        });
      }
      return rows;
    };

    const dense = makeEnv();
    await ensureSchema(dense);
    await seedPositions(dense, build());
    const denseRes = (await backfillSyntheticDrives(dense, VIN)) as { drives_recovered: number };

    const thin = makeEnv();
    await ensureSchema(thin);
    await seedPositions(thin, build());
    await compressOldHistory(thin, {});
    const thinRes = (await backfillSyntheticDrives(thin, VIN)) as { drives_recovered: number };

    expect(denseRes.drives_recovered).toBe(1);
    expect(thinRes.drives_recovered).toBe(denseRes.drives_recovered);

    const distanceOf = async (e: Env): Promise<number | null> =>
      (
        await e.DB.prepare(`SELECT distance_km FROM drives WHERE vin = ?1 AND synthetic = 1`)
          .bind(VIN)
          .first<{ distance_km: number }>()
      )?.distance_km ?? null;
    expect(await distanceOf(thin)).toBeCloseTo((await distanceOf(dense))!, 3);
  });

  it("reports the same vampire drain after thinning", async () => {
    const build = (): PosRow[] => {
      const rows: PosRow[] = [];
      for (let i = 0; i <= 120; i++) {
        rows.push({
          ts: OLD_DAY + i * 300,
          soc: Number((70 - i * 0.02).toFixed(3)),
          odometer: 1000,
          activity: "idle",
          charging_state: "Disconnected",
        });
      }
      return rows;
    };
    const dense = makeEnv();
    await ensureSchema(dense);
    await seedPositions(dense, build());
    const before = (await getVampireDrain(dense, VIN, 30)) as { total_soc_lost_pct: number };

    const thin = makeEnv();
    await ensureSchema(thin);
    await seedPositions(thin, build());
    await compressOldHistory(thin, {});
    const after = (await getVampireDrain(thin, VIN, 30)) as { total_soc_lost_pct: number };

    expect(before.total_soc_lost_pct).toBeCloseTo(2.4, 1);
    expect(after.total_soc_lost_pct).toBeCloseTo(before.total_soc_lost_pct, 1);
  });
});
