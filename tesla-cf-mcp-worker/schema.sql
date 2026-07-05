-- Tesla CF MCP Worker — full D1 schema (reference).
--
-- You do NOT normally run this by hand: src/store.ts:ensureSchema() applies the
-- equivalent CREATE TABLE IF NOT EXISTS + guarded ALTER TABLE on first use, so a
-- fresh deploy self-provisions and an existing DB is migrated in place. This
-- file is the human-readable source of truth for the schema, and can be applied
-- manually if you prefer:
--
--   wrangler d1 execute tesla-cf-mcp-worker --file=schema.sql          # local
--   wrangler d1 execute tesla-cf-mcp-worker --remote --file=schema.sql # deployed
--
-- SQLite/D1. All timestamps are unix seconds. All distances km, temps °C,
-- power kW, energy kWh, voltage V, current A unless noted.

-- ── generic EAV history (arbitrary/unmapped fields; powers get_history) ──
CREATE TABLE IF NOT EXISTS telemetry_events (
  vin TEXT NOT NULL, ts INTEGER NOT NULL, field TEXT NOT NULL,
  value_num REAL, value_text TEXT,
  PRIMARY KEY (vin, field, ts)
);
CREATE INDEX IF NOT EXISTS idx_events_vin_ts ON telemetry_events (vin, ts);

-- ── positions: one structured sample per ingest (the tracking backbone) ──
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vin TEXT NOT NULL, ts INTEGER NOT NULL,
  drive_id INTEGER, activity TEXT,               -- driving | charging | idle
  lat REAL, lon REAL, elevation REAL, heading REAL,
  speed REAL, power REAL, odometer REAL,
  soc REAL, usable_soc REAL, energy_remaining REAL,
  rated_range REAL, est_range REAL, ideal_range REAL,
  inside_temp REAL, outside_temp REAL,
  charging_state TEXT, charger_power REAL, charger_voltage REAL,
  charger_current REAL, charge_energy_added REAL
);
CREATE INDEX IF NOT EXISTS idx_positions_vin_ts ON positions (vin, ts);
CREATE INDEX IF NOT EXISTS idx_positions_drive ON positions (drive_id);

-- ── drives: segmented from shift/speed transitions ──────────────────────
CREATE TABLE IF NOT EXISTS drives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vin TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER,
  status TEXT NOT NULL DEFAULT 'active',          -- active | complete
  start_lat REAL, start_lon REAL, end_lat REAL, end_lon REAL,
  start_location_id INTEGER, end_location_id INTEGER,
  start_odometer REAL, end_odometer REAL, distance_km REAL,
  start_soc REAL, end_soc REAL,
  start_rated_range REAL, end_rated_range REAL,
  start_ideal_range REAL, end_ideal_range REAL,
  duration_min REAL, energy_used_kwh REAL, efficiency_wh_km REAL,
  avg_speed REAL, max_speed REAL, avg_power REAL, max_power REAL,
  start_outside_temp REAL, outside_temp_avg REAL, sample_count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_drives_vin_start ON drives (vin, start_ts);
CREATE INDEX IF NOT EXISTS idx_drives_open ON drives (vin, status);

-- ── charge_sessions: segmented from charging_state transitions ──────────
-- (older deploys created this without the trailing columns; ensureSchema adds
--  them via ALTER TABLE. Fresh installs get the full shape below.)
CREATE TABLE IF NOT EXISTS charge_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vin TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER,
  start_soc REAL, end_soc REAL, energy_added_kwh REAL,
  lat REAL, lon REAL, cost REAL, price_cents_kwh REAL,
  start_odometer REAL, start_rated_range REAL, end_rated_range REAL,
  start_ideal_range REAL, end_ideal_range REAL, duration_min REAL,
  max_charger_power REAL, charge_type TEXT,       -- AC | DC
  location_id INTEGER, outside_temp_avg REAL,
  status TEXT                                     -- active | complete
);

-- ── charges: the charge curve (per-sample within a session) ─────────────
CREATE TABLE IF NOT EXISTS charges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL, vin TEXT NOT NULL, ts INTEGER NOT NULL,
  soc REAL, charger_power REAL, charger_voltage REAL,
  charger_current REAL, charge_energy_added REAL,
  rated_range REAL, outside_temp REAL
);
CREATE INDEX IF NOT EXISTS idx_charges_session ON charges (session_id, ts);

-- ── vehicle_states: continuous state timeline ───────────────────────────
CREATE TABLE IF NOT EXISTS vehicle_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vin TEXT NOT NULL, state TEXT NOT NULL,         -- driving|charging|online|asleep|offline|updating
  start_ts INTEGER NOT NULL, end_ts INTEGER, source TEXT
);
CREATE INDEX IF NOT EXISTS idx_states_vin_start ON vehicle_states (vin, start_ts);

-- ── locations: named geofences for tagging + per-location stats ─────────
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
  radius_m REAL NOT NULL DEFAULT 150, cost_per_kwh REAL, created_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_locations_name ON locations (name);

-- ── alert_log: automation firings + rule errors ─────────────────────────
CREATE TABLE IF NOT EXISTS alert_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, vin TEXT, rule_id TEXT, kind TEXT,
  message TEXT, payload TEXT, delivered INTEGER DEFAULT 0
);

-- Degradation and vampire drain are DERIVED by query (tracking.ts) over
-- charge_sessions / positions — no dedicated tables, so they stay always-fresh.
