import { describe, it, expect } from "vitest";
import { scoreDrive } from "../src/scoring";

// Helper: build samples at a fixed cadence with a speed profile (km/h).
function samples(startTs: number, dtS: number, speeds: number[], headings?: number[]) {
  return speeds.map((speed, i) => ({ ts: startTs + i * dtS, speed, heading: headings?.[i] }));
}

describe("scoreDrive", () => {
  it("returns empty metrics for <2 samples", () => {
    const m = scoreDrive([{ ts: 0, speed: 50 }]);
    expect(m.behavior_score).toBeNull();
    expect(m.harsh_brake_count).toBe(0);
  });

  it("detects a hard brake at fine (2s) cadence", () => {
    // 60 km/h -> 0 over 4s in 2s steps: 60,30,0 = decel ~4.16 m/s² (> 3.0 harsh)
    const m = scoreDrive(samples(1000, 2, [60, 30, 0]), { distanceKm: 0.1 });
    expect(m.harsh_brake_count).toBeGreaterThanOrEqual(1);
    expect(m.max_decel_ms2).toBeGreaterThan(3);
    expect(m.behavior_score).toBeLessThan(100);
  });

  it("does NOT flag the same stop when sampled coarsely (60s) — cadence caveat", () => {
    // Same 60->0 but the only pair spans 60s: decel ~0.28 m/s², far below harsh.
    const m = scoreDrive(samples(1000, 60, [60, 0]), { distanceKm: 1 });
    expect(m.harsh_brake_count).toBe(0);
    expect(m.max_decel_ms2).toBeLessThan(1);
  });

  it("counts hard acceleration", () => {
    // 0 -> 60 over 4s (2s steps): accel ~4.16 m/s² (> 2.5 harsh)
    const m = scoreDrive(samples(1000, 2, [0, 30, 60]), { distanceKm: 0.1 });
    expect(m.harsh_accel_count).toBeGreaterThanOrEqual(1);
    expect(m.max_accel_ms2).toBeGreaterThan(2.5);
  });

  it("computes speeding fraction against the 120 km/h line", () => {
    const m = scoreDrive(samples(1000, 5, [100, 130, 130, 90]), { distanceKm: 5 });
    expect(m.over_limit_frac).toBeCloseTo(0.5, 2); // 2 of 4 samples > 120
  });

  it("flags cornering from heading change at speed", () => {
    // 40 km/h, heading swings 0 -> 40° over 2s = 20°/s (> 12 harsh-turn rate)
    const m = scoreDrive(samples(1000, 2, [40, 40], [0, 40]), { distanceKm: 0.1 });
    expect(m.harsh_turn_count).toBe(1);
  });

  it("computes night fraction using the tz offset", () => {
    // ts at UTC 20:00; +180 min (Israel) -> 23:00 local -> night.
    const utc20 = Math.floor(Date.UTC(2026, 6, 1, 20, 0, 0) / 1000);
    const m = scoreDrive(samples(utc20, 30, [50, 55, 50]), { distanceKm: 1, tzOffsetMin: 180 });
    expect(m.night_frac).toBe(1);
  });

  it("reports fidelity from sample density", () => {
    const dense = scoreDrive(samples(1000, 2, [50, 50, 50, 50, 50]), { distanceKm: 0.5 }); // 10/km
    const sparse = scoreDrive(samples(1000, 60, [50, 50]), { distanceKm: 5 }); // 0.4/km
    expect(dense.samples_per_km).toBeGreaterThanOrEqual(3);
    expect(sparse.samples_per_km).toBeLessThan(1);
  });
});
