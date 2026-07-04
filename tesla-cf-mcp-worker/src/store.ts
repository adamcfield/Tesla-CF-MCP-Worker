/**
 * Persistence: D1 for history (telemetry events, charge sessions, alert log),
 * KV for the latest-state document per vehicle (fast, no query cost).
 *
 * History powers: battery-degradation tracking, per-trip efficiency, charge
 * session cost logs, mileage/odometer records, Grafana/HA series endpoints.
 */

import { Env } from "./types";

export interface LatestState {
  vin: string;
  updated_at: number; // unix seconds of last ingest/poll
  [field: string]: unknown; // canonical fields: soc, lat, lon, odometer_km, ...
}

let schemaReady = false;

export async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS telemetry_events (
         vin TEXT NOT NULL, ts INTEGER NOT NULL, field TEXT NOT NULL,
         value_num REAL, value_text TEXT,
         PRIMARY KEY (vin, field, ts)
       )`,
    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_events_vin_ts ON telemetry_events (vin, ts)`),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS charge_sessions (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         vin TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER,
         start_soc REAL, end_soc REAL, energy_added_kwh REAL,
         lat REAL, lon REAL, cost REAL, price_cents_kwh REAL
       )`,
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS alert_log (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ts INTEGER NOT NULL, vin TEXT, rule_id TEXT, kind TEXT,
         message TEXT, payload TEXT, delivered INTEGER DEFAULT 0
       )`,
    ),
  ]);
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Latest state (KV)
// ---------------------------------------------------------------------------

const latestKey = (vin: string) => `latest:${vin}`;

export async function getLatest(env: Env, vin: string): Promise<LatestState | null> {
  return env.TESLA_KV.get<LatestState>(latestKey(vin), "json");
}

export async function mergeLatest(
  env: Env,
  vin: string,
  patch: Record<string, unknown>,
  ts: number,
): Promise<{ previous: LatestState | null; current: LatestState }> {
  const previous = await getLatest(env, vin);
  const current: LatestState = { ...(previous ?? {}), ...patch, vin, updated_at: ts };
  await env.TESLA_KV.put(latestKey(vin), JSON.stringify(current));
  return { previous, current };
}

// ---------------------------------------------------------------------------
// Telemetry event history (D1)
// ---------------------------------------------------------------------------

export interface TelemetryEvent {
  field: string;
  value: unknown;
  ts: number; // unix seconds
}

export async function recordEvents(env: Env, vin: string, events: TelemetryEvent[]): Promise<void> {
  if (!events.length) return;
  await ensureSchema(env);
  const stmt = env.DB.prepare(
    `INSERT OR REPLACE INTO telemetry_events (vin, ts, field, value_num, value_text)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  );
  await env.DB.batch(
    events.map((e) => {
      const num = typeof e.value === "number" ? e.value : typeof e.value === "boolean" ? (e.value ? 1 : 0) : null;
      const text = num === null ? String(e.value) : null;
      return stmt.bind(vin, e.ts, e.field, num, text);
    }),
  );
}

export async function querySeries(
  env: Env,
  vin: string,
  field: string,
  hours: number,
  limit = 2000,
): Promise<{ ts: number; value: number | string | null }[]> {
  await ensureSchema(env);
  const since = Math.floor(Date.now() / 1000) - Math.round(hours * 3600);
  const rs = await env.DB.prepare(
    `SELECT ts, value_num, value_text FROM telemetry_events
     WHERE vin = ?1 AND field = ?2 AND ts >= ?3 ORDER BY ts ASC LIMIT ?4`,
  )
    .bind(vin, field, since, limit)
    .all<{ ts: number; value_num: number | null; value_text: string | null }>();
  return (rs.results ?? []).map((r) => ({ ts: r.ts, value: r.value_num ?? r.value_text }));
}

export async function listFields(env: Env, vin: string): Promise<string[]> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT DISTINCT field FROM telemetry_events WHERE vin = ?1 ORDER BY field`,
  )
    .bind(vin)
    .all<{ field: string }>();
  return (rs.results ?? []).map((r) => r.field);
}

// ---------------------------------------------------------------------------
// Charge sessions — state machine driven by charging_state transitions
// ---------------------------------------------------------------------------

const CHARGING = new Set(["Charging", "Starting"]);

export async function trackChargeSession(
  env: Env,
  vin: string,
  previous: LatestState | null,
  current: LatestState,
  priceCentsKwh?: number,
): Promise<void> {
  const before = String(previous?.charging_state ?? "");
  const after = String(current.charging_state ?? "");
  if (before === after) return;
  await ensureSchema(env);
  const now = current.updated_at;

  if (!CHARGING.has(before) && CHARGING.has(after)) {
    await env.DB.prepare(
      `INSERT INTO charge_sessions (vin, start_ts, start_soc, lat, lon, price_cents_kwh)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(vin, now, num(current.soc), num(current.lat), num(current.lon), priceCentsKwh ?? null)
      .run();
    return;
  }

  if (CHARGING.has(before) && !CHARGING.has(after)) {
    const energy = num(current.charge_energy_added);
    const open = await env.DB.prepare(
      `SELECT id, price_cents_kwh FROM charge_sessions WHERE vin = ?1 AND end_ts IS NULL ORDER BY start_ts DESC LIMIT 1`,
    )
      .bind(vin)
      .first<{ id: number; price_cents_kwh: number | null }>();
    if (!open) return;
    const cost =
      energy !== null && open.price_cents_kwh !== null ? (energy * open.price_cents_kwh) / 100 : null;
    await env.DB.prepare(
      `UPDATE charge_sessions SET end_ts = ?2, end_soc = ?3, energy_added_kwh = ?4, cost = ?5 WHERE id = ?1`,
    )
      .bind(open.id, now, num(current.soc), energy, cost)
      .run();
  }
}

export async function listChargeSessions(env: Env, vin: string, limit = 20): Promise<unknown[]> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT * FROM charge_sessions WHERE vin = ?1 ORDER BY start_ts DESC LIMIT ?2`,
  )
    .bind(vin, limit)
    .all();
  return rs.results ?? [];
}

// ---------------------------------------------------------------------------
// Alert log
// ---------------------------------------------------------------------------

export async function logAlert(
  env: Env,
  entry: { vin?: string; ruleId: string; kind: string; message: string; payload?: unknown; delivered: boolean },
): Promise<void> {
  await ensureSchema(env);
  await env.DB.prepare(
    `INSERT INTO alert_log (ts, vin, rule_id, kind, message, payload, delivered)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      Math.floor(Date.now() / 1000),
      entry.vin ?? null,
      entry.ruleId,
      entry.kind,
      entry.message,
      entry.payload === undefined ? null : JSON.stringify(entry.payload),
      entry.delivered ? 1 : 0,
    )
    .run();
}

export async function listAlerts(env: Env, vin: string | undefined, limit = 50): Promise<unknown[]> {
  await ensureSchema(env);
  const rs = vin
    ? await env.DB.prepare(`SELECT * FROM alert_log WHERE vin = ?1 ORDER BY ts DESC LIMIT ?2`)
        .bind(vin, limit)
        .all()
    : await env.DB.prepare(`SELECT * FROM alert_log ORDER BY ts DESC LIMIT ?1`).bind(limit).all();
  return rs.results ?? [];
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
