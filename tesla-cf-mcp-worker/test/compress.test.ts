/**
 * The compression algorithms, in isolation from D1.
 *
 * The load-bearing assertion is the epsilon bound: for every point the door
 * throws away, reconstructing from what survived must land within that field's
 * stated tolerance. Everything else in the pipeline is built on that promise.
 */
import { describe, it, expect } from "vitest";
import {
  compressGroup,
  compressSeries,
  DEFAULT_MAX_GAP_S,
  FIELD_GROUPS,
  groupOf,
  Point,
  reconstructSeries,
  registeredFields,
  ruleFor,
  valueAt,
} from "../src/compress";
import type { FieldRule } from "../src/compress";

const analogRule = (epsilon: number, maxGapS = 1e9): FieldRule => ({
  rule: { kind: "analog", epsilon },
  maxGapS,
});
const stepRule = (maxGapS = 1e9): FieldRule => ({ rule: { kind: "step" }, maxGapS });

/** Deterministic PRNG — a flaky property test is worse than no property test. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("swinging door", () => {
  it("collapses the user's overnight SoC pattern to its endpoints", () => {
    // The scenario that motivated the whole feature: home at 50%, charge to 80%
    // over three hours, then oscillate 80/79/80 until morning.
    const pts: Point[] = [];
    for (let i = 0; i <= 180; i++) pts.push({ ts: i * 60, value: 50 + (30 * i) / 180 });
    for (let i = 1; i <= 480; i++) pts.push({ ts: 10800 + i * 60, value: i % 2 === 0 ? 80 : 79 });

    const { keep } = compressSeries(pts, analogRule(1));

    // 661 samples in, a handful out.
    expect(pts.length).toBe(661);
    expect(keep.length).toBeLessThanOrEqual(5);
    expect(keep[0]).toEqual({ ts: 0, value: 50 });
    expect(keep[keep.length - 1]!.ts).toBe(pts[pts.length - 1]!.ts);
    // The ramp is a straight line, so nothing inside it needs archiving.
    expect(keep.filter((p) => p.ts > 0 && p.ts < 10800).length).toBe(0);
  });

  it("keeps a linear ramp as exactly its two endpoints", () => {
    const pts: Point[] = [];
    for (let i = 0; i <= 100; i++) pts.push({ ts: i * 60, value: i * 0.25 });
    const { keep } = compressSeries(pts, analogRule(0.5));
    expect(keep.length).toBe(2);
  });

  it("archives a point when the signal turns", () => {
    // Up for an hour, then down for an hour: one line cannot cover both.
    const pts: Point[] = [];
    for (let i = 0; i <= 60; i++) pts.push({ ts: i * 60, value: i });
    for (let i = 1; i <= 60; i++) pts.push({ ts: 3600 + i * 60, value: 60 - i });
    const { keep } = compressSeries(pts, analogRule(0.5));
    expect(keep.length).toBeGreaterThanOrEqual(3);
    // The turning point itself has to survive, or the peak is lost.
    expect(keep.some((p) => p.value === 60)).toBe(true);
  });

  it("respects epsilon for every dropped point, over random walks", () => {
    for (const epsilon of [0.05, 0.5, 2]) {
      const rand = rng(0xc0ffee + Math.round(epsilon * 100));
      const pts: Point[] = [];
      let v = 50;
      for (let i = 0; i < 2000; i++) {
        v += (rand() - 0.5) * 2;
        pts.push({ ts: i * 30, value: Number(v.toFixed(4)) });
      }
      const rule = analogRule(epsilon);
      const { keep, dropTs } = compressSeries(pts, rule);
      expect(keep.length).toBeLessThan(pts.length);

      const byTs = new Map(pts.map((p) => [p.ts, p.value as number]));
      for (const ts of dropTs) {
        const got = valueAt(keep, ts, rule) as number;
        expect(Math.abs(got - byTs.get(ts)!)).toBeLessThanOrEqual(epsilon + 1e-9);
      }
    }
  });

  it("treats a null inside an analog series as a hard transition", () => {
    const pts: Point[] = [
      { ts: 0, value: 10 },
      { ts: 60, value: 10 },
      { ts: 120, value: null },
      { ts: 180, value: 10 },
      { ts: 240, value: 10 },
    ];
    const { keep } = compressSeries(pts, analogRule(1));
    expect(keep.some((p) => p.value === null)).toBe(true);
  });
});

describe("run endpoints", () => {
  it("keeps the close of one run and the open of the next", () => {
    // Locked all evening, unlocked in the morning. Both the last locked sample
    // and the first unlocked one must survive, or the moment it changed is lost.
    const pts: Point[] = [];
    for (let i = 0; i < 100; i++) pts.push({ ts: i * 300, value: 1 });
    for (let i = 100; i < 140; i++) pts.push({ ts: i * 300, value: 0 });

    const { keep } = compressSeries(pts, stepRule());
    expect(keep.length).toBe(4);
    expect(keep.map((p) => p.ts)).toEqual([0, 99 * 300, 100 * 300, 139 * 300]);
  });

  it("preserves an empty-string transition (media playback stopped)", () => {
    // mediaLeaderboard uses '' rows as span terminators; losing one merges two
    // listening sessions across the silence between them.
    const pts: Point[] = [
      { ts: 0, value: "Song A" },
      { ts: 60, value: "Song A" },
      { ts: 120, value: "" },
      { ts: 180, value: "" },
      { ts: 240, value: "Song B" },
    ];
    const { keep } = compressSeries(pts, stepRule());
    expect(keep.filter((p) => p.value === "").map((p) => p.ts)).toEqual([120, 180]);
  });
});

describe("gap anchors", () => {
  it("bounds the gap between kept points even when nothing changes", () => {
    // 24h of a constant value at one sample a minute.
    const pts: Point[] = [];
    for (let i = 0; i < 1440; i++) pts.push({ ts: i * 60, value: 1 });

    const { keep } = compressSeries(pts, { rule: { kind: "step" }, maxGapS: DEFAULT_MAX_GAP_S });
    for (let i = 1; i < keep.length; i++) {
      expect(keep[i]!.ts - keep[i - 1]!.ts).toBeLessThanOrEqual(DEFAULT_MAX_GAP_S + 60);
    }
    // ~24 anchors, not 1440 rows.
    expect(keep.length).toBeLessThanOrEqual(26);
    expect(keep.length).toBeGreaterThanOrEqual(24);
  });

  it("does not invent samples across a real data gap", () => {
    // Nothing arrived for six hours. That silence must stay visible.
    const pts: Point[] = [
      { ts: 0, value: 1 },
      { ts: 60, value: 1 },
      { ts: 21600, value: 1 },
      { ts: 21660, value: 1 },
    ];
    const { keep } = compressSeries(pts, { rule: { kind: "step" }, maxGapS: DEFAULT_MAX_GAP_S });
    expect(keep.every((p) => pts.some((o) => o.ts === p.ts))).toBe(true);
    expect(keep.some((p) => p.ts > 60 && p.ts < 21600)).toBe(false);
  });
});

describe("field groups", () => {
  it("gives every member of a group identical retained timestamps", () => {
    // Compressed independently these would diverge, and the pack-health join
    // (ON mn.ts = mx.ts) would return nothing at all.
    const rand = rng(7);
    const series = new Map<string, Point[]>();
    for (const field of FIELD_GROUPS.pack_brick!) {
      const pts: Point[] = [];
      let v = field === "pack_current" ? 0.2 : 4.1;
      for (let i = 0; i < 600; i++) {
        v += (rand() - 0.5) * (field === "pack_current" ? 0.4 : 0.004);
        pts.push({ ts: i * 60, value: Number(v.toFixed(5)) });
      }
      series.set(field, pts);
    }

    const out = compressGroup(series);
    const stamps = [...out.values()].map((r) => r.keep.map((p) => p.ts));
    for (const s of stamps) expect(s).toEqual(stamps[0]);
    expect(stamps[0]!.length).toBeLessThan(600);
  });

  it("registers the group on each member's rule", () => {
    for (const [group, members] of Object.entries(FIELD_GROUPS)) {
      for (const field of members) expect(groupOf(field)).toBe(group);
    }
  });
});

describe("registry", () => {
  it("never compresses a field nobody has classified", () => {
    // ingest.ts falls back to field.toLowerCase() for anything not in FIELD_MAP,
    // so unknown names reach storage. They must not inherit a stranger's rule.
    expect(ruleFor("some_new_tesla_field_2027").rule.kind).toBe("never");
    const pts: Point[] = [
      { ts: 0, value: 1 },
      { ts: 60, value: 1 },
      { ts: 120, value: 1 },
    ];
    expect(compressSeries(pts, ruleFor("unmapped")).dropTs).toEqual([]);
  });

  it("classifies the fields the streaming plan actually sends", () => {
    const streamed = [
      "locked", "sentry", "gear", "odometer", "tpms_fl", "brick_v_max",
      "pack_current", "isolation_resistance", "inside_temp", "seat_heater_l",
      "media_title", "software_version", "charge_limit", "door_state",
    ];
    for (const f of streamed) expect(ruleFor(f).rule.kind).not.toBe("never");
    expect(registeredFields().length).toBeGreaterThan(180);
  });

  it("leaves heading alone because it wraps", () => {
    // 359 -> 0 is one degree, but every linear cone reads it as 359.
    expect(ruleFor("heading").rule.kind).toBe("never");
  });
});

describe("reconstruction", () => {
  it("squares off step transitions so a polyline renderer shows an edge", () => {
    const pts: Point[] = [
      { ts: 0, value: 1 },
      { ts: 3600, value: 1 },
      { ts: 3660, value: 0 },
    ];
    const out = reconstructSeries(pts, stepRule());
    expect(out).toEqual([
      { ts: 0, value: 1 },
      { ts: 3600, value: 1 },
      { ts: 3659, value: 1 },
      { ts: 3660, value: 0 },
    ]);
  });

  it("leaves analog series alone — the chart already interpolates them", () => {
    const pts: Point[] = [
      { ts: 0, value: 50 },
      { ts: 3600, value: 80 },
    ];
    expect(reconstructSeries(pts, analogRule(1))).toEqual(pts);
  });

  it("interpolates analog values and holds step values", () => {
    const pts: Point[] = [
      { ts: 0, value: 50 },
      { ts: 100, value: 60 },
    ];
    expect(valueAt(pts, 50, analogRule(1))).toBeCloseTo(55, 9);
    expect(valueAt(pts, 50, stepRule())).toBe(50);
    expect(valueAt(pts, -10, stepRule())).toBe(50);
    expect(valueAt(pts, 999, stepRule())).toBe(60);
    expect(valueAt([], 0, stepRule())).toBeNull();
  });
});
