/**
 * Three-frontiers unit tests: solar night, signed certificates, posted-limit +
 * IMU-aware scoring with confidence bands, and the range-percentile math.
 */
import { describe, it, expect } from "vitest";
import { signDriveCertificate, verifyDriveCertificate } from "../src/certificate";
import { scoreDrive } from "../src/scoring";
import { scoreToPercentile } from "../src/tracking";
import { isNight, solarElevationDeg } from "../src/solar";
import type { Env } from "../src/types";

const TLV = { lat: 32.08, lon: 34.78 };
// 2026-01-15: 12:00 UTC (14:00 local, daylight) vs 22:00 UTC (midnight, dark).
const JAN15_NOON_UTC = Date.UTC(2026, 0, 15, 10, 0) / 1000; // 12:00 Israel (UTC+2)
const JAN15_MIDNIGHT_UTC = Date.UTC(2026, 0, 15, 22, 0) / 1000; // 00:00 Israel

describe("solar night", () => {
  it("sun is up at local noon, down at local midnight in Tel Aviv", () => {
    expect(solarElevationDeg(TLV.lat, TLV.lon, JAN15_NOON_UTC)).toBeGreaterThan(10);
    expect(isNight(TLV.lat, TLV.lon, JAN15_NOON_UTC)).toBe(false);
    expect(solarElevationDeg(TLV.lat, TLV.lon, JAN15_MIDNIGHT_UTC)).toBeLessThan(0);
    expect(isNight(TLV.lat, TLV.lon, JAN15_MIDNIGHT_UTC)).toBe(true);
  });
});

describe("drive risk certificate", () => {
  const env = { MCP_AUTH_TOKEN: "secret-key", PUBLIC_ORIGIN: "https://t.example.com" } as Env;
  const drive = { id: 7, vin: "TESTVIN0000000001", distance_km: 12.3, behavior_score: 88, harsh_brake_count: 1 };
  const path = [{ ts: 1000, lat: 32.0, lon: 34.7, speed: 40 }, { ts: 1010, lat: 32.01, lon: 34.71, speed: 45 }];

  it("signs and verifies a certificate round-trip", async () => {
    const cert = await signDriveCertificate(env, drive, path, 1783000000);
    expect(cert.algorithm).toBe("HMAC-SHA256");
    expect(cert.signature_hex).toMatch(/^[0-9a-f]{64}$/);
    const v = await verifyDriveCertificate(env, cert);
    expect(v.valid).toBe(true);
  });

  it("detects tampering — altering a metric breaks the signature", async () => {
    const cert = await signDriveCertificate(env, drive, path, 1783000000);
    (cert.canonical as Record<string, unknown>).behavior_score = 100; // forge a better score
    expect((await verifyDriveCertificate(env, cert)).valid).toBe(false);
  });

  it("a certificate signed under a different secret does not verify", async () => {
    const cert = await signDriveCertificate(env, drive, path, 1783000000);
    const other = { MCP_AUTH_TOKEN: "different", PUBLIC_ORIGIN: "https://t.example.com" } as Env;
    expect((await verifyDriveCertificate(other, cert)).valid).toBe(false);
  });

  it("rejects a null/array canonical with a reason (typeof null === object guard)", async () => {
    const nullRes = await verifyDriveCertificate(env, { canonical: null, signature_hex: "a".repeat(64) });
    expect(nullRes.valid).toBe(false);
    expect(nullRes.reason).toBe("missing canonical or signature_hex");
    const arrRes = await verifyDriveCertificate(env, { canonical: [] as unknown, signature_hex: "a".repeat(64) });
    expect(arrRes.valid).toBe(false);
  });
});

