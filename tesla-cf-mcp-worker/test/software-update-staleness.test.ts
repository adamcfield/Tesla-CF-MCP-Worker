/**
 * timelineState "updating" label: SoftwareUpdateInstallationPercentComplete
 * is an on-change field Tesla sends WHILE an update installs, then simply
 * stops — there's no reliable terminal 0/100 packet. mergeLatest's
 * merge-forever semantics mean a single stale sample would otherwise read as
 * "still updating" indefinitely (observed live 2026-07-12: one real 1%
 * sample from the night before fragmented the whole next day's idle time
 * into four bogus "Software update" timeline entries). This must expire.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ensureSchema, resetSchemaCacheForTests } from "../src/store";
import { applyDerivation } from "../src/tracking";
import type { LatestState } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINSWUPDATE01";

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

async function latestTimelineState(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT state FROM vehicle_states WHERE vin = ?1 ORDER BY start_ts DESC LIMIT 1`,
  ).bind(VIN).first<{ state: string }>();
  return row?.state ?? null;
}

const idle = (over: Partial<LatestState>): LatestState =>
  ({ vin: VIN, gear: "P", speed: 0, charging_state: "Disconnected", ...over }) as LatestState;

describe("software-update timeline staleness", () => {
  it("labels 'updating' when the sample is fresh", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    const t = 1_750_000_000;
    await applyDerivation(env, VIN, t, null, idle({ software_update_pct: 1, software_update_pct_ts: t }));
    expect(await latestTimelineState(env)).toBe("updating");
  });

  it("falls back to 'online' once the sample is older than a real OTA ever takes", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    const t = 1_750_000_000;
    const staleTs = t - 91 * 60; // just past the 90-minute staleness window
    await applyDerivation(env, VIN, t, null, idle({ software_update_pct: 1, software_update_pct_ts: staleTs }));
    expect(await latestTimelineState(env)).toBe("online");
  });

  it("reads as 'online' when no timestamp was ever recorded (pre-fix data)", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    // Simulates the exact bug: a merged-forever pct with no companion ts,
    // which is what every pre-fix latest-state doc looks like.
    await applyDerivation(env, VIN, 1_750_000_000, null, idle({ software_update_pct: 1 }));
    expect(await latestTimelineState(env)).toBe("online");
  });

  it("a real update stays 'updating' across repeated fresh samples, minute to minute", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    const t = 1_750_000_000;
    let previous: LatestState | null = null;
    for (let i = 0; i < 5; i++) {
      const ts = t + i * 60;
      const current = idle({ software_update_pct: 1 + i * 5, software_update_pct_ts: ts });
      await applyDerivation(env, VIN, ts, previous, current);
      previous = current;
    }
    expect(await latestTimelineState(env)).toBe("updating");
  });

  it("charging still wins over a fresh 'updating' signal", async () => {
    const env = makeEnv();
    await ensureSchema(env);
    const t = 1_750_000_000;
    await applyDerivation(env, VIN, t, null, {
      vin: VIN, gear: "P", speed: 0, charging_state: "Charging",
      software_update_pct: 1, software_update_pct_ts: t,
    } as LatestState);
    expect(await latestTimelineState(env)).toBe("charging");
  });
});
