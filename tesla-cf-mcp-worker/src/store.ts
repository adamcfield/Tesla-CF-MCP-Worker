/**
 * Persistence primitives: D1 schema + generic stores, KV latest-state.
 *
 * Two layers live on top of this:
 *   - tracking.ts — the ingest-time derivation engine (positions, drives,
 *     charge sessions + curve, state timeline, locations) and the read queries
 *     that power both MCP tools and the /data REST routes.
 *   - rules.ts    — the automation engine.
 *
 * This module owns the schema (ensureSchema), the KV latest-state doc, the
 * generic EAV history (telemetry_events) used by get_history/list_history_fields
 * for arbitrary fields, and the alert log. Structured, per-ingest samples live
 * in the `positions` table (written by tracking.ts) — querySeries prefers it.
 */

import { Env } from "./types";

export interface LatestState {
  vin: string;
  updated_at: number; // unix seconds of last ingest/poll
  [field: string]: unknown; // canonical fields: soc, lat, lon, odometer, ...
}

// One-time per-isolate guard: in the Worker a single isolate serves many
// requests against the same D1, so caching this is correct. Tests that spin up
// multiple in-memory databases must reset it (resetSchemaCacheForTests).
let schemaReady = false;

/** Test-only: clears the ensureSchema guard so a fresh test DB re-provisions. */
export function resetSchemaCacheForTests(): void {
  schemaReady = false;
}

/**
 * Structured columns held on the `positions` table. querySeries/get_history
 * read these directly from positions; any other field falls back to the
 * generic telemetry_events EAV store.
 */
export const POSITION_COLUMNS = new Set([
  "lat", "lon", "elevation", "heading", "speed", "power", "odometer",
  "soc", "usable_soc", "energy_remaining", "rated_range", "est_range",
  "ideal_range", "inside_temp", "outside_temp", "charging_state",
  "charger_power", "charger_voltage", "charger_current", "charge_energy_added",
]);