describe("scoring: posted limits, IMU, confidence", () => {
  it("scores speeding against per-sample posted limits, not a flat line", () => {
    // 90 km/h in a 50 zone is speeding; the flat-120 fallback would miss it.
    const samples = Array.from({ length: 6 }, (_, i) => ({ ts: i * 10, speed: 90, lat: 32, lon: 34.8 }));
    const limits = samples.map(() => 50);
    const m = scoreDrive(samples, { distanceKm: 5, postedLimits: limits, speedLimitSource: "osm" });
    expect(m.over_limit_frac).toBe(1); // every sample over the 50 limit (+ tolerance)
    expect(m.over_limit_severity).toBeGreaterThan(30); // ~35 km/h over
    expect(m.speed_limit_source).toBe("osm");
  });

  it("prefers real IMU acceleration and reports high confidence", () => {
    // A hard brake seen directly by the IMU (−5 m/s²) at 10s cadence.
    const samples = [
      { ts: 0, speed: 60, lon_accel: 0.2 },
      { ts: 10, speed: 55, lon_accel: -5.0 },
      { ts: 20, speed: 50, lon_accel: 0.1 },
    ];
    const m = scoreDrive(samples, { distanceKm: 2 });
    expect(m.accel_source).toBe("imu");
    expect(m.max_decel_ms2).toBeGreaterThanOrEqual(5); // real g, not the tiny Δv/Δt proxy
    expect(m.harsh_brake_count).toBe(1);
    expect(m.score_confidence).toBe("high"); // IMU ⇒ high confidence
    expect(m.score_low).toBe(m.score_high); // no cadence uncertainty with real g
  });

  it("derived (no IMU) at coarse cadence widens the confidence band", () => {
    const samples = Array.from({ length: 5 }, (_, i) => ({ ts: i * 60, speed: 50 })); // 60s cadence
    const m = scoreDrive(samples, { distanceKm: 5 });
    expect(m.accel_source).toBe("derived");
    expect(m.score_confidence).toBe("low");
    expect(m.score_low!).toBeLessThanOrEqual(m.score_high!);
  });

  it("counts a harsh turn via heading proxy for a sample that lacks lat_accel even when the drive has IMU elsewhere", () => {
    // The drive has genuine (varying) IMU on both axes early on, but the sharp
    // turn at the end has NO lat_accel sample; the per-sample heading proxy
    // must still catch it.
    const samples = [
      { ts: 0, speed: 40, heading: 0, lon_accel: 0.5, lat_accel: 0.2 },
      { ts: 10, speed: 40, heading: 0, lon_accel: 0.9, lat_accel: 0.4 },
      { ts: 20, speed: 40, heading: 90, lon_accel: 0.3 }, // no lat_accel here
      { ts: 25, speed: 40, heading: 180, lon_accel: 0.6 }, // 90° in 5s = 18°/s ≥ 12 → harsh turn
    ];
    const m = scoreDrive(samples, { distanceKm: 2 });
    expect(m.accel_source).toBe("imu");
    expect(m.harsh_turn_count).toBeGreaterThanOrEqual(1); // NOT silently dropped
  });

  // Regression (observed live 2026-07-28): when the budget ladder trimmed the
  // IMU fields out of the streaming plan, mergeLatest's merge-forever kept
  // serving the LAST value, so every sample of every drive carried the same
  // frozen number. Deltas were all zero, so harsh events vanished and drives
  // scored ~100 — while still claiming accel_source "imu". A 123 km/h, 148 kW
  // drive came back with a 95 and zero flagged events.
  it("treats a frozen (non-varying) IMU field as absent rather than as 'no acceleration'", () => {
    const frozen = -0.02125; // one constant, repeated — the merge-forever artifact
    const samples = [
      { ts: 0, speed: 0, heading: 0, lon_accel: frozen, lat_accel: -0.158 },
      { ts: 5, speed: 50, heading: 0, lon_accel: frozen, lat_accel: -0.158 },
      { ts: 10, speed: 95, heading: 0, lon_accel: frozen, lat_accel: -0.158 },
    ];
    const m = scoreDrive(samples, { distanceKm: 1 });
    // Honest about the source...
    expect(m.accel_source).toBe("derived");
    // ...and the Δv/Δt proxy sees what the frozen field hid: 0→50 km/h in 5s
    // is ~2.8 m/s², past the 2.5 harsh-accel line.
    expect(m.max_accel_ms2).toBeGreaterThan(2.5);
    expect(m.harsh_accel_count).toBeGreaterThanOrEqual(1);
    expect(m.behavior_score!).toBeLessThan(100); // NOT a silent perfect score
  });

  it("a frozen lat_accel re-enables the heading turn proxy instead of disabling both paths", () => {
    // Frozen lateral g sits below the harsh threshold forever, and its mere
    // presence used to suppress the heading proxy too — so cornering became
    // undetectable by any path.
    const samples = [
      { ts: 0, speed: 40, heading: 0, lat_accel: -0.158 },
      { ts: 5, speed: 40, heading: 90, lat_accel: -0.158 }, // 18°/s ≥ 12
      { ts: 10, speed: 40, heading: 180, lat_accel: -0.158 },
    ];
    const m = scoreDrive(samples, { distanceKm: 1 });
    expect(m.harsh_turn_count).toBeGreaterThanOrEqual(1);
  });

  it("still trusts a real IMU stream that happens to include repeated values", () => {
    const samples = [
      { ts: 0, speed: 10, heading: 0, lon_accel: 0.4, lat_accel: 0.1 },
      { ts: 5, speed: 20, heading: 0, lon_accel: 0.4, lat_accel: 0.1 }, // repeat
      { ts: 10, speed: 30, heading: 0, lon_accel: 1.7, lat_accel: 0.9 }, // varies ⇒ real
    ];
    const m = scoreDrive(samples, { distanceKm: 1 });
    expect(m.accel_source).toBe("imu");
    expect(m.max_accel_ms2).toBeCloseTo(1.7, 5); // the IMU value, not the proxy
  });
});

describe("score → percentile", () => {
  it("is monotonic and bounded", () => {
    expect(scoreToPercentile(100)).toBe(99);
    expect(scoreToPercentile(85)).toBe(76);
    expect(scoreToPercentile(50)).toBe(10);
    expect(scoreToPercentile(100)).toBeGreaterThan(scoreToPercentile(80));
    expect(scoreToPercentile(80)).toBeGreaterThan(scoreToPercentile(60));
  });
});
