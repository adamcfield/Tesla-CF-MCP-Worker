import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { applyIngest, getTelemetryFieldStatus, handleIngest } from "../src/ingest";
import { getAppState, getLatest, querySeries, resetSchemaCacheForTests } from "../src/store";
import { getDrives, getStateTimeline, getChargeSessions, getBatteryTimeline } from "../src/tracking";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

// Derivation makes best-effort external calls (Nominatim reverse-geocode,
// Overpass speed limits). Stub fetch to fail fast so tests stay deterministic
// and don't hit the network (a real call blows the 5s test timeout).
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
});
afterEach(() => vi.restoreAllMocks());

function makeEnv(): Env {
  resetSchemaCacheForTests(); // each env gets a fresh in-memory DB — re-provision it
  return {
    TESLA_KV: new FakeKV() as unknown as KVNamespace,
    DB: new FakeD1() as unknown as D1Database,
    TESLA_REGION: "eu",
    PUBLIC_ORIGIN: "https://test.example.com",
    TESLA_CLIENT_ID: "cid",
    TESLA_CLIENT_SECRET: "secret",
    TESLA_PRIVATE_KEY: "pk",
    MCP_AUTH_TOKEN: "tok",
  } as Env;
}

const VIN = "TESTVIN0000000001";

describe("ingest value normalization", () => {
  let env: Env;
  beforeEach(() => { env = makeEnv(); });

  it("stores a fleet-telemetry Location wrapper as lat/lon, not an object", async () => {
    await handleIngest(req({ vin: VIN, ts: 1000, data: [
      { key: "Location", value: { locationValue: { latitude: 32.08, longitude: 34.78 } } },
      { key: "Soc", value: { stringValue: "72" } },
    ]}), env);
    const latest = await getLatest(env, VIN);
    expect(latest?.lat).toBe(32.08);
    expect(latest?.lon).toBe(34.78);
    expect(latest?.soc).toBe(72);
  });

  it("unwraps an arbitrary enum wrapper generically (no [object Object])", async () => {
    // Regression: only 6 wrapper keys were handled; detailedChargeStateValue
    // fell through as a raw object and stringified to "[object Object]".
    await handleIngest(req({ vin: VIN, ts: 1000, data: [
      { key: "DetailedChargeState", value: { detailedChargeStateValue: "DetailedChargeStateCharging" } },
    ]}), env);
    const latest = await getLatest(env, VIN);
    expect(latest?.charging_state).toBe("Charging"); // prefix stripped, not "[object Object]"
    const series = await querySeries(env, VIN, "charging_state", 1);
    for (const p of series) expect(p.value).not.toBe("[object Object]");
  });

  it("skips a sensor marked {invalid:true} instead of overwriting with an object", async () => {
    await handleIngest(req({ vin: VIN, ts: 1000, data: [{ key: "Soc", value: { stringValue: "80" } }] }), env);
    await handleIngest(req({ vin: VIN, ts: 1001, data: [{ key: "Soc", value: { invalid: true } }] }), env);
    const latest = await getLatest(env, VIN);
    expect(latest?.soc).toBe(80); // not clobbered by the invalid sample
  });

  it("normalizes Tesla's imperial distance/speed fields to metric", async () => {
    // Tesla returns miles/mph on both paths regardless of region; columns are km.
    await handleIngest(req({ vin: VIN, ts: 1000, data: {
      Odometer: 100,        // miles
      EstBatteryRange: 200, // miles
      VehicleSpeed: 60,     // mph
      OutsideTemp: 15,      // already °C — must NOT be scaled
    }}), env);
    const latest = await getLatest(env, VIN);
    expect(latest?.odometer).toBeCloseTo(160.9344, 3);
    expect(latest?.est_range).toBeCloseTo(321.8688, 3);
    expect(latest?.speed).toBeCloseTo(96.56, 1);
    expect(latest?.outside_temp).toBe(15);
  });

  it("coerces a bare-string numeric in the array shape so it still converts to km", async () => {
    // Regression: unwrapFtValue returned bare primitives without coerce(), so
    // {"key":"Odometer","value":"50000"} stayed a string and toMetric's
    // number-only guard skipped the mi->km conversion.
    await handleIngest(req({ vin: VIN, ts: 1000, data: [
      { key: "Odometer", value: "50000" },
    ]}), env);
    const latest = await getLatest(env, VIN);
    expect(latest?.odometer).toBeCloseTo(50000 * 1.609344, 1);
  });

  it("reports accepted/rejected counts and rejects vin-less items", async () => {
    const resp = await handleIngest(req({ events: [
      { vin: VIN, ts: 1000, data: { Soc: 50 } },
      { ts: 1000, data: { Soc: 50 } }, // no vin
    ]}), env);
    expect(await resp.json()).toEqual({ accepted: 1, rejected: 1 });
  });
});

