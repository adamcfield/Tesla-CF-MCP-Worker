/**
 * positions.power staleness: Tesla's Fleet Telemetry stream has no
 * equivalent of REST's drive_state.power, so the canonical "power" field can
 * only ever be refreshed by a billed REST poll (see power_ts in ingest.ts).
 * Telemetry-first throttles those to ~hourly whenever streaming is healthy,
 * so mergeLatest's merge-forever semantics would otherwise smear one hourly
 * snapshot across every streaming-driven position sample taken in between
 * (observed live 2026-07-13: a whole day of drives stuck at the single
 * negative/zero reading from the last reconciliation poll). This must expire.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ensureSchema, resetSchemaCacheForTests } from "../src/store";
import { applyDerivation } from "../src/tracking";
import type { LatestState } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINPOWERSTAL1";

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

async function latestPower(env: Env, ts: number): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT power FROM positions WHERE vin = ?1 AND ts = ?2`,
  ).bind(VIN, ts).first<{ power: number | null }>();
  return row?.power ?? null;
}

const driving = (over: Partial<LatestState>): LatestState =>
  ({ vin: VIN, gear: "D", speed: 80, ...over }) as LatestState;

describe("positions.power staleness", () => {
  it("records power when the REST-derived reading is fresh", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    const t = 1_750_000_000;
    await applyDerivation(env, VIN, t, null, driving({ power: 42, power_ts: t }));
    expect(await latestPower(env, t)).toBe(42);
  });

  it("nulls power once the reading is older than the poll cadence, instead of smearing it forward", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    const t = 1_750_000_000;
    const staleTs = t - 6 * 60; // just past the 5-minute staleness window
    await applyDerivation(env, VIN, t, null, driving({ power: -19, power_ts: staleTs }));
    expect(await latestPower(env, t)).toBeNull();
  });

  it("nulls power when no timestamp was ever recorded (pre-fix data)", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    // Simulates the exact bug: a merged-forever value with no companion ts.
    await applyDerivation(env, VIN, 1_750_000_000, null, driving({ power: -19 }));
    expect(await latestPower(env, 1_750_000_000)).toBeNull();
  });

  it("a real drive keeps fresh power across repeated in-window samples", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    const t = 1_750_000_000;
    let previous: LatestState | null = null;
    for (let i = 0; i < 5; i++) {
      const ts = t + i * 60;
      const current = driving({ power: 10 + i * 5, power_ts: ts });
      await applyDerivation(env, VIN, ts, previous, current);
      previous = current;
    }
    expect(await latestPower(env, t + 4 * 60)).toBe(30);
  });

  it("a single reconciliation poll's power reading goes stale mid-drive on later streaming-only samples", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    const t = 1_750_000_000;
    // One real REST-derived reading...
    const withPoll = driving({ power: 72, power_ts: t });
    await applyDerivation(env, VIN, t, null, withPoll);
    expect(await latestPower(env, t)).toBe(72);

    // ...then streaming-only samples arrive for the next 10 minutes with no
    // fresh power_ts (mergeLatest still carries the old power/power_ts
    // forward in `current`, exactly like production). None of these should
    // keep reporting 72 kW once the reading is stale.
    const laterTs = t + 10 * 60;
    await applyDerivation(env, VIN, laterTs, withPoll, driving({ power: 72, power_ts: t, speed: 95 }));
    expect(await latestPower(env, laterTs)).toBeNull();
  });
});