export async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  await env.DB.batch([
    // --- pre-existing tables (kept verbatim so old deployments migrate cleanly)
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

    // --- positions: one structured sample per ingest ----------------------
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS positions (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         vin TEXT NOT NULL, ts INTEGER NOT NULL,
         drive_id INTEGER, activity TEXT,
         lat REAL, lon REAL, elevation REAL, heading REAL,
         speed REAL, power REAL, odometer REAL,
         soc REAL, usable_soc REAL, energy_remaining REAL,
         rated_range REAL, est_range REAL, ideal_range REAL,
         inside_temp REAL, outside_temp REAL,
         charging_state TEXT, charger_power REAL, charger_voltage REAL,
         charger_current REAL, charge_energy_added REAL
       )`,
    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_positions_vin_ts ON positions (vin, ts)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_positions_drive ON positions (drive_id)`),

    // --- drives: derived from shift/speed transitions ---------------------
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS drives (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         vin TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER,
         status TEXT NOT NULL DEFAULT 'active',
         start_lat REAL, start_lon REAL, end_lat REAL, end_lon REAL,
         start_location_id INTEGER, end_location_id INTEGER,
         start_odometer REAL, end_odometer REAL, distance_km REAL,
         start_soc REAL, end_soc REAL,
         start_rated_range REAL, end_rated_range REAL,
         start_ideal_range REAL, end_ideal_range REAL,
         duration_min REAL, energy_used_kwh REAL, efficiency_wh_km REAL,
         avg_speed REAL, max_speed REAL, avg_power REAL, max_power REAL,
         start_outside_temp REAL, outside_temp_avg REAL, sample_count INTEGER
       )`,
    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_drives_vin_start ON drives (vin, start_ts)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_drives_open ON drives (vin, status)`),

    // --- vehicle_states: continuous state timeline ------------------------
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS vehicle_states (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         vin TEXT NOT NULL, state TEXT NOT NULL,
         start_ts INTEGER NOT NULL, end_ts INTEGER, source TEXT
       )`,
    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_states_vin_start ON vehicle_states (vin, start_ts)`),

    // --- charges: the charge curve ----------------------------------------
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS charges (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         session_id INTEGER NOT NULL, vin TEXT NOT NULL, ts INTEGER NOT NULL,
         soc REAL, charger_power REAL, charger_voltage REAL,
         charger_current REAL, charge_energy_added REAL,
         rated_range REAL, outside_temp REAL
       )`,
    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_charges_session ON charges (session_id, ts)`),

    // --- locations: named geofences for tagging + per-location stats ------
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS locations (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
         radius_m REAL NOT NULL DEFAULT 150, cost_per_kwh REAL, created_ts INTEGER
       )`,
    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_locations_name ON locations (name)`),
  ]);

  // charge_sessions predates the tracking build — widen it in place. D1 has no
  // "ADD COLUMN IF NOT EXISTS", so diff against the live table first.
  await addMissingColumns(env, "charge_sessions", {
    start_odometer: "REAL",
    start_rated_range: "REAL",
    end_rated_range: "REAL",
    start_ideal_range: "REAL",
    end_ideal_range: "REAL",
    duration_min: "REAL",
    max_charger_power: "REAL",
    charge_type: "TEXT",
    location_id: "INTEGER",
    outside_temp_avg: "REAL",
    status: "TEXT",
    // Backfill from Tesla's charging history (Supercharger sessions).
    external_id: "INTEGER", // Tesla sessionId — dedup key for re-runnable backfill
    site_name: "TEXT", // Supercharger site label (no lat/lon from that endpoint)
    currency: "TEXT",
    source: "TEXT", // 'derived' (live telemetry) | 'backfill' (Tesla history)
  });
  await env.DB.prepare(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_charge_sessions_ext ON charge_sessions (external_id) WHERE external_id IS NOT NULL`,
  ).run();

  // Reverse-geocode cache (~110 m grid) so drive endpoints get place names
  // without re-querying Nominatim for repeat locations.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS geocode_cache (
       lat_r REAL NOT NULL, lon_r REAL NOT NULL, label TEXT NOT NULL,
       created_ts INTEGER, PRIMARY KEY (lat_r, lon_r)
     )`,
  ).run();

  // Per-drive driver attribution + driving-behaviour metrics (insurance-style
  // scoring). Behaviour fields are derived from the drive's position samples
  // at close time; accuracy scales with polling cadence (see tracking.ts).
  await addMissingColumns(env, "drives", {
    start_address: "TEXT", // reverse-geocoded place label (geofence name wins if matched)
    end_address: "TEXT",
    driver: "TEXT", // assigned driver label (manual/assisted tagging)
    suggested_driver: "TEXT", // auto-suggested from geofence + time-of-day history
    max_accel_ms2: "REAL", // peak longitudinal acceleration, m/s^2
    max_decel_ms2: "REAL", // peak deceleration (braking), m/s^2 (positive magnitude)
    max_jerk_ms3: "REAL", // peak |Δaccel/Δt| — smoothness signal usable even at coarse cadence
    harsh_accel_count: "INTEGER",
    harsh_brake_count: "INTEGER",
    harsh_turn_count: "INTEGER", // heading-change spikes at speed
    over_limit_frac: "REAL", // fraction of samples above OVER_SPEED_KMH
    night_frac: "REAL", // fraction of duration in local night hours
    behavior_score: "REAL", // 0-100 composite (100 = safest)
  });

  // Small key/value app state in D1 (latest-state doc, poll state, stamps).
  // Lives here rather than KV because these are HOT-PATH writes (every poll):
  // Cloudflare's free tier caps KV at 1,000 writes/day but D1 at 100k/day —
  // burst polling at 10s would blow the KV cap in a single driving hour.
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS app_state (
       key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
     )`,
  ).run();

  // Forward-geocode cache (GovMap/Nominatim search results by normalized query).
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS fwd_geocode_cache (
       q_norm TEXT NOT NULL, lang TEXT NOT NULL, results TEXT NOT NULL,
       created_ts INTEGER NOT NULL, PRIMARY KEY (q_norm, lang)
     )`,
  ).run();

  schemaReady = true;
}