describe("stream-liveness stamp", () => {
  it("handleIngest (the streaming route) stamps stream_ok_ts; the REST path does not", async () => {
    const env = makeEnv();
    await handleIngest(req({ vin: VIN, ts: 1000, data: { Soc: 55 } }), env);
    const stamp = await getAppState(env, `stream_ok_ts:${VIN}`);
    expect(Number(stamp)).toBeGreaterThan(0);

    // REST path (applyIngest direct) must NOT refresh the stamp -- that would
    // make the poller think streaming is alive and suppress its own reads.
    const env2 = makeEnv();
    await applyIngest(env2, parsed(VIN, 2000, { Soc: 56 }));
    expect(await getAppState(env2, `stream_ok_ts:${VIN}`)).toBeNull();
  });
});

describe("drive derivation", () => {
  let env: Env;
  beforeEach(() => { env = makeEnv(); });

  it("segments a P -> D -> P sequence into one completed drive", async () => {
    const base = 1_700_000_000;
    await applyIngest(env, parsed(VIN, base, { Gear: "P", Odometer: 1000, Soc: 80, Location: { latitude: 32.0, longitude: 34.0 }, VehicleSpeed: 0 }));
    await applyIngest(env, parsed(VIN, base + 100, { Gear: "D", Odometer: 1001.5, Soc: 79, Location: { latitude: 32.01, longitude: 34.01 }, VehicleSpeed: 45 }));
    await applyIngest(env, parsed(VIN, base + 200, { Gear: "P", Odometer: 1003.2, Soc: 78, Location: { latitude: 32.02, longitude: 34.02 }, VehicleSpeed: 0 }));

    const drives = (await getDrives(env, VIN)) as any[];
    expect(drives.length).toBe(1);
    const d = drives[0];
    expect(d.status).toBe("complete");
    // Odometer fed as miles (1001.5 -> 1003.2 = 1.7 mi) is normalized to km.
    expect(d.distance_km).toBeCloseTo(1.7 * 1.609344, 2);
    expect(d.start_soc).toBe(79); // SoC is a %, never scaled
    expect(d.end_soc).toBe(78);
    expect(d.max_speed).toBeCloseTo(45 * 1.609344, 1); // 45 mph -> km/h
  });

  it("discards a no-movement drive (parking jitter) rather than persisting it", async () => {
    const base = 1_700_010_000;
    await applyIngest(env, parsed(VIN, base, { Gear: "P", Odometer: 2000, Soc: 60, VehicleSpeed: 0 }));
    // a single D sample with no odometer change, immediately back to P
    await applyIngest(env, parsed(VIN, base + 5, { Gear: "D", Odometer: 2000, Soc: 60, VehicleSpeed: 0 }));
    await applyIngest(env, parsed(VIN, base + 10, { Gear: "P", Odometer: 2000, Soc: 60, VehicleSpeed: 0 }));
    const drives = (await getDrives(env, VIN)) as any[];
    expect(drives.length).toBe(0);
  });
});

describe("state timeline derivation", () => {
  it("records online -> driving -> online transitions", async () => {
    const env = makeEnv();
    const base = 1_700_020_000;
    await applyIngest(env, parsed(VIN, base, { Gear: "P", Odometer: 3000, Soc: 90, VehicleSpeed: 0 }));
    await applyIngest(env, parsed(VIN, base + 100, { Gear: "D", Odometer: 3002, Soc: 89, VehicleSpeed: 50 }));
    await applyIngest(env, parsed(VIN, base + 200, { Gear: "P", Odometer: 3004, Soc: 88, VehicleSpeed: 0 }));
    // Wide window: the fixed test timestamps are historical, and getStateTimeline
    // filters closed rows by `end_ts >= now - hours`.
    const states = (await getStateTimeline(env, VIN, 24 * 366 * 100)) as any[];
    const seq = states.map((s) => s.state).reverse(); // query returns DESC
    expect(seq).toContain("driving");
    expect(seq[0]).toBe("online");
  });
});

