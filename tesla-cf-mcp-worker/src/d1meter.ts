/**
 * D1 read metering, a daily read-budget guard, and a response cache for
 * expensive reads.
 *
 * WHY THIS EXISTS. Cloudflare's D1 free tier stops serving the ENTIRE database
 * for the rest of the UTC day once 5,000,000 rows have been read — not the
 * offending query, everything: the dashboard, the poller, the telemetry sink
 * and the automation tick all fail together. That happened on two consecutive
 * days (2026-09-01, 2026-09-02). The second time, /health reported `d1: "ok"`
 * at 11:38 UTC and the account was cut off before 13:20 — roughly five million
 * rows in under two hours.
 *
 * Both outages were diagnosed by READING CODE, because the worker kept no
 * record of what it actually read. That is the real defect this module fixes.
 * It provides the three things that were missing:
 *
 *   1. ACCOUNTING — every statement's `meta.rows_read` is summed into a
 *      per-UTC-day row, so "what is eating the budget" is answerable from
 *      /health?diag=1 instead of inferred.
 *   2. A GUARD — past a soft threshold the expensive analytical endpoints stop
 *      recomputing and serve their last cached answer. A runaway caller then
 *      costs a few hours of stale analytics instead of a total outage.
 *   3. A CACHE — the dashboard re-polls the same aggregates every 45s while the
 *      car is active. Caching the computed JSON turns eighty identical 30-day
 *      scans an hour into one.
 *
 * COVERAGE, honestly stated: D1 exposes `meta` on all() and run(), but NOT on
 * first(). Single-row first() lookups are therefore invisible to the meter.
 * They are indexed point reads (one row each) and are not what exhausts a
 * five-million-row budget, but the counter is a floor, not an exact total.
 */

import { Env } from "./types";

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

/** Rows counted in this isolate since the last flush to D1. */
let pending = 0;
/** Unix seconds of the last flush. */
let lastFlushTs = 0;
/** Last known persisted total for `cachedDay`, and when we read it. */
let cachedTotal = 0;
let cachedTotalDay = "";
let cachedTotalAt = 0;

/** Flush the in-isolate counter at most this often... */
const FLUSH_EVERY_S = 60;
/** ...or immediately once this many rows have accumulated unflushed. */
const FLUSH_EVERY_ROWS = 25_000;
/** Re-read the persisted daily total at most this often (it costs a row). */
const TOTAL_TTL_S = 30;

/** D1's own free-tier ceiling. Crossing it takes the whole database offline. */
export const D1_FREE_DAILY_ROWS_READ = 5_000_000;
/**
 * Default soft threshold: stop recomputing expensive analytics at 70% of the
 * ceiling, leaving the remaining 30% for the things that must keep working —
 * telemetry ingest, the poller, and the automation tick.
 */
const DEFAULT_SOFT_LIMIT = 3_500_000;

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function record(meta: unknown): void {
  const n = (meta as { rows_read?: number } | null | undefined)?.rows_read;
  if (typeof n === "number" && n > 0) pending += n;
}

/**
 * Wraps a D1Database so every all()/run()/batch() adds its `rows_read` to the
 * in-isolate counter. A Proxy rather than a hand-written adapter so the full
 * D1 surface (raw(), overloads on first(), anything added later) passes through
 * untouched — a metering layer must never change query semantics.
 */
export function meterD1(db: D1Database): D1Database {
  const meterStatement = (stmt: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(stmt, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        const fn = (value as (...a: unknown[]) => unknown).bind(target);
        // bind() returns a new statement — keep it metered.
        if (prop === "bind") {
          return (...args: unknown[]) => meterStatement(fn(...args) as D1PreparedStatement);
        }
        if (prop === "all" || prop === "run") {
          return async (...args: unknown[]) => {
            const res = await fn(...args);
            record((res as { meta?: unknown } | null)?.meta);
            return res;
          };
        }
        return fn;
      },
    });

  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      const fn = (value as (...a: unknown[]) => unknown).bind(target);
      if (prop === "prepare") {
        return (...args: unknown[]) => meterStatement(fn(...args) as D1PreparedStatement);
      }
      if (prop === "batch") {
        return async (...args: unknown[]) => {
          const res = (await fn(...args)) as { meta?: unknown }[];
          for (const r of res ?? []) record(r?.meta);
          return res;
        };
      }
      return fn;
    },
  });
}