// ---------------------------------------------------------------------------
// app_state (D1 key/value) — hot-path state that must not burn KV writes
// ---------------------------------------------------------------------------

export async function getAppState(env: Env, key: string): Promise<string | null> {
  await ensureSchema(env);
  const row = await env.DB.prepare(`SELECT value FROM app_state WHERE key = ?1`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function putAppState(env: Env, key: string, value: string): Promise<void> {
  await ensureSchema(env);
  await env.DB.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, Math.floor(Date.now() / 1000))
    .run();
}

/** Adds any of `columns` not already present on `table` (nullable, no default). */
async function addMissingColumns(
  env: Env,
  table: string,
  columns: Record<string, string>,
): Promise<void> {
  let existing: Set<string>;
  try {
    const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    existing = new Set((info.results ?? []).map((r) => r.name));
  } catch (e) {
    console.error(`table_info(${table}) failed — skipping column migration:`, e instanceof Error ? e.message : e);
    return;
  }
  const missing = Object.entries(columns).filter(([name]) => !existing.has(name));
  for (const [name, type] of missing) {
    // One at a time: a failure on one column must not abort the rest.
    try {
      await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
    } catch (e) {
      console.error(`ALTER TABLE ${table} ADD COLUMN ${name} failed:`, e instanceof Error ? e.message : e);
    }
  }
}

// ---------------------------------------------------------------------------
// Latest state (D1 app_state, was KV)
//
// Moved out of KV because the doc is rewritten on EVERY ingest — at burst
// cadence that alone would exhaust the KV free tier's 1,000 writes/day. A
// one-time KV fallback read migrates the existing doc transparently.
// ---------------------------------------------------------------------------

const latestKey = (vin: string) => `latest:${vin}`;

export async function getLatest(env: Env, vin: string): Promise<LatestState | null> {
  const d1 = await getAppState(env, latestKey(vin));
  if (d1) {
    try {
      return JSON.parse(d1) as LatestState;
    } catch {
      /* fall through to KV */
    }
  }
  // Migration path: docs written by pre-D1 deployments still live in KV.
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
  await putAppState(env, latestKey(vin), JSON.stringify(current));
  return { previous, current };
}

// ---------------------------------------------------------------------------
// Generic telemetry event history (D1 EAV) — for arbitrary/unmapped fields
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
      const num =
        typeof e.value === "number" && Number.isFinite(e.value)
          ? e.value
          : typeof e.value === "boolean"
            ? e.value ? 1 : 0
            : null;
      const text = num === null ? stringifyValue(e.value) : null;
      return stmt.bind(vin, e.ts, e.field, num, text);
    }),
  );
}

/** Objects/arrays are JSON-encoded (not "[object Object]"); null/undefined drop to null. */
function stringifyValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return null;
    }
  }
  return String(v);
}

export interface SeriesPoint {
  ts: number;
  value: number | string | null;
}

/**
 * Time series for one field. Structured columns come from `positions`; anything
 * else falls back to the generic EAV store. `field` is a canonical name (soc,
 * odometer, rated_range, tpms_fl, ...).
 */
