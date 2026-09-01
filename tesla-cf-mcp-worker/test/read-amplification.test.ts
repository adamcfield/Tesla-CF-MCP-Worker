/**
 * D1 rows_read guardrails.
 *
 * On 2026-09-01 this worker hit Cloudflare's D1 free-tier cap of 5,000,000
 * rows read per day (6.31M read against 69k written), which takes the WHOLE
 * deployment offline — every D1 read errors until the next UTC midnight, so
 * the dashboard, the poller, telemetry ingest and the automation tick all
 * fail together.
 *
 * The cause was not traffic: it was a handful of scheduled queries that
 * full-scan the biggest tables. Each looks indexed but isn't, and each ran on
 * a fixed cadence regardless of whether it could possibly match anything.
 *
 * The test D1 helper is real SQLite, so EXPLAIN QUERY PLAN is the honest
 * assertion here: a plan line containing "SCAN <table>" without "USING
 * ... INDEX" means SQLite is walking the whole table. These tests pin the
 * plans so a future edit can't silently reintroduce a scan on a hot path.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ensureSchema, knownVins, resetSchemaCacheForTests } from "../src/store";
import { getTelemetryFieldStatus } from "../src/ingest";
import { runMaintenanceIfDue } from "../src/rules";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINREADAMP001";
const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

function makeEnv(extra: Partial<Env> = {}): Env {
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
    ...extra,
  } as Env;
}

/** The `detail` column of every EXPLAIN QUERY PLAN row, joined. */
async function plan(env: Env, sql: string, params: unknown[] = []): Promise<string> {
  const rs = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return (rs.results ?? []).map((r) => r.detail).join(" | ");
}

/** True when SQLite walks `table` end to end rather than seeking an index. */
function fullScans(planText: string, table: string): boolean {
  return planText
    .split(" | ")
    .some((line) => line.includes(`SCAN ${table}`) && !line.includes("USING") );
}

describe("hot-path query plans (D1 rows_read)", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("the /health liveness probe seeks the newest sample instead of grouping every one", async () => {
    // The old form — SELECT vin, MAX(ts) FROM positions GROUP BY vin — reads
    // one index entry per stored sample on EVERY watchdog call (every 15 min).
    const grouped = await plan(env, `SELECT vin, MAX(ts) AS last_ts FROM positions GROUP BY vin`);
    expect(grouped).toContain("SCAN positions");

    const seek = await plan(
      env,
      `SELECT ts FROM positions WHERE vin = ?1 ORDER BY ts DESC LIMIT 1`,
      [VIN],
    );
    expect(seek).toContain("idx_positions_vin_ts");
    expect(fullScans(seek, "positions")).toBe(false);
  });

  it("the retention purge is an index range, not a scan of the two biggest tables", async () => {
    // Bare `ts <` matches no index prefix: telemetry_events is keyed
    // (vin, field, ts) and indexed (vin, ts); positions is indexed (vin, ts).
    expect(await plan(env, `DELETE FROM telemetry_events WHERE ts < ?1`, [NOW])).toContain(
      "SCAN telemetry_events",
    );

    const events = await plan(
      env,
      `DELETE FROM telemetry_events WHERE vin = ?1 AND ts < ?2`,
      [VIN, NOW],
    );
    expect(fullScans(events, "telemetry_events")).toBe(false);

    const positions = await plan(
      env,
      `DELETE FROM positions WHERE vin = ?1 AND ts < ?2 AND drive_id IS NULL`,
      [VIN, NOW],
    );
    expect(fullScans(positions, "positions")).toBe(false);
  });

  it("alert_log reads use an index (bell badge, delivery sweep, timeline)", async () => {
    // alert_log carried no index at all, and is read on every dashboard
    // refresh (45s while the car is active) and twice per automation tick.
    const badge = await plan(
      env,
      `SELECT * FROM alert_log WHERE vin = ?1 ORDER BY ts DESC LIMIT ?2`,
      [VIN, 50],
    );
    expect(fullScans(badge, "alert_log")).toBe(false);

    const recent = await plan(env, `SELECT * FROM alert_log ORDER BY ts DESC LIMIT ?1`, [50]);
    expect(fullScans(recent, "alert_log")).toBe(false);

    const pending = await plan(
      env,
      `SELECT id, kind, message FROM alert_log WHERE delivered = 0 AND ts >= ?1 ORDER BY ts ASC LIMIT 10`,
      [NOW - DAY],
    );
    expect(pending).toContain("idx_alert_log_pending");
  });

  it("the per-tick coach-note backlog and compaction backlogs are indexed", async () => {
    const coach = await plan(
      env,
      `SELECT * FROM drives WHERE status = 'complete' AND coach_note IS NULL AND behavior_score IS NOT NULL
       ORDER BY end_ts DESC LIMIT ?1`,
      [3],
    );
    expect(coach).toContain("idx_drives_coach_pending");

    const drives = await plan(
      env,
      `SELECT id FROM drives
       WHERE status = 'complete' AND start_ts < ?1 AND (positions_compacted IS NULL OR positions_compacted = 0)
       ORDER BY start_ts ASC LIMIT ?2`,
      [NOW, 100],
    );
    expect(fullScans(drives, "drives")).toBe(false);

    const sessions = await plan(
      env,
      `SELECT id FROM charge_sessions
       WHERE status = 'complete' AND start_ts < ?1 AND (curve_compacted IS NULL OR curve_compacted = 0)
       ORDER BY start_ts ASC LIMIT ?2`,
      [NOW, 100],
    );
    expect(fullScans(sessions, "charge_sessions")).toBe(false);
  });

  it("/data/summary's charge roll-up is indexed (most-called dashboard endpoint)", async () => {
    const charges = await plan(
      env,
      `SELECT COUNT(*) n, COALESCE(SUM(energy_added_kwh),0) kwh, COALESCE(SUM(cost),0) cost
       FROM charge_sessions WHERE vin = ?1 AND status = 'complete'`,
      [VIN],
    );
    expect(fullScans(charges, "charge_sessions")).toBe(false);
  });
});

