/**
 * The safety net for compression: every derivation that reads thinned history
 * must return the same answer it returns on the full-resolution series.
 *
 * Each test computes a metric twice — once over a dense synthetic day, once
 * over exactly the rows compress.ts would have kept — and asserts they agree.
 * That is the property that makes it safe to delete rows at all, and it is
 * checked against the real functions and real SQLite rather than a model of
 * them.
 *
 * Several of these fail loudly against the pre-repair implementations, which is
 * the point: they encode WHY those rewrites happened, so a future edit that
 * reverts one gets caught here rather than in a false push alert.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { compressGroup, compressSeries, Point, ruleFor } from "../src/compress";
import { ensureSchema, recordEvents, resetSchemaCacheForTests } from "../src/store";
import {
  getBatteryTimeline,
  getClimateHabits,
  getPackHealth,
  getTirePressures,
  getVampireDrain,
} from "../src/tracking";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINCOMPRESSINV";
const NOW = Math.floor(Date.now() / 1000);

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

/** Store a field's series, either whole or thinned by its own rule. */
async function store(env: Env, field: string, pts: Point[], compressed: boolean): Promise<Point[]> {
  const kept = compressed ? compressSeries(pts, ruleFor(field)).keep : pts;
  await recordEvents(env, VIN, kept.map((p) => ({ field, value: p.value, ts: p.ts })));
  return kept;
}

async function insertPositions(
  env: Env,
  rows: { ts: number; soc: number; activity: string; charging_state: string | null }[],
): Promise<void> {
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO positions (vin, ts, soc, activity, charging_state) VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
      .bind(VIN, r.ts, r.soc, r.activity, r.charging_state)
      .run();
  }
}

describe("weak-brick detection survives compression", () => {
  /**
   * Brick 42 is the pack's lowest for ~99% of the time but says so in a handful
   * of long runs. Brick 17 pops in for one sample at a time.
   *
   * Compression keeps both endpoints of every run, so afterwards the two bricks
   * have almost the SAME NUMBER OF ROWS. Anything counting rows would call this
   * a 50/50 split and miss the weak cell entirely — or flag the noisy one. Only
   * dwell weighting still sees 42 dominating.
   */
  function brickSeries(): Point[] {
    const pts: Point[] = [];
    let ts = NOW - 3 * 86400;
    for (let run = 0; run < 6; run++) {
      for (let i = 0; i < 120; i++, ts += 60) pts.push({ ts, value: 42 });
      pts.push({ ts, value: 17 });
      ts += 60;
    }
    // Close on the dominant brick so the trailing sample's assumed dwell, which
    // has to be estimated, cannot land on the rare one and flatter its share.
    for (let i = 0; i < 120; i++, ts += 60) pts.push({ ts, value: 42 });
    return pts;
  }

  it("flags the same brick before and after thinning", async () => {
    const pts = brickSeries();

    const dense = makeEnv();
    await ensureSchema(dense);
    await store(dense, "brick_v_min_num", pts, false);
    const before = (await getPackHealth(dense, VIN, 30)) as { weak_brick: { number: number; share: number } | null };

    const thin = makeEnv();
    await ensureSchema(thin);
    const kept = await store(thin, "brick_v_min_num", pts, true);
    const after = (await getPackHealth(thin, VIN, 30)) as { weak_brick: { number: number; share: number } | null };

    expect(before.weak_brick?.number).toBe(42);
    expect(after.weak_brick?.number).toBe(42);
    expect(after.weak_brick!.share).toBeCloseTo(before.weak_brick!.share, 1);

    // The trap this guards. Brick 17 holds ~1% of the time but, once runs are
    // reduced to their endpoints, occupies a quarter of the surviving ROWS —
    // more than twenty times its true share. Any count-based statistic reads
    // that as a near-even split and stops seeing the weak cell.
    const rows42 = kept.filter((p) => p.value === 42).length;
    const rows17 = kept.filter((p) => p.value === 17).length;
    const rowShare17 = rows17 / (rows42 + rows17);
    const dwellShare17 = 1 - after.weak_brick!.share;
    expect(rowShare17).toBeGreaterThan(0.2);
    expect(dwellShare17).toBeLessThan(0.05);
    expect(kept.length).toBeLessThan(pts.length / 5);
  });
});

describe("same-timestamp joins survive group compression", () => {
  /**
   * getPackHealth pairs brick_v_max, brick_v_min and pack_current ON equal ts.
   * Compressed field-by-field those three diverge and the join yields nothing —
   * a silent "not enough at-rest samples" forever, rather than a wrong number.
   */
  it("still reports rest spread after the pack_brick group is thinned", async () => {
    const t0 = NOW - 2 * 86400;
    const mk = (base: number, wobble: number): Point[] => {
      const pts: Point[] = [];
      for (let i = 0; i < 600; i++) {
        pts.push({ ts: t0 + i * 60, value: Number((base + Math.sin(i / 7) * wobble).toFixed(5)) });
      }
      return pts;
    };
    const series = new Map<string, Point[]>([
      ["brick_v_max", mk(3.91, 0.001)],
      ["brick_v_min", mk(3.9, 0.001)],
      ["pack_current", mk(0.4, 0.3)],
    ]);

    const env = makeEnv();
    await ensureSchema(env);
    const out = compressGroup(series);
    for (const [field, res] of out) {
      await recordEvents(env, VIN, res.keep.map((p) => ({ field, value: p.value, ts: p.ts })));
      expect(res.keep.length).toBeLessThan(600);
    }

    const res = (await getPackHealth(env, VIN, 30)) as {
      has_data: boolean;
      daily: { rest_samples?: number }[];
    };
    expect(res.has_data).toBe(true);
    const restSamples = res.daily.reduce((s, d) => s + (d.rest_samples ?? 0), 0);
    expect(restSamples).toBeGreaterThan(0);
  });
});