export async function querySeries(
  env: Env,
  vin: string,
  field: string,
  hours: number,
  limit = 5000,
): Promise<SeriesPoint[]> {
  await ensureSchema(env);
  const since = Math.floor(Date.now() / 1000) - Math.round(hours * 3600);

  if (POSITION_COLUMNS.has(field)) {
    const rs = await env.DB.prepare(
      `SELECT ts, ${field} AS value FROM positions
       WHERE vin = ?1 AND ts >= ?2 AND ${field} IS NOT NULL
       ORDER BY ts ASC LIMIT ?3`,
    )
      .bind(vin, since, limit)
      .all<{ ts: number; value: number | null }>();
    return (rs.results ?? []).map((r) => ({ ts: r.ts, value: r.value }));
  }

  const rs = await env.DB.prepare(
    `SELECT ts, value_num, value_text FROM telemetry_events
     WHERE vin = ?1 AND field = ?2 AND ts >= ?3 ORDER BY ts ASC LIMIT ?4`,
  )
    .bind(vin, field, since, limit)
    .all<{ ts: number; value_num: number | null; value_text: string | null }>();
  return (rs.results ?? []).map((r) => ({ ts: r.ts, value: r.value_num ?? r.value_text }));
}

/** Fields available for get_history — position columns plus any EAV fields seen. */
export async function listFields(env: Env, vin: string): Promise<string[]> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT DISTINCT field FROM telemetry_events WHERE vin = ?1 ORDER BY field`,
  )
    .bind(vin)
    .all<{ field: string }>();
  const eav = (rs.results ?? []).map((r) => r.field);
  return [...new Set([...POSITION_COLUMNS, ...eav])].sort();
}

// ---------------------------------------------------------------------------
// positions (structured per-ingest sample)
// ---------------------------------------------------------------------------

/** Canonical fields captured as position columns. */
export interface PositionSample {
  activity?: string | null;
  drive_id?: number | null;
  lat?: number | null;
  lon?: number | null;
  elevation?: number | null;
  heading?: number | null;
  speed?: number | null;
  power?: number | null;
  odometer?: number | null;
  soc?: number | null;
  usable_soc?: number | null;
  energy_remaining?: number | null;
  rated_range?: number | null;
  est_range?: number | null;
  ideal_range?: number | null;
  inside_temp?: number | null;
  outside_temp?: number | null;
  charging_state?: string | null;
  charger_power?: number | null;
  charger_voltage?: number | null;
  charger_current?: number | null;
  charge_energy_added?: number | null;
}

/** Inserts one positions row and returns its id (for drive tagging). */
export async function insertPosition(
  env: Env,
  vin: string,
  ts: number,
  s: PositionSample,
): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO positions (
       vin, ts, drive_id, activity, lat, lon, elevation, heading, speed, power,
       odometer, soc, usable_soc, energy_remaining, rated_range, est_range,
       ideal_range, inside_temp, outside_temp, charging_state, charger_power,
       charger_voltage, charger_current, charge_energy_added
     ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)`,
  )
    .bind(
      vin, ts, s.drive_id ?? null, s.activity ?? null,
      s.lat ?? null, s.lon ?? null, s.elevation ?? null, s.heading ?? null,
      s.speed ?? null, s.power ?? null, s.odometer ?? null,
      s.soc ?? null, s.usable_soc ?? null, s.energy_remaining ?? null,
      s.rated_range ?? null, s.est_range ?? null, s.ideal_range ?? null,
      s.inside_temp ?? null, s.outside_temp ?? null,
      s.charging_state ?? null, s.charger_power ?? null, s.charger_voltage ?? null,
      s.charger_current ?? null, s.charge_energy_added ?? null,
    )
    .run();
  return Number(res.meta.last_row_id ?? 0);
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

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * UTC offset in minutes for an IANA zone at a given instant — DST-aware, no
 * dependency (Workers ship full ICU). Returns null for an invalid zone.
 * E.g. tzOffsetMinutes("Asia/Jerusalem", ...) → 120 in winter, 180 in summer.
 */
export function tzOffsetMinutes(ianaZone: string, epochMs = Date.now()): number | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: ianaZone, timeZoneName: "shortOffset" });
    const part = fmt.formatToParts(epochMs).find((p) => p.type === "timeZoneName")?.value ?? "";
    // "GMT+3", "GMT-4:30", or plain "GMT" (UTC).
    const m = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(part);
    if (!m) return null;
    if (!m[1]) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    return null;
  }
}

/** Great-circle distance in metres between two lat/lon points. */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
