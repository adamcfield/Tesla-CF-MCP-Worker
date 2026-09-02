/**
 * D1 read metering, the daily read-budget guard, and the response cache.
 *
 * These exist because the worker went fully offline twice (2026-09-01 and
 * 2026-09-02) on Cloudflare D1's free-tier ceiling of 5M rows read per UTC
 * day, and both times the cause had to be inferred from reading the source:
 * nothing recorded what was actually being read. The tests below pin the three
 * properties that make a third outage a degradation instead:
 *   - every all()/run()/batch() is counted,
 *   - an expensive read repeated in a loop costs one scan, not N,
 *   - past the soft budget a stale answer is served rather than a fresh scan.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  cachedRead,
  D1_FREE_DAILY_ROWS_READ,
  flushMeter,
  meterD1,
  pruneReadCache,
  readBudget,
  resetMeterForTests,
  utcDay,
} from "../src/d1meter";
import { ensureSchema, resetSchemaCacheForTests } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINMETER00001";

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
    ...extra,
  } as Env;
}

/**
 * The in-memory helper is real SQLite but reports no rows_read, so the meter
 * has nothing to count. This wrapper reports a row count the way D1 does,
 * which is what the metering contract is actually about.
 */
function withRowsRead(db: D1Database, rowsPerCall: number): D1Database {
  const wrapStmt = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        const fn = (v as (...a: unknown[]) => unknown).bind(target);
        if (prop === "bind") return (...a: unknown[]) => wrapStmt(fn(...a) as D1PreparedStatement);
        if (prop === "all" || prop === "run") {
          return async (...a: unknown[]) => {
            const res = (await fn(...a)) as { meta?: Record<string, unknown> };
            return { ...res, meta: { ...(res.meta ?? {}), rows_read: rowsPerCall } };
          };
        }
        return fn;
      },
    });
  return new Proxy(db, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      const fn = (v as (...a: unknown[]) => unknown).bind(target);
      if (prop === "prepare") return (...a: unknown[]) => wrapStmt(fn(...a) as D1PreparedStatement);
      if (prop === "batch") {
        return async (...a: unknown[]) => {
          const res = (await fn(...a)) as { meta?: Record<string, unknown> }[];
          return res.map((r) => ({ ...r, meta: { ...(r.meta ?? {}), rows_read: rowsPerCall } }));
        };
      }
      return fn;
    },
  });
}

describe("meterD1", () => {
  it("counts rows_read from all(), run() and batch() without changing results", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    env.DB = meterD1(withRowsRead(env.DB, 1000));

    // Results must pass through untouched — a metering layer that changes
    // query semantics is worse than no metering at all.
    await env.DB.prepare(`INSERT INTO positions (vin, ts, soc) VALUES (?1, ?2, 55)`)
      .bind(VIN, 1000)
      .run();
    const rows = await env.DB.prepare(`SELECT ts, soc FROM positions WHERE vin = ?1`)
      .bind(VIN)
      .all<{ ts: number; soc: number }>();
    expect(rows.results).toEqual([{ ts: 1000, soc: 55 }]);

    await env.DB.batch([
      env.DB.prepare(`SELECT 1`),
      env.DB.prepare(`SELECT 1`),
    ]);

    // 1 run + 1 all + 2 batched = 4 statements x 1000 rows. Asserted as a
    // floor, not an equality: readBudget provisions its own usage table, and
    // that statement is metered like any other — the meter measures itself.
    const budget = await readBudget(env);
    expect(budget.pending).toBeGreaterThanOrEqual(4000);
    expect(budget.rows_read).toBeGreaterThanOrEqual(4000);
    expect(budget.hard_limit).toBe(D1_FREE_DAILY_ROWS_READ);
  });

  it("first() passes through untouched (D1 exposes no meta there)", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    env.DB = meterD1(withRowsRead(env.DB, 1000));
    await env.DB.prepare(`INSERT INTO positions (vin, ts, soc) VALUES (?1, ?2, 41)`)
      .bind(VIN, 2000)
      .run();
    const row = await env.DB.prepare(`SELECT soc FROM positions WHERE vin = ?1`)
      .bind(VIN)
      .first<{ soc: number }>();
    expect(row).toEqual({ soc: 41 });
  });

  it("flushes to a per-UTC-day row and accumulates across flushes", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    env.DB = meterD1(withRowsRead(env.DB, 2500));

    await env.DB.prepare(`SELECT 1`).all();
    await flushMeter(env, true);
    await env.DB.prepare(`SELECT 1`).all();
    await flushMeter(env, true);

    const row = await env.DB.prepare(`SELECT day, rows_read FROM d1_usage`).first<{ day: string; rows_read: number }>();
    expect(row?.day).toBe(utcDay());
    // The flush statements meter themselves too, so assert accumulation rather
    // than an exact figure that would encode the implementation's own cost.
    expect(row!.rows_read).toBeGreaterThanOrEqual(5000);
  });
});

