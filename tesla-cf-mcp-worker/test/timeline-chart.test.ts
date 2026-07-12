/**
 * Chart explorer backend (getTimelineChart): activity-aware downsampling
 * (driving keeps ~4x the resolution of idle/charging/sleeping), stage layer,
 * and debounced event markers (harsh brake/accel, track changes, alerts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ensureSchema, resetSchemaCacheForTests } from "../src/store";
import { getTimelineChart } from "../src/tracking";
import { logAlert } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINEXPLORER01";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
});
afterEach(() => vi.restoreAllMocks());

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

const NOW = Math.floor(Date.now() / 1000);

async function insertPos(env: Env, ts: number, activity: string, over: Record<string, number | string | null> = {}): Promise<void> {
  const cols = { speed: null, soc: null, inside_temp: null, outside_temp: null, lon_accel: null, charging_state: null, ...over };
  await env.DB.prepare(
    `INSERT INTO positions (vin, ts, activity, speed, soc, inside_temp, outside_temp, lon_accel, charging_state)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
  ).bind(VIN, ts, activity, cols.speed, cols.soc, cols.inside_temp, cols.outside_temp, cols.lon_accel, cols.charging_state).run();
}

describe("activity-aware downsampling", () => {
  it("keeps driving dense and idle sparse", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    const t0 = NOW - 3600 * 5;
    // 4800 driving samples at 1s cadence, then 1800 idle samples at 10s cadence.
    for (let i = 0; i < 4800; i += 4) await insertPos(env, t0 + i, "driving", { speed: 60 + (i % 40), soc: 70 });
    for (let i = 0; i < 1800; i += 4) await insertPos(env, t0 + 4800 + i * 10, "idle", { speed: 0, soc: 70 });

    const out = (await getTimelineChart(env, VIN, 6, ["speed", "soc"])) as {
      series: Record<string, [number, number][]>;
      resolution: { rows: number; kept: number; stride_driving: number; stride_other: number };
      segments: { stage: string }[];
    };
    const drivingKept = out.series.speed.filter(([, v]) => v > 0).length;
    const idleKept = out.series.speed.filter(([, v]) => v === 0).length;
    // Driving inherits the big budget: with 1200 driving rows and 450 idle rows
    // seeded, driving keeps everything (stride 1) while both stay within budget.
    expect(out.resolution.stride_driving).toBe(1);
    expect(drivingKept).toBeGreaterThan(idleKept);
    expect(out.resolution.kept).toBeLessThanOrEqual(out.resolution.rows);
    // Stage layer captured the driving -> resting transition.
    expect(out.segments.map((s) => s.stage)).toEqual(["driving", "resting"]);
  });

  it("thins a huge driving window to the budget instead of returning everything", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    const t0 = NOW - 3600 * 3;
    for (let i = 0; i < 6000; i++) await insertPos(env, t0 + i, "driving", { speed: 50, soc: 60 });
    const out = (await getTimelineChart(env, VIN, 4, ["speed"])) as {
      series: Record<string, [number, number][]>;
      resolution: { stride_driving: number };
    };
    expect(out.resolution.stride_driving).toBeGreaterThan(1);
    // budget + boundary rows; comfortably under the raw 6000.
    expect(out.series.speed.length).toBeLessThan(3000);
    expect(out.series.speed.length).toBeGreaterThan(1500);
  });

  it("rejects unknown junk fields instead of interpolating them into SQL", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    await insertPos(env, NOW - 60, "idle", { soc: 50 });
    const out = (await getTimelineChart(env, VIN, 1, ["soc", "ts; DROP TABLE positions--", "NotAField!"])) as {
      fields: string[];
    };
    expect(out.fields).toEqual(["soc"]);
  });
});

describe("event markers", () => {
  it("debounces a multi-second braking maneuver into one peak marker", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    const t0 = NOW - 600;
    // 5 consecutive seconds above the brake threshold (peak in the middle),
    // then clean driving, then a separate hard-accel burst.
    const brake = [-3.2, -3.8, -4.4, -3.6, -3.1];
    for (let i = 0; i < 60; i++) {
      const a = i >= 10 && i < 15 ? brake[i - 10] : i >= 40 && i < 42 ? 2.8 : 0;
      await insertPos(env, t0 + i, "driving", { speed: 80, lon_accel: a });
    }
    const out = (await getTimelineChart(env, VIN, 1, ["speed"])) as {
      markers: { ts: number; kind: string; label: string }[];
    };
    const brakes = out.markers.filter((m) => m.kind === "harsh_brake");
    const accels = out.markers.filter((m) => m.kind === "harsh_accel");
    expect(brakes).toHaveLength(1);
    expect(brakes[0].ts).toBe(t0 + 12); // the peak sample, not the first
    expect(brakes[0].label).toContain("-0.45 g");
    expect(accels).toHaveLength(1);
  });

  it("ignores accelerometer noise while not driving", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    await insertPos(env, NOW - 100, "idle", { lon_accel: -5 });
    const out = (await getTimelineChart(env, VIN, 1, ["speed"])) as { markers: unknown[] };
    expect(out.markers).toHaveLength(0);
  });

  it("emits one music marker per track change with the artist matched nearby", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    const t0 = NOW - 900;
    await insertPos(env, t0, "idle", { soc: 50 });
    const ev = (ts: number, field: string, text: string) =>
      env.DB.prepare(`INSERT INTO telemetry_events (vin, ts, field, value_text) VALUES (?1,?2,?3,?4)`)
        .bind(VIN, ts, field, text).run();
    await ev(t0 + 10, "media_title", "Song A");
    await ev(t0 + 12, "media_artist", "Artist A");
    await ev(t0 + 40, "media_title", "Song A"); // repeat -> collapsed
    await ev(t0 + 200, "media_title", "Song B"); // no artist nearby
    const out = (await getTimelineChart(env, VIN, 1, ["soc"])) as {
      markers: { kind: string; label: string }[];
    };
    const music = out.markers.filter((m) => m.kind === "music");
    expect(music.map((m) => m.label)).toEqual(["Song A — Artist A", "Song B"]);
  });

  it("includes worker alerts (vin-specific and global) as warning markers", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    await insertPos(env, NOW - 100, "idle", { soc: 50 });
    await logAlert(env, { vin: VIN, ruleId: "r1", kind: "alert", message: "Tyre FL dropped", delivered: false });
    await logAlert(env, { ruleId: "budget_watchdog", kind: "budget", message: "Spend at 96%", delivered: false });
    const out = (await getTimelineChart(env, VIN, 1, ["soc"])) as {
      markers: { kind: string; label: string }[];
    };
    const alerts = out.markers.filter((m) => m.kind === "alert").map((m) => m.label);
    expect(alerts).toContain("Tyre FL dropped");
    expect(alerts).toContain("Spend at 96%");
  });
});