describe("climate habits are dwell-weighted", () => {
  /**
   * Auto seat climate on for 23 hours, off for 1, toggled once. Row averaging
   * over a thinned series would call that 50%.
   */
  it("reports the same percentage dense and thinned", async () => {
    const t0 = NOW - 86400;
    const pts: Point[] = [];
    for (let i = 0; i < 1380; i++) pts.push({ ts: t0 + i * 60, value: 1 });
    for (let i = 1380; i < 1440; i++) pts.push({ ts: t0 + i * 60, value: 0 });

    const results: number[] = [];
    for (const compressed of [false, true]) {
      const env = makeEnv();
      await ensureSchema(env);
      await store(env, "auto_seat_climate_l", pts, compressed);
      const res = (await getClimateHabits(env, VIN, 30)) as { auto_climate_left_pct: number };
      results.push(res.auto_climate_left_pct);
    }
    expect(results[0]).toBeGreaterThan(90);
    expect(results[1]).toBeCloseTo(results[0]!, 0);
  });
});

describe("battery timeline stage hours", () => {
  it("accounts for the whole observed span, losing no inter-sample time", async () => {
    const t0 = NOW - 20000;
    const rows: { ts: number; soc: number; activity: string; charging_state: string | null }[] = [];
    for (let i = 0; i < 60; i++) rows.push({ ts: t0 + i * 60, soc: 60, activity: "idle", charging_state: "Disconnected" });
    rows.push({ ts: t0 + 3600, soc: 59, activity: "driving", charging_state: null });
    for (let i = 1; i < 30; i++) rows.push({ ts: t0 + 3600 + i * 60, soc: 58, activity: "driving", charging_state: null });
    rows.push({ ts: t0 + 5400, soc: 58, activity: "charging", charging_state: "Charging" });

    const env = makeEnv();
    await ensureSchema(env);
    await insertPositions(env, rows);
    const tl = (await getBatteryTimeline(env, VIN, 24)) as { stage_hours: Record<string, number> };

    const totalS = Object.values(tl.stage_hours).reduce((s, h) => s + h, 0) * 3600;
    const span = rows[rows.length - 1]!.ts - rows[0]!.ts;
    // Every second between the first and last sample belongs to exactly one
    // stage. The old builder closed each segment on its own last row and lost
    // the gap into the next one.
    expect(totalS).toBeCloseTo(span, 0);
  });
});

describe("vampire drain is independent of sample spacing", () => {
  /**
   * The same overnight drain, sampled every 5 minutes and every hour, must
   * report the same rate. The pairwise version could not: it only counted pairs
   * more than 30 minutes apart, so the dense series scored almost nothing and
   * the sparse one scored everything.
   */
  async function drainFor(stepS: number): Promise<{ lost: number; hours: number }> {
    const start = NOW - 12 * 3600;
    const rows: { ts: number; soc: number; activity: string; charging_state: string | null }[] = [];
    const spanS = 10 * 3600;
    for (let t = 0; t <= spanS; t += stepS) {
      rows.push({
        ts: start + t,
        soc: Number((70 - (2 * t) / spanS).toFixed(3)),
        activity: "idle",
        charging_state: "Disconnected",
      });
    }
    const env = makeEnv();
    await ensureSchema(env);
    await insertPositions(env, rows);
    const res = (await getVampireDrain(env, VIN, 30)) as { total_soc_lost_pct: number; total_idle_hours: number };
    return { lost: res.total_soc_lost_pct, hours: res.total_idle_hours };
  }

  it("gives the same drain at 5-minute and 1-hour spacing", async () => {
    const dense = await drainFor(300);
    const sparse = await drainFor(3600);
    expect(dense.lost).toBeCloseTo(2, 1);
    expect(sparse.lost).toBeCloseTo(dense.lost, 1);
    expect(sparse.hours).toBeCloseTo(dense.hours, 1);
  });
});

describe("tyre trend is duration-weighted", () => {
  /**
   * A steady leak sampled unevenly — densely for a burst each day, sparsely in
   * between — must still read as the same slope.
   */
  it("recovers the same slope from a dense and a thinned series", async () => {
    const days = 20;
    const t0 = NOW - days * 86400;
    const barPerWeek = -0.14;
    const pts: Point[] = [];
    for (let i = 0; i < days * 24 * 4; i++) {
      const ts = t0 + i * 900;
      const bar = 2.9 + (barPerWeek * (ts - t0)) / (7 * 86400);
      pts.push({ ts, value: Number(bar.toFixed(4)) });
    }

    const slopes: number[] = [];
    for (const compressed of [false, true]) {
      const env = makeEnv();
      await ensureSchema(env);
      for (const w of ["fl", "fr", "rl", "rr"]) await store(env, `tpms_${w}`, pts, compressed);
      const res = (await getTirePressures(env, VIN, days + 5)) as {
        trend_bar_per_week: { fl: number } | null;
      };
      slopes.push(res.trend_bar_per_week!.fl);
    }
    expect(slopes[0]).toBeCloseTo(barPerWeek, 2);
    expect(slopes[1]).toBeCloseTo(slopes[0]!, 2);
  });
});