describe("cachedRead", () => {
  it("computes once within the TTL — the fix for an aggregate polled every 45s", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    let computes = 0;
    const compute = async () => {
      computes++;
      return { expensive: true, n: computes };
    };

    const first = await cachedRead(env, "/data/tires?vin=X", 900, compute);
    expect(first.source).toBe("fresh");
    expect(computes).toBe(1);

    // 80 further polls (one 45s tick per hour's worth) must not recompute.
    for (let i = 0; i < 80; i++) {
      const hit = await cachedRead(env, "/data/tires?vin=X", 900, compute);
      expect(hit.source).toBe("cache");
      expect(hit.value).toEqual({ expensive: true, n: 1 });
    }
    expect(computes).toBe(1);
  });

  it("recomputes once the TTL expires", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    let computes = 0;
    const compute = async () => ({ n: ++computes });

    await cachedRead(env, "k", 900, compute);
    // Backdate the entry past its TTL.
    await env.DB.prepare(`UPDATE read_cache SET created_ts = created_ts - 1000 WHERE key = 'k'`).run();
    const again = await cachedRead(env, "k", 900, compute);
    expect(again.source).toBe("fresh");
    expect(computes).toBe(2);
  });

  it("serves a STALE entry instead of rescanning once the soft budget is spent", async () => {
    // This is the property that turns a runaway caller into degraded analytics
    // rather than a dead database.
    const env = makeEnv({ D1_READ_SOFT_LIMIT: "1000" } as Partial<Env>);
    await ensureSchema(env);
    let computes = 0;
    const compute = async () => ({ n: ++computes });

    await cachedRead(env, "k", 60, compute);
    expect(computes).toBe(1);
    await env.DB.prepare(`UPDATE read_cache SET created_ts = created_ts - 1000 WHERE key = 'k'`).run();

    // Push recorded usage past the soft limit (readBudget provisions d1_usage).
    await readBudget(env);
    await env.DB.prepare(
      `INSERT INTO d1_usage (day, rows_read, updated_ts) VALUES (?1, 999999, 0)
       ON CONFLICT(day) DO UPDATE SET rows_read = 999999`,
    ).bind(utcDay()).run();
    resetMeterForTests();

    const stale = await cachedRead(env, "k", 60, compute);
    expect(stale.source).toBe("stale");
    expect(stale.value).toEqual({ n: 1 });
    expect(computes).toBe(1); // no rescan
  });

  it("still computes when over budget with nothing cached (never returns an error)", async () => {
    const env = makeEnv({ D1_READ_SOFT_LIMIT: "1" } as Partial<Env>);
    await ensureSchema(env);
    const res = await cachedRead(env, "cold", 60, async () => ({ ok: true }));
    expect(res.source).toBe("fresh");
    expect(res.value).toEqual({ ok: true });
  });

  it("falls back to computing when the cache layer itself fails", async () => {
    const env = makeEnv();
    env.DB = {
      prepare: () => { throw new Error("D1_ERROR: rows read limit exceeded"); },
      batch: () => Promise.reject(new Error("D1_ERROR")),
    } as unknown as D1Database;
    const res = await cachedRead(env, "k", 60, async () => ({ computed: true }));
    expect(res.value).toEqual({ computed: true });
  });

  it("prunes entries older than the retention window", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    await cachedRead(env, "old", 60, async () => ({ a: 1 }));
    await cachedRead(env, "new", 60, async () => ({ a: 2 }));
    await env.DB.prepare(`UPDATE read_cache SET created_ts = created_ts - 200000 WHERE key = 'old'`).run();

    expect(await pruneReadCache(env, 86400)).toBe(1);
    const left = await env.DB.prepare(`SELECT key FROM read_cache`).all<{ key: string }>();
    expect(left.results?.map((r) => r.key)).toEqual(["new"]);
  });
});

describe("readBudget", () => {
  it("fails OPEN when usage can't be read — metering must never darken the app", async () => {
    const env = makeEnv();
    env.DB = {
      prepare: () => { throw new Error("D1_ERROR"); },
      batch: () => Promise.reject(new Error("D1_ERROR")),
    } as unknown as D1Database;
    const budget = await readBudget(env);
    expect(budget.over_soft).toBe(false);
    expect(budget.rows_read).toBe(0);
  });

  it("flips over_soft at the configured threshold", async () => {
    const env = makeEnv({ D1_READ_SOFT_LIMIT: "5000" } as Partial<Env>);
    await ensureSchema(env);
    expect((await readBudget(env)).over_soft).toBe(false); // also provisions d1_usage

    await env.DB.prepare(
      `INSERT INTO d1_usage (day, rows_read, updated_ts) VALUES (?1, 5000, 0)
       ON CONFLICT(day) DO UPDATE SET rows_read = 5000`,
    ).bind(utcDay()).run();
    resetMeterForTests();

    const over = await readBudget(env);
    expect(over.rows_read).toBe(5000);
    expect(over.soft_limit).toBe(5000);
    expect(over.over_soft).toBe(true);
  });
});