describe("battery timeline derivation", () => {
  it("splits idle into resting (unplugged) vs connected (plugged in, not charging)", async () => {
    const env = makeEnv();
    const base = 1_700_040_000;
    // parked, unplugged -> resting (two samples, so the segment has real duration)
    await applyIngest(env, parsed(VIN, base, { Gear: "P", VehicleSpeed: 0, Soc: 50, ChargingState: "Disconnected" }));
    await applyIngest(env, parsed(VIN, base + 60, { Gear: "P", VehicleSpeed: 0, Soc: 50, ChargingState: "Disconnected" }));
    // driving
    await applyIngest(env, parsed(VIN, base + 120, { Gear: "D", VehicleSpeed: 40, Odometer: 100, Soc: 51 }));
    await applyIngest(env, parsed(VIN, base + 180, { Gear: "D", VehicleSpeed: 40, Odometer: 101, Soc: 51.5 }));
    // parked again, unplugged -> a second, separate resting segment
    await applyIngest(env, parsed(VIN, base + 240, { Gear: "P", VehicleSpeed: 0, Odometer: 102, Soc: 52, ChargingState: "Disconnected" }));
    // plugged in and charging
    await applyIngest(env, parsed(VIN, base + 300, { ChargingState: "Charging", Soc: 53, VehicleSpeed: 0, Gear: "P" }));
    await applyIngest(env, parsed(VIN, base + 360, { ChargingState: "Charging", Soc: 60, VehicleSpeed: 0, Gear: "P" }));
    // charge limit reached: still plugged in, no longer charging -> connected
    await applyIngest(env, parsed(VIN, base + 420, { ChargingState: "Complete", Soc: 80, VehicleSpeed: 0, Gear: "P" }));

    const tl = (await getBatteryTimeline(env, VIN, 24 * 366 * 100)) as any;
    const stages = tl.points.map((p: any) => p.stage);
    expect(stages).toEqual(["resting", "resting", "driving", "driving", "resting", "charging", "charging", "connected"]);
    // stage_hours is rounded to 2dp, so 60s (0.016666h) rounds to 0.02.
    expect(tl.stage_hours.driving).toBeCloseTo(60 / 3600, 2);
    expect(tl.stage_hours.charging).toBeCloseTo(60 / 3600, 2);
    expect(tl.stage_hours.resting).toBeCloseTo(60 / 3600, 2); // only the first resting segment has 2 samples
    // Last point is still open (no later sample), so it contributes no duration yet.
    expect(tl.stage_hours.connected).toBe(0);
    expect(tl.segments.length).toBe(5); // resting, driving, resting, charging, connected
  });

  it("downsamples points but keeps segments computed from the full series", async () => {
    const env = makeEnv();
    const base = 1_700_050_000;
    for (let i = 0; i < 50; i++) {
      await applyIngest(env, parsed(VIN, base + i * 10, { Gear: "P", VehicleSpeed: 0, Soc: 60 + i * 0.1, ChargingState: "Disconnected" }));
    }
    const tl = (await getBatteryTimeline(env, VIN, 24 * 366 * 100)) as any;
    expect(tl.points.length).toBeLessThanOrEqual(2000);
    expect(tl.segments.length).toBe(1);
    expect(tl.segments[0].stage).toBe("resting");
  });
});

describe("charge session derivation", () => {
  it("opens and closes a session across a charging_state transition", async () => {
    const env = makeEnv();
    const base = 1_700_030_000;
    await applyIngest(env, parsed(VIN, base, { ChargingState: "Disconnected", Soc: 40, Odometer: 5000, VehicleSpeed: 0, Gear: "P" }));
    await applyIngest(env, parsed(VIN, base + 60, { ChargingState: "Charging", Soc: 41, ChargeEnergyAdded: 0.5, VehicleSpeed: 0, Gear: "P" }));
    await applyIngest(env, parsed(VIN, base + 120, { ChargingState: "Charging", Soc: 45, ChargeEnergyAdded: 3.0, VehicleSpeed: 0, Gear: "P" }));
    await applyIngest(env, parsed(VIN, base + 180, { ChargingState: "Complete", Soc: 46, ChargeEnergyAdded: 3.5, VehicleSpeed: 0, Gear: "P" }));
    const sessions = (await getChargeSessions(env, VIN)) as any[];
    expect(sessions.length).toBe(1);
    expect(sessions[0].status).toBe("complete");
    expect(sessions[0].energy_added_kwh).toBeCloseTo(3.5, 1);
    expect(sessions[0].start_soc).toBe(41);
    expect(sessions[0].end_soc).toBe(46);
  });
});

// --- helpers ---------------------------------------------------------------

function parsed(vin: string, ts: number, data: Record<string, unknown>) {
  // Mirror ingest's ParsedIngest shape (raw telemetry field names).
  return { vin, ts, fields: data };
}

function req(body: unknown): Request {
  return new Request("https://test.example.com/ingest/telemetry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("telemetry field status", () => {
  it("reports value + last-seen for mapped fields, null for never-seen ones", async () => {
    const env = makeEnv();
    const base = 1_700_060_000;
    await applyIngest(env, parsed(VIN, base, { Soc: 72, Gear: "P", VehicleSpeed: 0, SentryMode: true }));

    const res = (await getTelemetryFieldStatus(env, VIN)) as any;
    const byTesla = new Map(res.fields.map((f: any) => [f.tesla, f]));

    const soc = byTesla.get("Soc") as any;
    expect(soc.canonical).toBe("soc");
    expect(soc.value).toBe(72);
    expect(soc.last_seen).toBe(base); // position-column field -> latest positions row ts

    const sentry = byTesla.get("SentryMode") as any;
    expect(sentry.value).not.toBeNull(); // EAV field, normalized at ingest
    expect(sentry.last_seen).toBe(base);

    // Mapped but never streamed on this car -> null value, null last_seen.
    const acIn = byTesla.get("ACChargingEnergyIn") as any;
    expect(acIn).toBeDefined();
    expect(acIn.value).toBeNull();
    expect(acIn.last_seen).toBeNull();
  });
});
