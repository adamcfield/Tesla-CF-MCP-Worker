/**
 * One-active-session-per-vin invariant (idx_drives_one_active /
 * idx_charges_one_active): the DB-level backstop for the check-then-insert
 * race where the REST poller and the telemetry ingest path each open a
 * session for the same physical drive/charge (observed live 2026-07-11:
 * two charge_sessions rows created 1 second apart for one charge).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { getAppState, resetSchemaCacheForTests } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

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

const VIN = "TESTVINRACE000001";

afterEach(() => vi.restoreAllMocks());

describe("one active session per vin", () => {
  it("rejects a second concurrent ACTIVE drive for the same vin", async () => {
    const env = makeEnv();
    await getAppState(env, "x"); // triggers ensureSchema (tables + indexes)
    await env.DB.prepare(`INSERT INTO drives (vin, start_ts, status) VALUES (?1, 100, 'active')`).bind(VIN).run();
    await expect(
      env.DB.prepare(`INSERT INTO drives (vin, start_ts, status) VALUES (?1, 101, 'active')`).bind(VIN).run(),
    ).rejects.toThrow(/unique/i);
    // A COMPLETE row and another vin's active row are both still fine.
    await env.DB.prepare(`INSERT INTO drives (vin, start_ts, status) VALUES (?1, 102, 'complete')`).bind(VIN).run();
    await env.DB.prepare(`INSERT INTO drives (vin, start_ts, status) VALUES ('OTHERVIN000000001', 103, 'active')`).run();
  });

  it("rejects a second concurrent ACTIVE charge session for the same vin", async () => {
    const env = makeEnv();
    await getAppState(env, "x");
    await env.DB.prepare(`INSERT INTO charge_sessions (vin, start_ts, status) VALUES (?1, 100, 'active')`).bind(VIN).run();
    await expect(
      env.DB.prepare(`INSERT INTO charge_sessions (vin, start_ts, status) VALUES (?1, 101, 'active')`).bind(VIN).run(),
    ).rejects.toThrow(/unique/i);
    await env.DB.prepare(`INSERT INTO charge_sessions (vin, start_ts, status) VALUES (?1, 102, 'complete')`).bind(VIN).run();
  });

  it("supersedes pre-existing duplicate actives so index creation succeeds on a live DB", async () => {
    const env = makeEnv();
    await getAppState(env, "x"); // schema v1 with the index
    // Simulate a database that accumulated duplicates BEFORE this migration:
    // drop the indexes, insert dupes, then force ensureSchema to run again.
    await env.DB.prepare(`DROP INDEX idx_drives_one_active`).run();
    await env.DB.prepare(`DROP INDEX idx_charges_one_active`).run();
    await env.DB.prepare(`INSERT INTO drives (vin, start_ts, status) VALUES (?1, 100, 'active')`).bind(VIN).run();
    await env.DB.prepare(`INSERT INTO drives (vin, start_ts, status) VALUES (?1, 101, 'active')`).bind(VIN).run();
    await env.DB.prepare(`INSERT INTO charge_sessions (vin, start_ts, status) VALUES (?1, 100, 'active')`).bind(VIN).run();
    await env.DB.prepare(`INSERT INTO charge_sessions (vin, start_ts, status) VALUES (?1, 101, 'active')`).bind(VIN).run();

    resetSchemaCacheForTests(); // next store call re-runs ensureSchema
    await getAppState(env, "x");

    const drives = await env.DB.prepare(
      `SELECT status, COUNT(*) n FROM drives WHERE vin = ?1 GROUP BY status ORDER BY status`,
    ).bind(VIN).all<{ status: string; n: number }>();
    expect(drives.results).toEqual([
      { status: "active", n: 1 },
      { status: "superseded", n: 1 },
    ]);
    const charges = await env.DB.prepare(
      `SELECT status, end_ts FROM charge_sessions WHERE vin = ?1 ORDER BY id`,
    ).bind(VIN).all<{ status: string; end_ts: number | null }>();
    expect(charges.results?.[0]).toEqual({ status: "active", end_ts: null });
    // Superseded charge got an end_ts so getOpenChargeSession (end_ts IS NULL)
    // can never pick it up as the open session again.
    expect(charges.results?.[1]).toEqual({ status: "superseded", end_ts: 101 });
  });
});
