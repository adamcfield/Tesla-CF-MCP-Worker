/**
 * New derivation queries: monthly report, efficiency-by-temp, stale-session
 * auto-close, and the jerk metric. All run against the real SQLite-backed
 * FakeD1 so the SQL itself is what's tested.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { scoreDrive } from "../src/scoring";
import { ensureSchema, resetSchemaCacheForTests } from "../src/store";
import { applyDerivation } from "../src/tracking";
import { backfillSyntheticDrives, closeStaleSessions, getEfficiencyByTemp, getMonthlyReport } from "../src/tracking";
import type { LatestState } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINDERIVE0001";

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
    DEFAULT_TZ: "Etc/UTC", // deterministic bucketing in tests
  } as Env;
}

async function insertDrive(
  env: Env,
  o: { start_ts: number; distance_km: number; efficiency_wh_km: number | null; outside_temp_avg: number | null; energy?: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO drives (vin, start_ts, end_ts, status, distance_km, efficiency_wh_km, outside_temp_avg, energy_used_kwh, duration_min)
     VALUES (?1, ?2, ?3, 'complete', ?4, ?5, ?6, ?7, 30)`,
  )
    .bind(VIN, o.start_ts, o.start_ts + 1800, o.distance_km, o.efficiency_wh_km, o.outside_temp_avg, o.energy ?? 5)
    .run();
}

describe("efficiency by temperature", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("buckets drives into 5°C bins, distance-weighted", async () => {
    const t = 1_750_000_000;
    await insertDrive(env, { start_ts: t, distance_km: 10, efficiency_wh_km: 200, outside_temp_avg: 12 });
    await insertDrive(env, { start_ts: t + 3600, distance_km: 30, efficiency_wh_km: 160, outside_temp_avg: 13.5 });
    await insertDrive(env, { start_ts: t + 7200, distance_km: 20, efficiency_wh_km: 140, outside_temp_avg: 27 });
    await insertDrive(env, { start_ts: t + 9000, distance_km: 1, efficiency_wh_km: 900, outside_temp_avg: 12 }); // <2km — excluded

    const res = (await getEfficiencyByTemp(env, VIN)) as { bins: any[] };
    expect(res.bins.length).toBe(2);
    const bin10 = res.bins.find((b) => b.t_min === 10)!;
    // 10 km @200 + 30 km @160 → (2000+4800)/40 = 170
    expect(bin10.avg_wh_km).toBe(170);
    expect(bin10.drives).toBe(2);
    const bin25 = res.bins.find((b) => b.t_min === 25)!;
    expect(bin25.avg_wh_km).toBe(140);
  });
});

describe("monthly report", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("rolls up drives + charges per month with AC/DC split and cost/100km", async () => {
    const june = Date.UTC(2026, 5, 10) / 1000;
    const july = Date.UTC(2026, 6, 10) / 1000;
    await insertDrive(env, { start_ts: june, distance_km: 100, efficiency_wh_km: 150, outside_temp_avg: 25, energy: 15 });
    await insertDrive(env, { start_ts: july, distance_km: 50, efficiency_wh_km: 180, outside_temp_avg: 30, energy: 9 });
    await env.DB.prepare(
      `INSERT INTO charge_sessions (vin, start_ts, end_ts, status, charge_type, energy_added_kwh, cost, currency)
       VALUES (?1, ?2, ?3, 'complete', 'DC', 40, 60, 'ILS')`,
    ).bind(VIN, june + 3600, june + 5400).run();
    await env.DB.prepare(
      `INSERT INTO charge_sessions (vin, start_ts, end_ts, status, charge_type, energy_added_kwh, cost, currency)
       VALUES (?1, ?2, ?3, 'complete', 'AC', 20, 10, 'ILS')`,
    ).bind(VIN, june + 90000, june + 100000).run();

    const res = (await getMonthlyReport(env, VIN, 12)) as { months: any[] };
    expect(res.months.length).toBe(2);
    const m6 = res.months.find((m) => m.month === "2026-06")!;
    expect(m6.drives).toBe(1);
    expect(m6.distance_km).toBe(100);
    expect(m6.charge_sessions).toBe(2);
    expect(m6.dc_kwh).toBe(40);
    expect(m6.ac_kwh).toBe(20);
    expect(m6.charge_cost).toBe(70);
    expect(m6.cost_per_100km).toBe(70); // 70 over 100 km
    expect(res.months[0]!.month).toBe("2026-07"); // most recent first
  });
});

describe("stale-session auto-close", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("closes an abandoned open drive at its last sample, leaves fresh ones alone", async () => {
    const old = Math.floor(Date.now() / 1000) - 12 * 3600;
    const res = await env.DB.prepare(
      `INSERT INTO drives (vin, start_ts, status, start_odometer) VALUES (?1, ?2, 'active', 1000)`,
    ).bind(VIN, old).run();
    const driveId = Number(res.meta.last_row_id);
    // Two samples: drive moved 5 km, last sample 11h ago.
    await env.DB.prepare(
      `INSERT INTO positions (vin, ts, drive_id, activity, speed, odometer, soc) VALUES (?1, ?2, ?3, 'driving', 50, 1000, 80)`,
    ).bind(VIN, old, driveId).run();
    await env.DB.prepare(
      `INSERT INTO positions (vin, ts, drive_id, activity, speed, odometer, soc) VALUES (?1, ?2, ?3, 'driving', 60, 1005, 78)`,
    ).bind(VIN, old + 600, driveId).run();

    // A FRESH open drive must not be touched.
    const fresh = await env.DB.prepare(
      `INSERT INTO drives (vin, start_ts, status) VALUES (?1, ?2, 'active')`,
    ).bind(VIN, Math.floor(Date.now() / 1000) - 60).run();

    const out = await closeStaleSessions(env);
    expect(out.closed_drives).toBe(1);
    const closed = await env.DB.prepare(`SELECT status, end_ts, distance_km FROM drives WHERE id = ?1`)
      .bind(driveId).first<any>();
    expect(closed.status).toBe("complete");
    expect(closed.end_ts).toBe(old + 600); // ended AT the last sample, not "now"
    expect(closed.distance_km).toBe(5);
    const stillOpen = await env.DB.prepare(`SELECT status FROM drives WHERE id = ?1`)
      .bind(Number(fresh.meta.last_row_id)).first<any>();
    expect(stillOpen.status).toBe("active");
  });
});

describe("odometer-jump drive recovery (missed by poll gaps)", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("synthesizes a drive when the odometer jumps between two parked polls", async () => {
    const t = 1_750_000_000;
    // Poll 1: parked at home, odo 1000. Poll 2 (an hour later): parked, odo 1012
    // — 12 km driven in the gap, never seen as "driving".
    const p1: LatestState = { vin: VIN, updated_at: t, odometer: 1000, lat: 32.08, lon: 34.79, soc: 80, gear: "P", speed: 0 };
    const p2: LatestState = { vin: VIN, updated_at: t + 3600, odometer: 1012, lat: 32.02, lon: 34.75, soc: 74, gear: "P", speed: 0 };
    await applyDerivation(env, VIN, t, null, p1);
    await applyDerivation(env, VIN, t + 3600, p1, p2);

    const rs = await env.DB.prepare(`SELECT distance_km, synthetic, status, start_odometer, end_odometer FROM drives WHERE vin = ?1`).bind(VIN).all<any>();
    const synth = (rs.results ?? []).find((d) => d.synthetic === 1);
    expect(synth).toBeTruthy();
    expect(synth.distance_km).toBeCloseTo(12, 1);
    expect(synth.status).toBe("complete");
  });

  it("does NOT synthesize during a real captured drive (guarded by activity + open drive)", async () => {
    const t = 1_750_100_000;
    // P -> D -> P with a moving odometer: the normal engine captures it; no synthetic dup.
    const park: LatestState = { vin: VIN, updated_at: t, odometer: 2000, lat: 32.0, lon: 34.8, soc: 90, gear: "P", speed: 0 };
    const drive: LatestState = { vin: VIN, updated_at: t + 60, odometer: 2003, lat: 32.01, lon: 34.81, soc: 89, gear: "D", speed: 40 };
    const park2: LatestState = { vin: VIN, updated_at: t + 120, odometer: 2005, lat: 32.02, lon: 34.82, soc: 88, gear: "P", speed: 0 };
    await applyDerivation(env, VIN, t, null, park);
    await applyDerivation(env, VIN, t + 60, park, drive);
    await applyDerivation(env, VIN, t + 120, drive, park2);
    const synthCount = await env.DB.prepare(`SELECT COUNT(*) n FROM drives WHERE vin = ?1 AND synthetic = 1`).bind(VIN).first<{ n: number }>();
    expect(synthCount!.n).toBe(0); // real drive captured, no synthetic duplicate
  });

  it("backfillSyntheticDrives recovers a jump from the positions history, idempotently", async () => {
    const t = 1_750_200_000;
    // Two parked position samples (drive_id NULL) with a 9 km odometer jump.
    await env.DB.prepare(`INSERT INTO positions (vin, ts, activity, odometer, lat, lon, soc) VALUES (?1,?2,'idle',5000,32.0,34.8,70)`).bind(VIN, t).run();
    await env.DB.prepare(`INSERT INTO positions (vin, ts, activity, odometer, lat, lon, soc) VALUES (?1,?2,'idle',5009,32.05,34.85,66)`).bind(VIN, t + 3600).run();
    const first = await backfillSyntheticDrives(env, VIN) as { drives_recovered: number };
    expect(first.drives_recovered).toBe(1);
    const again = await backfillSyntheticDrives(env, VIN) as { drives_recovered: number };
    expect(again.drives_recovered).toBe(0); // idempotent — the span is already covered
  });
});

describe("jerk metric", () => {
  it("reports peak Δaccel/Δt and survives gaps", () => {
    // 10s cadence: 0→50 km/h (accel 1.39), then 50→50 (0), then hard 50→0 (−1.39).
    const s = (ts: number, speed: number) => ({ ts, speed });
    const m = scoreDrive([s(0, 0), s(10, 50), s(20, 50), s(30, 0)], { distanceKm: 1 });
    expect(m.max_jerk_ms3).not.toBeNull();
    // Jerk between pair1 (accel 1.39) and pair2 (0) = 0.139; pair2→pair3 same.
    expect(m.max_jerk_ms3!).toBeCloseTo(0.139, 2);
    // A gap larger than MAX_GAP_S must reset the jerk chain, not fabricate a spike.
    const gapped = scoreDrive([s(0, 0), s(10, 50), s(1000, 50), s(1010, 0)], { distanceKm: 1 });
    expect(gapped.max_jerk_ms3).toBeNull();
  });
});
