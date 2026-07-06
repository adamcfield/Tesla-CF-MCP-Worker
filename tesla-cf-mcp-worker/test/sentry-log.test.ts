/**
 * getSentryLog: normalizes SentryMode into "off"/"idle"/"armed"/"aware"/"panic"
 * and reads it back uniformly whether the account only ever streamed a plain
 * boolean (legacy rows, or a REST-poll-only account) or the richer
 * SentryModeState enum. Trigger events are only ever derived from the enum
 * states (aware/panic) — a boolean-only account gets armed-hours but no
 * events, with a note explaining why.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ensureSchema, resetSchemaCacheForTests, recordEvents } from "../src/store";
import { getSentryLog } from "../src/tracking";
import { applyIngest } from "../src/ingest";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINSENTRY0001";
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

describe("normalizeSentryState (via applyIngest)", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("normalizes a plain boolean into armed/off", async () => {
    await applyIngest(env, { vin: VIN, ts: NOW - 100, fields: { SentryMode: true } });
    await applyIngest(env, { vin: VIN, ts: NOW - 50, fields: { SentryMode: false } });
    const res = (await getSentryLog(env, VIN, 1)) as { has_data: boolean; enum_available: boolean };
    expect(res.has_data).toBe(true);
    expect(res.enum_available).toBe(false);
  });

  it("strips the SentryModeState prefix and lowercases enum strings", async () => {
    await applyIngest(env, { vin: VIN, ts: NOW - 100, fields: { SentryMode: "SentryModeStateAware" } });
    const res = (await getSentryLog(env, VIN, 1)) as { enum_available: boolean; events: { to: string }[] };
    expect(res.enum_available).toBe(true);
  });
});

describe("getSentryLog", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("reports has_data:false with no sentry telemetry recorded", async () => {
    const res = (await getSentryLog(env, VIN, 30)) as { has_data: boolean };
    expect(res.has_data).toBe(false);
  });

  it("reads legacy boolean-only rows (value_num, no value_text) the same as new string rows", async () => {
    // Simulates rows written before normalizeSentryState existed.
    await recordEvents(env, VIN, [
      { field: "sentry", value: true, ts: NOW - 3600 },
      { field: "sentry", value: false, ts: NOW - 1800 },
    ]);
    const res = (await getSentryLog(env, VIN, 1)) as { has_data: boolean; enum_available: boolean; armed_hours: number };
    expect(res.has_data).toBe(true);
    expect(res.enum_available).toBe(false);
    expect(res.armed_hours).toBeGreaterThan(0);
  });

  it("boolean-only account: tracks armed hours but detects no events, with an explanatory note", async () => {
    await recordEvents(env, VIN, [
      { field: "sentry", value: "armed", ts: NOW - 7200 },
      { field: "sentry", value: "off", ts: NOW - 3600 },
    ]);
    const res = (await getSentryLog(env, VIN, 1)) as {
      enum_available: boolean; event_count: number; note?: string; armed_hours: number;
    };
    expect(res.enum_available).toBe(false);
    expect(res.event_count).toBe(0);
    expect(res.armed_hours).toBeCloseTo(1, 1); // armed for exactly 1 hour before going off
    expect(res.note).toMatch(/on\/off/);
  });

  it("detects a trigger event (armed -> aware) and pairs it with the nearest position", async () => {
    const t0 = NOW - 3600;
    await recordEvents(env, VIN, [
      { field: "sentry", value: "armed", ts: t0 },
      { field: "sentry", value: "aware", ts: t0 + 300 },
      { field: "sentry", value: "armed", ts: t0 + 360 },
    ]);
    // A nearby position sample to pair with the trigger.
    await env.DB.prepare(
      `INSERT INTO positions (vin, ts, lat, lon) VALUES (?1, ?2, ?3, ?4)`,
    ).bind(VIN, t0 + 290, 32.08, 34.78).run();

    const res = (await getSentryLog(env, VIN, 1)) as {
      enum_available: boolean;
      event_count: number;
      panic_count: number;
      events: { to: string; from: string; lat: number | null; lon: number | null }[];
    };
    expect(res.enum_available).toBe(true);
    expect(res.event_count).toBe(1);
    expect(res.panic_count).toBe(0);
    expect(res.events[0]).toMatchObject({ from: "armed", to: "aware", lat: 32.08, lon: 34.78 });
  });

  it("counts a panic transition separately from aware", async () => {
    const t0 = NOW - 3600;
    await recordEvents(env, VIN, [
      { field: "sentry", value: "armed", ts: t0 },
      { field: "sentry", value: "panic", ts: t0 + 100 },
      { field: "sentry", value: "armed", ts: t0 + 200 },
    ]);
    const res = (await getSentryLog(env, VIN, 1)) as { panic_count: number; event_count: number };
    expect(res.panic_count).toBe(1);
    expect(res.event_count).toBe(1);
  });

  it("does not double-count a repeated identical state as a new event", async () => {
    const t0 = NOW - 3600;
    await recordEvents(env, VIN, [
      { field: "sentry", value: "aware", ts: t0 },
      { field: "sentry", value: "aware", ts: t0 + 60 },
    ]);
    const res = (await getSentryLog(env, VIN, 1)) as { event_count: number };
    expect(res.event_count).toBe(0);
  });

  it("only counts rows within the requested day window", async () => {
    const oldTs = NOW - 60 * 86400;
    await recordEvents(env, VIN, [{ field: "sentry", value: "armed", ts: oldTs }]);
    const res = (await getSentryLog(env, VIN, 30)) as { has_data: boolean };
    expect(res.has_data).toBe(false);
  });
});
