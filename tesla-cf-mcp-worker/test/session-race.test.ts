/**
 * One-active-session-per-vin invariant (idx_drives_one_active /
 * idx_charges_one_active): the DB-level backstop for the check-then-insert
 * race where the REST poller and the telemetry ingest path each open a
 * session for the same physical drive/charge (observed live 2026-07-11:
 * two charge_sessions rows created 1 second apart for one charge).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { getAppState, resetSchemaCacheForTests } from "../src/store";
import { recordConnectivityState } from "../src/tracking";
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

describe("one open vehicle_states row per vin", () => {
  it("rejects a second concurrent OPEN row for the same vin", async () => {
    const env = makeEnv();
    await getAppState(env, "x");
    await env.DB.prepare(`INSERT INTO vehicle_states (vin, state, start_ts, source) VALUES (?1, 'online', 100, 'ingest')`).bind(VIN).run();
    await expect(
      env.DB.prepare(`INSERT INTO vehicle_states (vin, state, start_ts, source) VALUES (?1, 'driving', 101, 'ingest')`).bind(VIN).run(),
    ).rejects.toThrow(/unique/i);
    // A CLOSED row and another vin's open row are both still fine.
    await env.DB.prepare(`INSERT INTO vehicle_states (vin, state, start_ts, end_ts, source) VALUES (?1, 'offline', 102, 103, 'cron')`).bind(VIN).run();
    await env.DB.prepare(`INSERT INTO vehicle_states (vin, state, start_ts, source) VALUES ('OTHERVIN000000001', 'online', 104, 'ingest')`).run();
  });

  it("supersedes pre-existing duplicate open rows, keeping the one getOpenState would actually pick (by start_ts, not insertion order)", async () => {
    const env = makeEnv();
    await getAppState(env, "x"); // schema v1 with the index
    await env.DB.prepare(`DROP INDEX idx_vehicle_states_one_open`).run();
    // Replays the exact historical bug pattern (2026-07-08): four inserts
    // within two seconds where insertion order and start_ts order disagree --
    // the row inserted 3rd (id 3below) has an EARLIER start_ts than the row
    // inserted 2nd (id 2), so a naive "keep MAX(id)" migration would keep the
    // wrong row and orphan this one exactly like the original bug did.
    await env.DB.prepare(`INSERT INTO vehicle_states (vin, state, start_ts, source) VALUES (?1, 'driving', 1000, 'ingest')`).bind(VIN).run(); // id 1, closed below
    await env.DB.prepare(`UPDATE vehicle_states SET end_ts = 1001 WHERE vin = ?1 AND start_ts = 1000`).bind(VIN).run();
    await env.DB.prepare(`INSERT INTO vehicle_states (vin, state, start_ts, source) VALUES (?1, 'driving', 1002, 'ingest')`).bind(VIN).run(); // id 2, start_ts 1002 -- the one that SHOULD survive
    await env.DB.prepare(`INSERT INTO vehicle_states (vin, state, start_ts, source) VALUES (?1, 'driving', 1001, 'ingest')`).bind(VIN).run(); // id 3, start_ts 1001 -- earlier despite the higher id; this is the historical ghost row

    resetSchemaCacheForTests(); // next store call re-runs ensureSchema (migration + index)
    await getAppState(env, "x");

    const open = await env.DB.prepare(
      `SELECT id, start_ts FROM vehicle_states WHERE vin = ?1 AND end_ts IS NULL`,
    ).bind(VIN).all<{ id: number; start_ts: number }>();
    expect(open.results).toHaveLength(1);
    expect(open.results?.[0].start_ts).toBe(1002); // NOT the higher-id, earlier-start_ts row
    const superseded = await env.DB.prepare(
      `SELECT start_ts, end_ts FROM vehicle_states WHERE vin = ?1 AND start_ts = 1001`,
    ).bind(VIN).first<{ start_ts: number; end_ts: number | null }>();
    expect(superseded!.end_ts).toBe(1001); // closed at its own start_ts, not left dangling
  });

  it("a genuine concurrent race (cron vs ingest) never leaves the vin with zero or two open rows (regression: ~70h phantom 'driving' entry)", async () => {
    const env = makeEnv();
    await getAppState(env, "x");
    // Two callers racing to record a state transition for the same vin at
    // nearly the same instant -- cron's connectivity check landing alongside
    // a telemetry-ingest-driven transition, the exact mechanism behind the
    // original bug. Both start from no open row, so both see open=null and
    // both attempt an insert -- updateStateTimeline's catch must absorb the
    // constraint violation instead of throwing or losing the state.
    await Promise.all([
      recordConnectivityState(env, VIN, "asleep"),
      recordConnectivityState(env, VIN, "offline"),
    ]);
    const open = await env.DB.prepare(
      `SELECT COUNT(*) n FROM vehicle_states WHERE vin = ?1 AND end_ts IS NULL`,
    ).bind(VIN).first<{ n: number }>();
    expect(open!.n).toBe(1); // never 0 (state silently lost), never >1 (orphan risk)
  });
});