async function ensureUsageTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS d1_usage (
       day TEXT PRIMARY KEY, rows_read INTEGER NOT NULL, updated_ts INTEGER
     )`,
  ).run();
}

/**
 * Persists the in-isolate counter. Uses an atomic SQL increment rather than a
 * read-modify-write so concurrent isolates accumulate instead of clobbering
 * each other. Cheap by design: a handful of writes per minute at most, against
 * a 100k rows_written/day cap.
 *
 * Never throws — accounting must not be able to break a request. In particular
 * it stays silent when D1 is already refusing writes.
 */
export async function flushMeter(env: Env, force = false): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (pending <= 0) return;
  if (!force && now - lastFlushTs < FLUSH_EVERY_S && pending < FLUSH_EVERY_ROWS) return;
  const n = pending;
  pending = 0;
  lastFlushTs = now;
  try {
    await ensureUsageTable(env);
    await env.DB.prepare(
      `INSERT INTO d1_usage (day, rows_read, updated_ts) VALUES (?1, ?2, ?3)
       ON CONFLICT(day) DO UPDATE SET rows_read = rows_read + excluded.rows_read, updated_ts = excluded.updated_ts`,
    )
      .bind(utcDay(), n, now)
      .run();
    cachedTotalAt = 0; // force a re-read next time the guard asks
  } catch {
    /* put the rows back so they are not simply lost */
    pending += n;
  }
}

export interface ReadBudget {
  day: string;
  rows_read: number;
  soft_limit: number;
  hard_limit: number;
  /** True once expensive analytics should stop recomputing. */
  over_soft: boolean;
  /** Rows counted in this isolate but not yet flushed. */
  pending: number;
}

function softLimit(env: Env): number {
  const raw = Number(env.D1_READ_SOFT_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SOFT_LIMIT;
}

/**
 * Today's read budget. Cached in-isolate for TOTAL_TTL_S so the guard itself
 * cannot become a meaningful cost, and fails OPEN: if the usage row can't be
 * read we report not-over-budget rather than refusing to serve. A metering
 * bug must never be the reason the dashboard goes dark.
 */
export async function readBudget(env: Env): Promise<ReadBudget> {
  const day = utcDay();
  const now = Math.floor(Date.now() / 1000);
  if (day !== cachedTotalDay) {
    cachedTotalDay = day;
    cachedTotal = 0;
    cachedTotalAt = 0;
  }
  if (now - cachedTotalAt >= TOTAL_TTL_S) {
    try {
      await ensureUsageTable(env);
      const row = await env.DB.prepare(`SELECT rows_read FROM d1_usage WHERE day = ?1`)
        .bind(day)
        .first<{ rows_read: number }>();
      cachedTotal = row?.rows_read ?? 0;
      cachedTotalAt = now;
    } catch {
      /* fail open — leave the last known value in place */
    }
  }
  const total = cachedTotal + pending;
  const soft = softLimit(env);
  return {
    day,
    rows_read: total,
    soft_limit: soft,
    hard_limit: D1_FREE_DAILY_ROWS_READ,
    over_soft: total >= soft,
    pending,
  };
}

// ---------------------------------------------------------------------------
// Response cache
// ---------------------------------------------------------------------------

/**
 * Cached JSON larger than this is not stored. The analytical endpoints all
 * downsample to at most a few hundred points, so this only ever trips on
 * something unexpectedly large — which is exactly what shouldn't be copied
 * into another table.
 */
const MAX_CACHE_BYTES = 512 * 1024;

async function ensureCacheTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS read_cache (
       key TEXT PRIMARY KEY, value TEXT NOT NULL, created_ts INTEGER NOT NULL
     )`,
  ).run();
}

export interface CachedReadResult<T> {
  value: T;
  /** "fresh" = computed now, "cache" = within TTL, "stale" = served past TTL because the read budget is spent. */
  source: "fresh" | "cache" | "stale";
}

/**
 * Computes `compute()` at most once per `ttlS` per `key`, memoised in D1.
 *
 * The point is not latency, it is rows_read: the dashboard asks for the same
 * 30-day aggregate every 45 seconds while the car is active, and each miss can
 * cost tens of thousands of rows. A hit costs one.
 *
 * Past the soft read budget a stale entry is served rather than recomputed —
 * degrading to yesterday's analytics is strictly better than taking the
 * database offline for everyone. With no cached entry at all the computation
 * still runs (returning an error would be worse than one expensive read).
 *
 * Cache failures are swallowed: on any trouble the value is computed and
 * returned as normal, so this layer can only ever make things cheaper.
 */
export async function cachedRead<T>(
  env: Env,
  key: string,
  ttlS: number,
  compute: () => Promise<T>,
): Promise<CachedReadResult<T>> {
  const now = Math.floor(Date.now() / 1000);
  let hit: { value: string; created_ts: number } | null = null;
  try {
    await ensureCacheTable(env);
    hit = await env.DB.prepare(`SELECT value, created_ts FROM read_cache WHERE key = ?1`)
      .bind(key)
      .first<{ value: string; created_ts: number }>();
  } catch {
    /* cache unavailable — fall through and compute */
  }

  if (hit && now - hit.created_ts < ttlS) {
    try {
      return { value: JSON.parse(hit.value) as T, source: "cache" };
    } catch {
      /* corrupt entry — recompute below */
    }
  }

  // Budget spent: prefer a stale answer over another expensive scan.
  if (hit) {
    const budget = await readBudget(env).catch(() => null);
    if (budget?.over_soft) {
      try {
        return { value: JSON.parse(hit.value) as T, source: "stale" };
      } catch {
        /* corrupt entry — recompute below */
      }
    }
  }

  const value = await compute();
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined && serialized.length <= MAX_CACHE_BYTES) {
      await env.DB.prepare(
        `INSERT INTO read_cache (key, value, created_ts) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_ts = excluded.created_ts`,
      )
        .bind(key, serialized, now)
        .run();
    }
  } catch {
    /* caching is best-effort */
  }
  return { value, source: "fresh" };
}

/** Drops cache entries older than `maxAgeS` (called from the daily maintenance sweep). */
export async function pruneReadCache(env: Env, maxAgeS = 86400): Promise<number> {
  try {
    await ensureCacheTable(env);
    const res = await env.DB.prepare(`DELETE FROM read_cache WHERE created_ts < ?1`)
      .bind(Math.floor(Date.now() / 1000) - maxAgeS)
      .run();
    return res.meta.changes ?? 0;
  } catch {
    return 0;
  }
}

/** Test-only: clears the in-isolate meter state. */
export function resetMeterForTests(): void {
  pending = 0;
  lastFlushTs = 0;
  cachedTotal = 0;
  cachedTotalDay = "";
  cachedTotalAt = 0;
}
