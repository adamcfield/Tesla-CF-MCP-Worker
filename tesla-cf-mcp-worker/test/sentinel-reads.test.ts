/**
 * Sentinel-rule read budget (D1 rows_read).
 *
 * evalSentinel derives its two signals — the 30-day TPMS trend and the 21-day
 * vampire-drain split — by reading EVERY raw sample in those windows, and the
 * 15-minute automation tick used to pay that price 96 times a day. At stream
 * cadence (a positions row and a 4-wheel TPMS event set per few seconds while
 * the car is awake) a single tick reads hundreds of thousands of rows, which
 * is how the account kept blowing Cloudflare D1's 5,000,000 rows_read/day
 * free-tier ceiling (taking the whole worker offline until UTC midnight)
 * on 2026-09-01..05 even after the /data-route caching in #71.
 *
 * The fix memoises both derivations for 12h through the d1meter cache — the
 * trends move over weeks and the alert cooldowns are daily, so nothing the
 * sentinel can observe changes at 15-minute freshness. These tests pin that:
 * repeat ticks cost single-digit rows, and past the soft read budget the
 * sentinel runs on the stale cached value instead of rescanning.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readBudget, resetMeterForTests, utcDay } from "../src/d1meter";
import { runCronTick } from "../src/rules";
import { ensureSchema, resetSchemaCacheForTests } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINSENT00001";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

/** Rows returned per query, tallied by SQL, across one tick. */
class ReadCounter {
  counts = new Map<string, number>();
  enabled = true;

  wrap(env: Env): void {
    const db = env.DB as unknown as FakeD1;
    const counter = this;
    const origPrepare = (db as unknown as { prepare: (sql: string) => unknown }).prepare.bind(db);
    (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
      const wrapStmt = (s: any): any => ({
        bind: (...p: unknown[]) => wrapStmt(s.bind(...p)),
        all: async <T>() => {
          const r = (await s.all()) as { results?: T[] };
          if (counter.enabled) counter.add(sql, (r.results ?? []).length);
          return r;
        },
        first: async <T>(col?: string) => {
          const r = await s.first(col);
          if (counter.enabled && r != null) counter.add(sql, 1);
          return r as T;
        },
        run: () => s.run(),
      });
      return wrapStmt(origPrepare(sql));
    };
  }

  add(sql: string, n: number): void {
    const key = sql.replace(/\s+/g, " ").slice(0, 80);
    this.counts.set(key, (this.counts.get(key) ?? 0) + n);
  }

  get total(): number {
    return [...this.counts.values()].reduce((a, b) => a + b, 0);
  }

  rowsMatching(fragment: string): number {
    return [...this.counts.entries()]
      .filter(([sql]) => sql.includes(fragment))
      .reduce((a, [, n]) => a + n, 0);
  }
}

function makeEnv(kv: FakeKV): Env {
  resetSchemaCacheForTests();
  resetMeterForTests();
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

function stubTeslaOnline(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/oauth2/v3/token")) {
      return new Response(JSON.stringify({ access_token: "A", refresh_token: "R", expires_in: 3600 }), { status: 200 });
    }
    return new Response(JSON.stringify({ response: { vin: VIN, state: "online" } }), { status: 200 });
  }));
}

/**
 * Seeds the two windows the sentinel reads: a positions sample and a 4-wheel
 * TPMS set every 60s for 30 days (a parked, streaming car), plus nightly
 * asleep spans for the drain classifier. ~30k positions + ~173k TPMS events:
 * the scale at which one unmemoised tick reads ~200k rows (and twice that
 * again inside the tyre-balance join, which a row-returned count can't see).
 */
async function seedHistory(env: Env): Promise<void> {
  await ensureSchema(env);
  const db = env.DB as unknown as FakeD1;
  for (let base = NOW - 30 * DAY; base < NOW; base += 500 * 60) {
    const pos: string[] = [];
    const ev: string[] = [];
    for (let ts = base; ts < Math.min(base + 500 * 60, NOW); ts += 60) {
      pos.push(`('${VIN}',${ts},NULL,'idle',32.1,34.8,70)`);
      for (const w of ["tpms_fl", "tpms_fr", "tpms_rl", "tpms_rr"]) ev.push(`('${VIN}',${ts},'${w}',2.9,NULL)`);
    }
    await db.prepare(`INSERT INTO positions (vin, ts, drive_id, activity, lat, lon, soc) VALUES ${pos.join(",")}`).run();
    await db.prepare(`INSERT INTO telemetry_events (vin, ts, field, value_num, value_text) VALUES ${ev.join(",")}`).run();
  }
  for (let d = 0; d < 30; d++) {
    const start = NOW - d * DAY - 6 * 3600;
    await db.prepare(
      `INSERT INTO vehicle_states (vin, state, start_ts, end_ts, source) VALUES ('${VIN}','asleep',${start},${start + 5 * 3600},'cron')`,
    ).run();
  }
}

async function tickEnv(): Promise<{ env: Env; counter: ReadCounter }> {
  const kv = new FakeKV();
  await kv.put("tesla:refresh_token", "R0");
  await kv.put("automations", JSON.stringify([{ id: "s1", type: "sentinel", vin: VIN }]));
  const env = makeEnv(kv);
  await seedHistory(env);
  const counter = new ReadCounter();
  counter.wrap(env);
  stubTeslaOnline();
  return { env, counter };
}

describe("sentinel tick read budget", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.restoreAllMocks());

  it("the first tick pays the window scans; every later tick in the 12h TTL reads ~nothing", async () => {
    const { env, counter } = await tickEnv();

    counter.counts.clear();
    await runCronTick(env);
    const firstTick = counter.total;
    // Sanity: the seeded windows really are the size that caused the outage.
    expect(counter.rowsMatching("FROM telemetry_events")).toBeGreaterThan(100_000);
    expect(counter.rowsMatching("FROM positions")).toBeGreaterThan(10_000);

    counter.counts.clear();
    await runCronTick(env);
    const secondTick = counter.total;
    expect(counter.rowsMatching("FROM telemetry_events")).toBe(0);
    expect(counter.rowsMatching("FROM positions")).toBe(0);
    // Cache hits + lock + app_state point reads only — no window scans.
    expect(secondTick).toBeLessThan(50);
    // The memoised tick is ~1000x cheaper than the cold one at this scale.
    expect(secondTick).toBeLessThan(firstTick / 1000);
  }, 120000);

  it("past the soft read budget an expired entry is served stale, not rescanned", async () => {
    const { env, counter } = await tickEnv();
    await runCronTick(env); // populates the sentinel cache entries

    // Spend the day: push the metered total past the 70% soft limit.
    await readBudget(env); // ensures the d1_usage table exists
    await env.DB.prepare(
      `INSERT INTO d1_usage (day, rows_read, updated_ts) VALUES (?1, ?2, ?3)
       ON CONFLICT(day) DO UPDATE SET rows_read = excluded.rows_read`,
    ).bind(utcDay(), 4_000_000, NOW).run();
    // Expire the cache entries so only the over-budget stale path can serve.
    await env.DB.prepare(`UPDATE read_cache SET created_ts = ?1 WHERE key LIKE 'sentinel:%'`)
      .bind(NOW - 13 * 3600).run();
    resetMeterForTests(); // fresh isolate: re-reads the persisted usage row

    counter.counts.clear();
    const summary = await runCronTick(env);
    expect(counter.rowsMatching("FROM telemetry_events")).toBe(0);
    expect(counter.rowsMatching("FROM positions")).toBe(0);
    expect(counter.total).toBeLessThan(50);
    expect(summary).toHaveProperty("evaluated", 1);
  }, 120000);
});