describe("knownVins", () => {
  it("prefers POLL_VINS and unions in vins seen in drives", async () => {
    const env = makeEnv({ POLL_VINS: "CONFIGURED_VIN_1, CONFIGURED_VIN_2" } as Partial<Env>);
    await ensureSchema(env);
    await env.DB.prepare(`INSERT INTO drives (vin, start_ts, status) VALUES (?1, ?2, 'complete')`)
      .bind("HISTORIC_VIN_ONLY", NOW - 30 * DAY)
      .run();

    const vins = await knownVins(env);
    expect(vins).toContain("CONFIGURED_VIN_1");
    expect(vins).toContain("CONFIGURED_VIN_2");
    // A vehicle dropped from POLL_VINS must still get its history swept.
    expect(vins).toContain("HISTORIC_VIN_ONLY");
    expect(new Set(vins).size).toBe(vins.length);
  });

  it("survives a D1 failure by falling back to the configured list", async () => {
    const env = makeEnv({ POLL_VINS: "CONFIGURED_VIN_1" } as Partial<Env>);
    resetSchemaCacheForTests();
    env.DB = {
      prepare: () => {
        throw new Error("D1_ERROR: rows read limit exceeded");
      },
      batch: () => Promise.reject(new Error("D1_ERROR")),
    } as unknown as D1Database;
    expect(await knownVins(env)).toEqual(["CONFIGURED_VIN_1"]);
  });
});

