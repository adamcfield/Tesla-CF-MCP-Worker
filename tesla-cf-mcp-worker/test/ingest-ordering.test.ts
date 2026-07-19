/**
 * Ingest ordering + data-quality guards: buffered/out-of-order telemetry
 * batches arriving as separate POSTs must never corrupt the permanent
 * derived history (observed live 2026-07-18: second-long driving/charging
 * flip-flop rows in vehicle_states from a replayed backlog), and retried
 * POSTs / clock-insane stamps must not duplicate or poison rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { applyIngest, handleIngest } from "../src/ingest";
import { getAppState, getLatest, resetSchemaCacheForTests } from "../src/store";
import { closeStaleSessions, getStateTimeline } from "../src/tracking";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

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

const VIN = "TESTVINORDERING01";
const NOW = Math.floor(Date.now() / 1000);

function req(body: unknown): Request {
  return new Request("https://test/ingest/telemetry", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("late-batch watermark", () => {
  it("a replayed older batch becomes EAV history only -- no state transition, no field reversion", async () => {
    const env = makeEnv();
    const t = NOW - 600;
    // Live "now": parked.
    await handleIngest(req({ vin: VIN, ts: t + 300, data: { Gear: "P", VehicleSpeed: 0, Soc: 60 } }), env);
    // A buffered mid-drive batch from 5 minutes EARLIER arrives afterwards
    // (separate POST -- handleIngest's in-POST sort can't order across POSTs).
    await handleIngest(req({ vin: VIN, ts: t, data: { Gear: "D", VehicleSpeed: 50, Soc: 62 } }), env);

    const latest = await getLatest(env, VIN);
    expect(latest?.gear).toBe("P"); // NOT reverted to "D"
    expect(latest?.soc).toBe(60);
    // The timeline never opened a bogus 'driving' span from the replay.
    const timeline = (await getStateTimeline(env, VIN, 24)) as { state: string }[];
    expect(timeline.every((r) => r.state !== "driving")).toBe(true);
    // But the raw history KEPT the late data (speed is a positions column, so
    // check an EAV field from the same batch).
    const socRow = await env.DB.prepare(
      `SELECT value_num FROM telemetry_events WHERE vin = ?1 AND field = 'soc' AND ts = ?2`,
    ).bind(VIN, t).first<{ value_num: number }>();
    expect(socRow?.value_num).toBe(62);
  });

  it("small stream-vs-REST arrival jitter (within tolerance) still applies normally", async () => {
    const env = makeEnv();
    const t = NOW - 600;
    await applyIngest(env, { vin: VIN, ts: t, fields: { Soc: 60 } });
    await applyIngest(env, { vin: VIN, ts: t - 3, fields: { OutsideTemp: 31 } }); // 3s < 5s tolerance
    const latest = await getLatest(env, VIN);
    expect(latest?.outside_temp).toBe(31); // applied, not dropped
  });
});

describe("clock-insane timestamps", () => {
  it("rejects far-future and ancient stamps instead of feeding them to derivation", async () => {
    const env = makeEnv();
    const res = await handleIngest(req({ events: [
      { vin: VIN, ts: NOW + 3600, data: { Soc: 50 } }, // 1h in the future
      { vin: VIN, ts: NOW - 40 * 86400, data: { Soc: 51 } }, // 40 days old
      { vin: VIN, ts: NOW, data: { Soc: 52 } }, // sane
    ] }), env);
    const body = (await res.json()) as { accepted: number; rejected: number };
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(2);
    expect((await getLatest(env, VIN))?.soc).toBe(52);
  });
});

describe("retry-safe positions", () => {
  it("a retried batch doesn't double-insert the (vin, ts) sample", async () => {
    const env = makeEnv();
    const t = NOW - 60;
    const batch = { vin: VIN, ts: t, data: { Gear: "D", VehicleSpeed: 50, Soc: 60 } };
    await handleIngest(req(batch), env);
    await handleIngest(req(batch), env); // bridge retry of the same POST
    const n = await env.DB.prepare(
      `SELECT COUNT(*) n FROM positions WHERE vin = ?1 AND ts = ?2`,
    ).bind(VIN, t).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});

describe("stream-liveness freshness", () => {
  it("a backlog drain of old buffered data does NOT stamp the stream as alive", async () => {
    const env = makeEnv();
    await handleIngest(req({ vin: VIN, ts: NOW - 3600, data: { Soc: 60 } }), env);
    expect(await getAppState(env, `stream_ok_ts:${VIN}`)).toBeNull();
    // Fresh data does stamp it.
    await handleIngest(req({ vin: VIN, ts: NOW, data: { Soc: 61 } }), env);
    expect(await getAppState(env, `stream_ok_ts:${VIN}`)).not.toBeNull();
  });
});

describe("stale vehicle_states sweep", () => {
  it("closes an abandoned open 'driving' row at the vin's last-heard-from time (regression: multi-day phantom drives)", async () => {
    const env = makeEnv();
    const t = NOW - 10 * 3600; // stream died mid-drive 10h ago
    await applyIngest(env, { vin: VIN, ts: t, fields: { Gear: "D", VehicleSpeed: 60, Soc: 60, Odometer: 100 } });
    const openBefore = await env.DB.prepare(
      `SELECT state FROM vehicle_states WHERE vin = ?1 AND end_ts IS NULL`,
    ).bind(VIN).first<{ state: string }>();
    expect(openBefore?.state).toBe("driving");

    const res = await closeStaleSessions(env);
    expect(res.closed_states).toBe(1);
    const openAfter = await env.DB.prepare(
      `SELECT id FROM vehicle_states WHERE vin = ?1 AND end_ts IS NULL`,
    ).bind(VIN).first();
    expect(openAfter).toBeNull();
    const closed = await env.DB.prepare(
      `SELECT end_ts FROM vehicle_states WHERE vin = ?1 AND state = 'driving'`,
    ).bind(VIN).first<{ end_ts: number }>();
    expect(closed?.end_ts).toBe(t); // ended when last heard from, not "now"
  });

  it("leaves a recently-active open row alone", async () => {
    const env = makeEnv();
    await applyIngest(env, { vin: VIN, ts: NOW - 60, fields: { Gear: "D", VehicleSpeed: 60 } });
    const res = await closeStaleSessions(env);
    expect(res.closed_states).toBe(0);
  });
});

describe("synthetic-drive guards", () => {
  it("skips synthesis when the implied speed is physically impossible (corrupt odometer jump)", async () => {
    const env = makeEnv();
    const t = NOW - 600;
    await applyIngest(env, { vin: VIN, ts: t, fields: { Gear: "P", VehicleSpeed: 0, Odometer: 100 / 1.609344 } });
    // 10 minutes later the odometer "jumped" 400 km -- 2400 km/h implied.
    await applyIngest(env, { vin: VIN, ts: t + 600, fields: { Gear: "P", VehicleSpeed: 0, Odometer: 500 / 1.609344 } });
    const n = await env.DB.prepare(
      `SELECT COUNT(*) n FROM drives WHERE vin = ?1 AND synthetic = 1`,
    ).bind(VIN).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("still synthesizes a plausible missed drive", async () => {
    const env = makeEnv();
    const t = NOW - 3600;
    await applyIngest(env, { vin: VIN, ts: t, fields: { Gear: "P", VehicleSpeed: 0, Odometer: 100 / 1.609344, Soc: 70 } });
    // An hour later, 20 km further along -- a real missed drive.
    await applyIngest(env, { vin: VIN, ts: t + 3600, fields: { Gear: "P", VehicleSpeed: 0, Odometer: 120 / 1.609344, Soc: 66 } });
    const n = await env.DB.prepare(
      `SELECT COUNT(*) n FROM drives WHERE vin = ?1 AND synthetic = 1 AND status = 'complete'`,
    ).bind(VIN).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});