describe("runMaintenanceIfDue", () => {
  it("runs once, then stays quiet until the daily interval elapses", async () => {
    const env = makeEnv({ POLL_VINS: VIN } as Partial<Env>);
    await ensureSchema(env);

    const first: Record<string, unknown> = {};
    expect(await runMaintenanceIfDue(env, first)).toBe(true);
    expect(first.maintenance).toBe("ran");

    // Every subsequent tick in the same day is a no-op — this is the change
    // that takes the sweeps from ~96 runs/day to 1.
    for (let i = 0; i < 5; i++) {
      const again: Record<string, unknown> = {};
      expect(await runMaintenanceIfDue(env, again)).toBe(false);
      expect(again.maintenance).toBeUndefined();
    }

    // Backdate the stamp past the interval and it runs again.
    await env.DB.prepare(`UPDATE app_state SET value = ?1 WHERE key = 'maintenance_ts'`)
      .bind(String(NOW - 2 * DAY))
      .run();
    expect(await runMaintenanceIfDue(env, {})).toBe(true);
  });

  it("still purges genuinely expired raw history when it does run", async () => {
    const env = makeEnv({ POLL_VINS: VIN, RETENTION_DAYS: "30" } as Partial<Env>);
    await ensureSchema(env);
    const old = NOW - 60 * DAY;
    const recent = NOW - 5 * DAY;

    for (const ts of [old, recent]) {
      await env.DB.prepare(
        `INSERT INTO telemetry_events (vin, ts, field, value_num) VALUES (?1, ?2, 'soc', 55)`,
      ).bind(VIN, ts).run();
      // drive_id NULL = an idle sample, which is what the purge targets.
      await env.DB.prepare(`INSERT INTO positions (vin, ts, soc) VALUES (?1, ?2, 55)`)
        .bind(VIN, ts)
        .run();
    }
    // A route sample of the same age must survive — drive history is permanent.
    // (+1s: idx_positions_vin_ts is UNIQUE on (vin, ts).)
    await env.DB.prepare(`INSERT INTO drives (vin, start_ts, status) VALUES (?1, ?2, 'complete')`)
      .bind(VIN, old)
      .run();
    await env.DB.prepare(`INSERT INTO positions (vin, ts, drive_id, soc) VALUES (?1, ?2, 1, 55)`)
      .bind(VIN, old + 1)
      .run();

    const summary: Record<string, unknown> = {};
    expect(await runMaintenanceIfDue(env, summary)).toBe(true);
    expect(summary.purge_error).toBeUndefined();
    expect(summary.purged_rows).toBe(2); // one event + one idle position

    const events = await env.DB.prepare(`SELECT ts FROM telemetry_events`).all<{ ts: number }>();
    expect(events.results?.map((r) => r.ts)).toEqual([recent]);

    const positions = await env.DB.prepare(`SELECT ts, drive_id FROM positions ORDER BY ts`)
      .all<{ ts: number; drive_id: number | null }>();
    expect(positions.results).toEqual([
      { ts: old + 1, drive_id: 1 }, // route sample kept
      { ts: recent, drive_id: null },
    ]);
  });
});

describe("getTelemetryFieldStatus", () => {
  it("reports per-field last-seen without grouping over every stored event", async () => {
    const env = makeEnv();
    await ensureSchema(env);

    // Two mapped EAV fields, several samples each, plus a lot of noise under a
    // third field. The old GROUP BY read every one of these rows; the seek
    // form reads one per mapped field.
    const rows: Array<[string, number]> = [
      ["sentry", NOW - 3 * DAY],
      ["sentry", NOW - DAY],
      ["media_title", NOW - 2 * DAY],
    ];
    for (let i = 0; i < 200; i++) rows.push(["tpms_fl", NOW - i * 60]);
    for (const [field, ts] of rows) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO telemetry_events (vin, ts, field, value_num, value_text)
         VALUES (?1, ?2, ?3, 1, 'x')`,
      ).bind(VIN, ts, field).run();
    }

    const seek = await plan(
      env,
      `SELECT ts FROM telemetry_events WHERE vin = ?1 AND field = ?2 ORDER BY ts DESC LIMIT 1`,
      [VIN, "sentry"],
    );
    expect(fullScans(seek, "telemetry_events")).toBe(false);

    const out = (await getTelemetryFieldStatus(env, VIN)) as {
      vin: string;
      fields: Array<{ tesla: string; canonical: string; last_seen: number | null }>;
    };
    expect(out.vin).toBe(VIN);
    const byCanonical = new Map(out.fields.map((f) => [f.canonical, f.last_seen]));
    // Newest sample per field, not the oldest and not a count.
    expect(byCanonical.get("sentry")).toBe(NOW - DAY);
    expect(byCanonical.get("media_title")).toBe(NOW - 2 * DAY);
    expect(byCanonical.get("tpms_fl")).toBe(NOW);
    // A mapped field that never arrived stays null rather than being omitted.
    expect(out.fields.some((f) => f.last_seen === null)).toBe(true);
  });
});
