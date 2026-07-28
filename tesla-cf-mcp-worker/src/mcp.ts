/**
 * MCP server: JSON-RPC over streamable HTTP (POST /mcp), hand-rolled so the
 * Worker has no runtime dependencies. Works with Claude Code
 * (`claude mcp add --transport http tesla <origin>/mcp --header
 * "Authorization: Bearer <MCP_AUTH_TOKEN>"`) and claude.ai remote connectors
 * (via the OAuth shim in auth.ts).
 */

import { askDigitalTwin, askTessa } from "./ai";
import * as api from "./api";
import * as budget from "./budget";
import { findSimilarDrives } from "./twin";
import * as cmd from "./commands";
import * as forecast from "./forecast";
import * as rules from "./rules";
import * as store from "./store";
import * as telemetry from "./telemetry";
import * as tracking from "./tracking";
import { Env, TeslaError } from "./types";

export const SERVER_VERSION = "1.0.0";
const SERVER_INFO = { name: "tesla-cf-mcp-worker", title: "Tesla CF MCP Worker", version: SERVER_VERSION };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

type ToolHandler = (env: Env, args: Record<string, any>) => Promise<unknown>;

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

const vinProp = {
  vin: { type: "string", description: "Vehicle VIN (from list_vehicles)" },
} as const;

const vinSchema = {
  type: "object",
  properties: vinProp,
  required: ["vin"],
} as const;

/** Parses "Mon,Tue" / "All" into the ChargeSchedule days_of_week bitmask (bit 0 = Sunday). */
function parseDays(days: string): number {
  const bits: Record<string, number> = {
    sun: 1, mon: 2, tue: 4, wed: 8, thu: 16, fri: 32, sat: 64,
  };
  if (days.trim().toLowerCase() === "all") return 127;
  let mask = 0;
  for (const part of days.split(",")) {
    const bit = bits[part.trim().toLowerCase().slice(0, 3)];
    if (!bit) throw new TeslaError(`Unrecognized day "${part.trim()}" — use e.g. "Mon,Tue" or "All"`);
    mask |= bit;
  }
  return mask;
}

const commandResult = (r: { result: boolean; reason: string }) =>
  r.result ? { result: "ok" } : { result: "failed", reason: r.reason || "vehicle rejected the command" };

const TELEMETRY_NUDGE =
  "Cost note: this is a billed on-demand read (~$0.12/hr-equivalent when called repeatedly). " +
  "For recurring reads prefer Fleet Telemetry streaming (~18x cheaper) — see configure_telemetry.";

const TOOLS: Tool[] = [
  // ------------------------------------------------------------------ reads
  {
    name: "list_vehicles",
    description: "List vehicles on the Tesla account (VIN, name, connectivity state). Free, does not wake vehicles.",
    inputSchema: { type: "object", properties: {} },
    handler: (env) => api.listVehicles(env),
  },
  {
    name: "get_vehicle_data",
    description:
      "Full vehicle_data snapshot: state, charge, climate, location, odometer, tire pressure. " +
      "Fails (without waking) if the vehicle is asleep — call wake_vehicle explicitly only if the user needs live data. " +
      TELEMETRY_NUDGE,
    inputSchema: vinSchema,
    handler: (env, a) =>
      api.getVehicleData(env, a.vin, [
        "charge_state",
        "climate_state",
        "drive_state",
        "location_data",
        "vehicle_state",
        "vehicle_config",
      ]),
  },
  {
    name: "get_charge_state",
    description:
      "Charge state only (battery %, range, charging status, charge limit). Cheaper payload than get_vehicle_data. " +
      "Does not wake a sleeping vehicle. " + TELEMETRY_NUDGE,
    inputSchema: vinSchema,
    handler: (env, a) => api.getVehicleData(env, a.vin, ["charge_state"]),
  },
  {
    name: "get_climate_state",
    description:
      "Climate state only (cabin temp, HVAC status, preconditioning). Does not wake a sleeping vehicle. " +
      TELEMETRY_NUDGE,
    inputSchema: vinSchema,
    handler: (env, a) => api.getVehicleData(env, a.vin, ["climate_state"]),
  },
  {
    name: "get_location",
    description:
      "Vehicle location and heading (drive_state + location_data). Requires the vehicle_location scope. " +
      "Does not wake a sleeping vehicle. " + TELEMETRY_NUDGE,
    inputSchema: vinSchema,
    handler: (env, a) => api.getVehicleData(env, a.vin, ["drive_state", "location_data"]),
  },
  {
    name: "nearby_charging_sites",
    description: "Superchargers and destination chargers near the vehicle's current location.",
    inputSchema: {
      type: "object",
      properties: {
        ...vinProp,
        count: { type: "number", description: "Max sites to return" },
        radius: { type: "number", description: "Search radius in miles" },
        detail: { type: "boolean", description: "Include site metadata" },
      },
      required: ["vin"],
    },
    handler: (env, a) =>
      api.nearbyChargingSites(env, a.vin, { count: a.count, radius: a.radius, detail: a.detail }),
  },
  {
    name: "wake_vehicle",
    description:
      "Wake a sleeping vehicle. ONLY call when the user explicitly needs live data or a command on a sleeping car — " +
      "waking uses battery and this server intentionally never auto-wakes. Takes ~10-30s to come online.",
    inputSchema: vinSchema,
    handler: (env, a) => api.wakeVehicle(env, a.vin),
  },

  // --------------------------------------------------------------- commands
  {
    name: "lock",
    description: "Lock the vehicle doors (signed command).",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.lockDoors(env, a.vin)),
  },
  {
    name: "unlock",
    description: "Unlock the vehicle doors (signed command).",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.unlockDoors(env, a.vin)),
  },
  {
    name: "set_charge_limit",
    description: "Set the charge limit percentage (50-100).",
    inputSchema: {
      type: "object",
      properties: {
        ...vinProp,
        percent: { type: "number", minimum: 50, maximum: 100 },
      },
      required: ["vin", "percent"],
    },
    handler: async (env, a) => commandResult(await cmd.setChargeLimit(env, a.vin, Math.round(a.percent))),
  },
  {
    name: "start_charging",
    description: "Start charging (vehicle must be plugged in).",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.startCharging(env, a.vin)),
  },
  {
    name: "stop_charging",
    description: "Stop charging.",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.stopCharging(env, a.vin)),
  },
  {
    name: "climate_on",
    description: "Turn on climate control / start preconditioning the cabin.",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.climateOn(env, a.vin)),
  },
  {
    name: "climate_off",
    description: "Turn off climate control.",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.climateOff(env, a.vin)),
  },
  {
    name: "set_temperature",
    description: "Set cabin target temperature in °C (driver side; passenger defaults to the same).",
    inputSchema: {
      type: "object",
      properties: {
        ...vinProp,
        temp_celsius: { type: "number", minimum: 15, maximum: 28 },
        passenger_temp_celsius: { type: "number", minimum: 15, maximum: 28 },
      },
      required: ["vin", "temp_celsius"],
    },
    handler: async (env, a) =>
      commandResult(await cmd.setTemperature(env, a.vin, a.temp_celsius, a.passenger_temp_celsius)),
  },
  {
    name: "flash_lights",
    description: "Flash the headlights (vehicle must be in park).",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.flashLights(env, a.vin)),
  },
  {
    name: "honk_horn",
    description: "Honk the horn (vehicle must be in park).",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.honkHorn(env, a.vin)),
  },
  {
    name: "set_charging_amps",
    description: "Set the charging current in amps (e.g. for load-shifting or solar-surplus matching).",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, amps: { type: "number", minimum: 1, maximum: 48 } },
      required: ["vin", "amps"],
    },
    handler: async (env, a) => commandResult(await cmd.setChargingAmps(env, a.vin, Math.round(a.amps))),
  },
  {
    name: "set_sentry_mode",
    description: "Turn Sentry Mode on or off.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, on: { type: "boolean" } },
      required: ["vin", "on"],
    },
    handler: async (env, a) => commandResult(await cmd.setSentryMode(env, a.vin, a.on)),
  },
  {
    name: "navigate_to",
    description: "Send a destination (lat/lon) to the vehicle's navigation, replacing the current route.",
    inputSchema: {
      type: "object",
      properties: {
        ...vinProp,
        latitude: { type: "number" },
        longitude: { type: "number" },
      },
      required: ["vin", "latitude", "longitude"],
    },
    handler: async (env, a) => commandResult(await cmd.navigateToCoords(env, a.vin, a.latitude, a.longitude)),
  },
  {
    name: "open_charge_port",
    description: "Open the charge port door (also unlatches a plugged-in cable when not charging).",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.openChargePort(env, a.vin)),
  },
  {
    name: "close_charge_port",
    description: "Close the charge port door.",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.closeChargePort(env, a.vin)),
  },
  {
    name: "actuate_frunk",
    description: "Open the front trunk (frunk). Cannot be closed remotely.",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.actuateFrunk(env, a.vin)),
  },
  {
    name: "actuate_trunk",
    description: "Open/close the rear trunk (toggles on powered-liftgate vehicles).",
    inputSchema: vinSchema,
    handler: async (env, a) => commandResult(await cmd.actuateTrunk(env, a.vin)),
  },
  {
    name: "set_charging_schedule",
    description:
      "Add or update a charging schedule at a location. Times are minutes after midnight, vehicle-local. " +
      "Provide start_time and/or end_time. Pass id to update an existing schedule.",
    inputSchema: {
      type: "object",
      properties: {
        ...vinProp,
        days: { type: "string", description: '"All" or comma list, e.g. "Mon,Tue,Fri"' },
        enabled: { type: "boolean", default: true },
        start_time: { type: "number", description: "Charging window start, minutes after midnight" },
        end_time: { type: "number", description: "Charging window end, minutes after midnight" },
        latitude: { type: "number", description: "Schedule location latitude" },
        longitude: { type: "number", description: "Schedule location longitude" },
        one_time: { type: "boolean" },
        id: { type: "number", description: "Existing schedule id to update" },
        name: { type: "string" },
      },
      required: ["vin", "days", "latitude", "longitude"],
    },
    handler: async (env, a) => {
      if (a.start_time === undefined && a.end_time === undefined) {
        throw new TeslaError("Provide start_time and/or end_time (minutes after midnight)");
      }
      return commandResult(
        await cmd.addChargeSchedule(env, a.vin, {
          daysOfWeek: parseDays(a.days),
          enabled: a.enabled ?? true,
          startTime: a.start_time,
          endTime: a.end_time,
          latitude: a.latitude,
          longitude: a.longitude,
          oneTime: a.one_time,
          id: a.id,
          name: a.name,
        }),
      );
    },
  },
  {
    name: "remove_charging_schedule",
    description: "Remove a charging schedule by id.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, id: { type: "number" } },
      required: ["vin", "id"],
    },
    handler: async (env, a) => commandResult(await cmd.removeChargeSchedule(env, a.vin, a.id)),
  },
  {
    name: "set_precondition_schedule",
    description:
      "Add or update a cabin/battery preconditioning schedule (ready-by time is minutes after midnight, vehicle-local).",
    inputSchema: {
      type: "object",
      properties: {
        ...vinProp,
        days: { type: "string", description: '"All" or comma list, e.g. "Mon,Tue,Fri"' },
        enabled: { type: "boolean", default: true },
        precondition_time: { type: "number", description: "Ready-by time, minutes after midnight" },
        latitude: { type: "number" },
        longitude: { type: "number" },
        one_time: { type: "boolean" },
        id: { type: "number", description: "Existing schedule id to update" },
        name: { type: "string" },
      },
      required: ["vin", "days", "precondition_time", "latitude", "longitude"],
    },
    handler: async (env, a) =>
      commandResult(
        await cmd.addPreconditionSchedule(env, a.vin, {
          daysOfWeek: parseDays(a.days),
          enabled: a.enabled ?? true,
          preconditionTime: a.precondition_time,
          latitude: a.latitude,
          longitude: a.longitude,
          oneTime: a.one_time,
          id: a.id,
          name: a.name,
        }),
      ),
  },
  {
    name: "remove_precondition_schedule",
    description: "Remove a preconditioning schedule by id.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, id: { type: "number" } },
      required: ["vin", "id"],
    },
    handler: async (env, a) => commandResult(await cmd.removePreconditionSchedule(env, a.vin, a.id)),
  },

  // -------------------------------------------------------------- telemetry
  {
    name: "get_telemetry_config",
    description: "Show the Fleet Telemetry streaming config currently applied to a vehicle (if any).",
    inputSchema: vinSchema,
    handler: (env, a) => telemetry.getTelemetryConfig(env, a.vin),
  },
  {
    name: "configure_telemetry",
    description:
      "Register Fleet Telemetry streaming for one or more VINs — the preferred (18x cheaper) alternative to " +
      "repeated get_vehicle_data calls. Requires a reachable telemetry target server (hostname/ca) and the " +
      "virtual key paired to each vehicle. fields maps field names (e.g. Soc, Location, VehicleSpeed) to " +
      '{"interval_seconds": n}. Receiving/storing the stream is a v2 TODO — this only manages the vehicle-side config.',
    inputSchema: {
      type: "object",
      properties: {
        vins: { type: "array", items: { type: "string" } },
        hostname: { type: "string", description: "Telemetry target host (Tesla pushes over mTLS)" },
        port: { type: "number", default: 443 },
        ca: { type: "string", description: "PEM CA chain of the target server" },
        fields: {
          type: "object",
          description: 'e.g. {"Soc":{"interval_seconds":60},"Location":{"interval_seconds":120}}',
        },
        alert_types: { type: "array", items: { type: "string" } },
      },
      required: ["vins", "hostname", "fields"],
    },
    handler: (env, a) =>
      telemetry.createTelemetryConfig(env, {
        vins: a.vins,
        config: {
          hostname: a.hostname,
          port: a.port,
          ca: a.ca,
          fields: a.fields,
          alert_types: a.alert_types,
        },
      }),
  },
  {
    name: "delete_telemetry_config",
    description: "Remove the Fleet Telemetry streaming config from a vehicle.",
    inputSchema: vinSchema,
    handler: (env, a) => telemetry.deleteTelemetryConfig(env, a.vin),
  },

  // ------------------------------------------------- history & latest state
  {
    name: "get_latest_state",
    description:
      "Latest known vehicle state from the local store (telemetry ingest / last poll). Free and instant — " +
      "prefer this over get_vehicle_data when telemetry streaming is set up.",
    inputSchema: vinSchema,
    handler: async (env, a) => (await store.getLatest(env, a.vin)) ?? { vin: a.vin, note: "no data ingested yet" },
  },
  {
    name: "get_history",
    description:
      "Time series from the local history store (D1), e.g. field=soc for battery/degradation tracking, " +
      "field=odometer for mileage logs, field=lat/lon for trips. Use list_history_fields to see what's stored.",
    inputSchema: {
      type: "object",
      properties: {
        ...vinProp,
        field: { type: "string", description: "Canonical field, e.g. soc, odometer, outside_temp, tpms_fl" },
        hours: { type: "number", default: 24 },
      },
      required: ["vin", "field"],
    },
    handler: (env, a) => store.querySeries(env, a.vin, a.field, a.hours ?? 24),
  },
  {
    name: "list_history_fields",
    description: "List which fields have stored history for a vehicle.",
    inputSchema: vinSchema,
    handler: (env, a) => store.listFields(env, a.vin),
  },
  {
    name: "get_alert_log",
    description: "Recent automation/alert firings (including rule errors and skipped runs).",
    inputSchema: {
      type: "object",
      properties: { vin: { type: "string" }, limit: { type: "number", default: 50 } },
    },
    handler: (env, a) => store.listAlerts(env, a.vin, a.limit ?? 50),
  },

  // ------------------------------------------------- tracking (TeslaMate-grade)
  {
    name: "backfill_charge_history",
    description:
      "Import past Supercharger sessions from Tesla's charging-history API into the charge log " +
      "(idempotent — safe to re-run; dedups by Tesla session id). Backfills energy, cost, site and time " +
      "for Tesla-billed DC charging only (home AC charging isn't in Tesla's records, and no SoC/curve is " +
      "included). Populates the Charges and Charging-stats views instantly. Free — does not wake the vehicle.",
    inputSchema: vinSchema,
    handler: (env, a) => tracking.backfillChargeHistory(env, a.vin),
  },
  {
    name: "get_tracking_summary",
    description:
      "Roll-up for a vehicle: odometer, lifetime driven km & energy, avg efficiency, drive/charge counts, " +
      "total charge cost, current SoC, and self-calibrated usable pack kWh. Free — reads logged D1 data, never wakes.",
    inputSchema: vinSchema,
    handler: (env, a) => tracking.getTrackingSummary(env, a.vin),
  },
  {
    name: "get_drives",
    description:
      "Drive history (segmented from telemetry state transitions): start/end time & location, distance, duration, " +
      "energy used, efficiency (Wh/km), SoC & range delta, avg/max speed & power. Free — reads logged data.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, limit: { type: "number", default: 50 } },
      required: ["vin"],
    },
    handler: (env, a) => tracking.getDrives(env, a.vin, a.limit ?? 50),
  },
  {
    name: "get_drive",
    description: "One drive with its full GPS route/telemetry path (for map rendering). Pass the drive id from get_drives.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Drive id" } },
      required: ["id"],
    },
    handler: (env, a) => tracking.getDrive(env, a.id),
  },
  {
    name: "assign_drive_driver",
    description:
      "Attribute a drive to a named driver (for per-driver behaviour/risk scoring). Pass the drive id and a driver " +
      "name; pass an empty/blank name to clear. Tesla exposes no reliable native driver identity, so drives are " +
      "tagged manually here, then get_driver_scores aggregates by driver.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Drive id" },
        driver: { type: "string", description: "Driver name (blank to clear)" },
      },
      required: ["id", "driver"],
    },
    handler: (env, a) => tracking.setDriveDriver(env, a.id, a.driver),
  },
  {
    name: "get_driver_scores",
    description:
      "Insurance-style driving-behaviour roll-up per driver: distance, avg/max speed, harsh braking/acceleration/" +
      "cornering per 100 km, peak deceleration (m/s² and g), speeding %, night-driving %, and a 0-100 safety score " +
      "(100 = safest). Harsh-event metrics are derived from speed samples and need dense sampling (~10s) to be " +
      "reliable — the 'fidelity' field flags this per driver. Free — reads logged data.",
    inputSchema: vinSchema,
    handler: (env, a) => tracking.getDriverScores(env, a.vin),
  },
  {
    name: "get_charge_sessions",
    description:
      "Charge session log: start/end time & SoC, kWh added, AC/DC type, max power, duration, location, and cost " +
      "(from a per-location price or a price rule). Free — reads logged data.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, limit: { type: "number", default: 50 } },
      required: ["vin"],
    },
    handler: (env, a) => tracking.getChargeSessions(env, a.vin, a.limit ?? 50),
  },
  {
    name: "get_charge_curve",
    description: "The charge curve for one session (per-sample SoC, power, voltage, current, kWh added). Pass session_id from get_charge_sessions.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "number" } },
      required: ["session_id"],
    },
    handler: (env, a) => tracking.getChargeCurve(env, a.session_id),
  },
  {
    name: "get_battery_degradation",
    description:
      "Battery degradation over time, derived from completed charges: projected range at 100% and % loss since the " +
      "first record, plus the self-calibrated usable pack kWh. Free — reads logged data.",
    inputSchema: vinSchema,
    handler: (env, a) => tracking.getBatteryDegradation(env, a.vin),
  },
  {
    name: "get_pack_health",
    description:
      "Battery pack-health report: daily brick-voltage spread (mV, split at-rest vs under-load via same-timestamp " +
      "PackCurrent), module temperature spread, daily minimum isolation resistance, weak-brick detection (one brick " +
      "dominating the minimum — the earliest weak-cell signal), first-vs-last-week trends and a plain-language " +
      "verdict. Needs BrickVoltageMax/Min, NumBrickVoltageMax/Min, ModuleTempMax/Min, IsolationResistance and " +
      "PackVoltage/PackCurrent streamed via configure_telemetry; returns has_data:false with guidance until then. " +
      "Free — reads logged data.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, days: { type: "number", default: 30 } },
      required: ["vin"],
    },
    handler: (env, a) => tracking.getPackHealth(env, a.vin, a.days ?? 30),
  },
  {
    name: "get_vampire_drain",
    description:
      "Idle/vampire drain: SoC lost while parked, split ASLEEP vs AWAKE-IDLE (Sentry burns ~10x more than sleep), " +
      "with per-span detail and avg %/day. Free — reads logged data.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, days: { type: "number", default: 30 } },
      required: ["vin"],
    },
    handler: (env, a) => tracking.getVampireDrain(env, a.vin, a.days ?? 30),
  },
  {
    name: "get_monthly_report",
    description:
      "Monthly roll-up per calendar month (vehicle-local time): drives, distance, energy, avg Wh/km, charge " +
      "sessions, kWh (AC/DC split), cost, and cost per 100 km. Ideal for 'summarize my June driving'. " +
      "Free — reads logged data.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, months: { type: "number", default: 12 } },
      required: ["vin"],
    },
    handler: (env, a) => tracking.getMonthlyReport(env, a.vin, a.months ?? 12),
  },
  {
    name: "get_efficiency_by_temp",
    description:
      "Wh/km bucketed by 5°C ambient-temperature bins (distance-weighted) — the cold-weather range-penalty curve. " +
      "Free — reads logged data.",
    inputSchema: vinSchema,
    handler: (env, a) => tracking.getEfficiencyByTemp(env, a.vin),
  },
  {
    name: "get_media_stats",
    description:
      "Most-played tracks/artists/sources/stations over the trailing N days, from Fleet Telemetry's " +
      "MediaNowPlaying*/MediaPlaybackSource fields — a play is counted on each value change, not per sample, " +
      "so it's an honest play count rather than inflated by repeated polling. Requires those fields to have been " +
      "streamed via configure_telemetry; returns has_data:false with guidance if none has been recorded yet. " +
      "Free — reads logged data.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, days: { type: "number", default: 90 } },
      required: ["vin"],
    },
    handler: (env, a) => tracking.getMediaStats(env, a.vin, a.days ?? 90),
  },
  {
    name: "get_media_stats_by_driver",
    description:
      "Most-played tracks/artists/sources broken down per assigned driver (plays falling inside an unassigned " +
      "drive land in \"Unassigned\") — answers 'who listens to what'. Needs both media telemetry and drives " +
      "tagged with a driver. Free — reads logged data.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, days: { type: "number", default: 90 } },
      required: ["vin"],
    },
    handler: (env, a) => tracking.getMediaStatsByDriver(env, a.vin, a.days ?? 90),
  },
  {
    name: "get_charge_taper_curve",
    description:
      "Lifetime charging power-delivery curve: average/peak kW binned by 5% state-of-charge, across every " +
      "logged charge session — the taper profile your pack actually exhibits, not just one session's chart. " +
      "Free — reads logged data.",
    inputSchema: vinSchema,
    handler: (env, a) => tracking.getChargeTaperCurve(env, a.vin),
  },
  {
    name: "get_safety_feature_stats",
    description:
      "ADAS feature adoption: % of samples with automatic emergency braking disabled, blind-spot chime " +
      "activation count, and the most commonly selected lane-departure-avoidance / forward-collision-warning " +
      "settings. Needs those fields streamed via configure_telemetry. Free — reads logged data.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, days: { type: "number", default: 90 } },
      required: ["vin"],
    },
    handler: (env, a) => tracking.getSafetyFeatureStats(env, a.vin, a.days ?? 90),
  },
  {
    name: "get_climate_habits",
    description:
      "Climate/comfort habits: how often each side's seat climate runs on auto vs manual, average seat-heater/" +
      "seat-cooling level per side, and the left/right divergence — the same signal the driver auto-assignment " +
      "classifier already uses, surfaced as its own report. Free — reads logged data.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, days: { type: "number", default: 90 } },
      required: ["vin"],
    },
    handler: (env, a) => tracking.getClimateHabits(env, a.vin, a.days ?? 90),
  },
  {
    name: "get_sentry_log",
    description:
      "Sentry Mode event log: armed hours and, when the account streams the full SentryModeState enum " +
      "(Idle/Aware/Panic, not just on/off), actual trigger events (someone approaching, an impact) with " +
      "location — flags enum_available so you know whether trigger detection is even possible on this account. " +
      "Free — reads logged data.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, days: { type: "number", default: 30 } },
      required: ["vin"],
    },
    handler: (env, a) => tracking.getSentryLog(env, a.vin, a.days ?? 30),
  },
  {
    name: "get_tire_pressures",
    description:
      "Per-wheel TPMS history (bar): latest reading, time series, and a bar/week trend that catches slow leaks " +
      "weeks before the car warns. Free — reads logged data.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, days: { type: "number", default: 30 } },
      required: ["vin"],
    },
    handler: (env, a) => tracking.getTirePressures(env, a.vin, a.days ?? 30),
  },
  {
    name: "get_suggested_locations",
    description:
      "Repeat-visited spots (≥3 drive endpoints) not yet inside a named location, with reverse-geocoded labels — " +
      "candidates for set_location. Free — reads logged data.",
    inputSchema: vinSchema,
    handler: (env, a) => tracking.getSuggestedLocations(env, a.vin),
  },
  {
    name: "list_drivers",
    description:
      "Household driver roster: the people the car is SHARED with (from Tesla's drivers endpoint, by name + " +
      "paired-key count) merged with anyone already tagged on drives. NOTE: Tesla exposes no active-driver-per-trip " +
      "field, so this seeds manual/assisted tagging — it does not auto-attribute trips. Free.",
    inputSchema: vinSchema,
    handler: (env, a) => tracking.getDrivers(env, a.vin),
  },
  {
    name: "get_battery_forecast",
    description:
      "Forward projection of battery degradation + mileage against the 8-year / distance / 70%-retention warranty: " +
      "current health %, %/year slope with r², km/year, and which warranty cap binds first and when. Free — reads logged data.",
    inputSchema: vinSchema,
    handler: (env, a) => forecast.getBatteryForecast(env, a.vin),
  },
  {
    name: "get_predicted_range",
    description:
      "Predicts a trip's efficiency (Wh/km), energy (kWh) and SoC used from a model fitted on the car's own logged " +
      "drives (efficiency vs ambient temp, speed, driver). Pass distance_km, temp_c, optional driver + elevation_gain_m. " +
      "Free — reads logged data.",
    inputSchema: {
      type: "object",
      properties: {
        ...vinProp,
        distance_km: { type: "number" },
        temp_c: { type: "number" },
        driver: { type: "string" },
        elevation_gain_m: { type: "number" },
      },
      required: ["vin"],
    },
    handler: (env, a) =>
      forecast.predictRange(env, a.vin, {
        distance_km: a.distance_km, temp_c: a.temp_c, driver: a.driver, elevation_gain_m: a.elevation_gain_m,
      }),
  },
  {
    name: "get_drive_certificate",
    description:
      "Tamper-evident HMAC-SHA256 risk certificate for one drive: the canonical metrics + a hash of the GPS path, " +
      "signed with a server secret so the data can't be altered after the fact without breaking the signature. " +
      "Pass the drive id. Free.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Drive id" } },
      required: ["id"],
    },
    handler: (env, a) => tracking.getDriveCertificate(env, a.id, Math.floor(Date.now() / 1000)),
  },
  {
    name: "ask_tessa",
    description:
      "Ask a natural-language question about THIS car's data ('how efficient was I this month?', 'is my battery " +
      "healthy?', 'who drives most safely?', or a trip you're planning). Grounded in the logged data via Cloudflare " +
      "Workers AI; trip questions are answered by the Digital Twin from similar past drives. Free.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, question: { type: "string" } },
      required: ["vin", "question"],
    },
    handler: (env, a) => askTessa(env, a.question, a.vin),
  },
  {
    name: "get_similar_drives",
    description:
      "Digital Twin: the k most similar REAL past drives to a candidate trip (by distance, ambient temp, driver, " +
      "day/night), with each match's actual efficiency/energy/SoC-used and a similarity-weighted prediction. The " +
      "interpretable, evidence-based complement to get_predicted_range. Free — reads logged data.",
    inputSchema: {
      type: "object",
      properties: {
        ...vinProp,
        distance_km: { type: "number" },
        temp_c: { type: "number" },
        driver: { type: "string" },
        night: { type: "boolean" },
        k: { type: "number", default: 5 },
      },
      required: ["vin"],
    },
    handler: (env, a) =>
      findSimilarDrives(env, a.vin, { distance_km: a.distance_km, temp_c: a.temp_c, driver: a.driver, night: a.night }, a.k ?? 5),
  },
  {
    name: "ask_digital_twin",
    description:
      "Predict a trip in plain language from your OWN nearest historical drives ('driving to Eilat this weekend " +
      "with the kids and AC on — what range should I expect?'). Extracts the trip's features, finds the most " +
      "similar real drives, and answers with provenance. Free.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, description: { type: "string" } },
      required: ["vin", "description"],
    },
    handler: (env, a) => askDigitalTwin(env, a.vin, a.description),
  },
  {
    name: "get_state_timeline",
    description:
      "Continuous state timeline (driving | charging | online | asleep | offline | updating) with durations. " +
      "Free — reads logged data.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, hours: { type: "number", default: 168 } },
      required: ["vin"],
    },
    handler: (env, a) => tracking.getStateTimeline(env, a.vin, a.hours ?? 168),
  },
  {
    name: "get_battery_timeline",
    description:
      "SoC over time with a driving/charging/resting/connected-not-charging stage per point, plus per-stage " +
      "segments and total hours — the data behind a stock-chart-style battery timeline. Finer-grained than " +
      "get_state_timeline: splits idle into unplugged (resting) vs plugged-in-but-not-charging (connected), " +
      "e.g. sitting at 80% after a charge limit stop. Free — reads logged data.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp, hours: { type: "number", default: 24 } },
      required: ["vin"],
    },
    handler: (env, a) => tracking.getBatteryTimeline(env, a.vin, a.hours ?? 24),
  },
  {
    name: "get_software_updates",
    description:
      "Current software version, any OTA update in flight (installing/scheduled/available, with progress), " +
      "and the version-change log — when each firmware release was first seen on this car. Free — reads logged data.",
    inputSchema: {
      type: "object",
      properties: { ...vinProp },
      required: ["vin"],
    },
    handler: (env, a) => tracking.getSoftwareUpdates(env, a.vin),
  },
  {
    name: "get_api_call_log",
    description:
      "Tesla Fleet API spend breakdown by day and call kind (vehicle data reads, commands, wakes, telemetry " +
      "signals) over the trailing `days` — what the running spend total shown elsewhere is actually made of. " +
      "Account-wide, not per-vehicle. Free — reads logged accounting data.",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number", default: 30 } },
    },
    handler: (env, a) => budget.getBudgetCallLog(env, a.days ?? 30),
  },
  {
    name: "list_locations",
    description: "List named locations (geofences used to tag drives & charges and to price charging per site).",
    inputSchema: { type: "object", properties: {} },
    handler: (env) => tracking.listLocations(env),
  },
  {
    name: "set_location",
    description:
      "Create or update a named location (omit id to create). radius_m defaults to 150; cost_per_kwh (optional) " +
      "prices charge sessions that start inside it. Drives and charges are tagged with the nearest containing location. " +
      "drivers (optional) tags which household driver(s) this place belongs to (e.g. \"Home\" tagged to everyone, " +
      "\"Work\" tagged to just one) — omit on an update to leave existing tags untouched, pass [] to clear them.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Existing location id to update" },
        name: { type: "string" },
        latitude: { type: "number" },
        longitude: { type: "number" },
        radius_m: { type: "number", default: 150 },
        cost_per_kwh: { type: "number", description: "Price per kWh at this location (same currency as reports)" },
        drivers: { type: "array", items: { type: "string" }, description: "Driver name(s) this location applies to; omit to leave as-is on update" },
        address: { type: "string", description: "Human-readable address; omit to keep, empty string to clear (it re-geocodes lazily)" },
      },
      required: ["name", "latitude", "longitude"],
    },
    handler: (env, a) =>
      tracking.setLocation(env, {
        id: a.id,
        name: a.name,
        lat: a.latitude,
        lon: a.longitude,
        radius_m: a.radius_m,
        cost_per_kwh: a.cost_per_kwh,
        drivers: a.drivers,
        address: a.address,
      }),
  },
  {
    name: "delete_location",
    description: "Delete a named location by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
    handler: (env, a) => tracking.deleteLocation(env, a.id),
  },
  {
    name: "get_location_stats",
    description: "Per-location stats: drives from/to here, charge sessions, total kWh and cost. Pass the location id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
    handler: (env, a) => tracking.getLocationStats(env, a.id),
  },
  {
    name: "get_location_history",
    description:
      "Everything that happened AT a saved place, newest first: arrivals (drives ending there), " +
      "departures (drives starting there) and charge sessions, each with its drive/charge id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" }, limit: { type: "number", default: 200 } },
      required: ["id"],
    },
    handler: (env, a) => tracking.getLocationHistory(env, a.id, a.limit ?? 200),
  },

  // ------------------------------------------------------------ automations
  {
    name: "list_automations",
    description: "List configured automation rules (price/solar charging, geofences, alerts, schedules).",
    inputSchema: { type: "object", properties: {} },
    handler: (env) => rules.getAutomations(env),
  },
  {
    name: "set_automation",
    description:
      "Create or update an automation rule (upsert by id; omit id to create). `rule` is the full JSON rule " +
      "document. Types: price_charging (feed, cheap_below_cents, amps_cheap, limit_cheap, expensive_above_cents), " +
      "solar_surplus (source, start_above_w, stop_below_w, volts, phases, min/max_amps, at{lat,lon,radius_m}), " +
      "scheduled_precondition (time, days, tz_offset_minutes, conditions{outside_temp_below_c, soc_above}, temp_celsius), " +
      "geofence (lat, lon, radius_m, on_enter[], on_exit[] of {command,args}), " +
      "alert (when: door_unlocked_while_away|soc_below|tire_pressure_drop|charging_started|charging_stopped|unexpected_wake, " +
      "notify[] webhook URLs). Common fields: vin, enabled, notify, allow_poll, cooldown_minutes. " +
      "Automations can never unlock or open trunks, and never wake a sleeping vehicle. See README for examples.",
    inputSchema: {
      type: "object",
      properties: { rule: { type: "object", description: "Full automation rule JSON" } },
      required: ["rule"],
    },
    handler: async (env, a) => {
      const rule = a.rule as rules.AutomationRule;
      if (!rule.type || !rule.vin) throw new TeslaError("rule.type and rule.vin are required");
      return rules.saveAutomation(env, rule);
    },
  },
  {
    name: "delete_automation",
    description: "Delete an automation rule by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    handler: async (env, a) => ({ deleted: await rules.deleteAutomation(env, a.id) }),
  },
  {
    name: "run_automations_now",
    description: "Run one automation-engine tick immediately (same as the 15-min cron) — useful for testing rules.",
    inputSchema: { type: "object", properties: {} },
    handler: (env) => rules.runCronTick(env),
  },
];

// ---------------------------------------------------------------------------
// Read-scope tool allowlist — enforced SERVER-SIDE at dispatch. A leaked
// dashboard/viewer token can therefore never unlock, honk, wake, or touch the
// car: "read-only" is a property of the server, not of whichever client
// happens to be polite.
//
// It also can't SPEND: the billed live-read tools (get_vehicle_data /
// get_charge_state / get_climate_state / get_location — all route to
// api.getVehicleData → recordSpend) are deliberately EXCLUDED, so a leaked
// read token can't burn the monthly Tesla budget. Read scope sees only free,
// already-logged data (get_latest_state + the D1-backed derivations). The
// full token retains live reads. nearby_charging_sites and get_telemetry_config
// are free (no recordSpend) so they stay.
// ---------------------------------------------------------------------------

const READ_TOOLS = new Set([
  "list_vehicles",
  "nearby_charging_sites",
  "get_telemetry_config",
  "get_latest_state",
  "get_history",
  "list_history_fields",
  "get_alert_log",
  "get_tracking_summary",
  "get_drives",
  "get_drive",
  "get_driver_scores",
  "get_charge_sessions",
  "get_charge_curve",
  "get_battery_degradation",
  "get_pack_health",
  "get_vampire_drain",
  "get_sentry_log",
  "get_state_timeline",
  "get_battery_timeline",
  "get_software_updates",
  "get_monthly_report",
  "get_efficiency_by_temp",
  "get_media_stats",
  "get_media_stats_by_driver",
  "get_charge_taper_curve",
  "get_safety_feature_stats",
  "get_climate_habits",
  "get_tire_pressures",
  "get_suggested_locations",
  "list_drivers",
  "get_battery_forecast",
  "get_predicted_range",
  "get_drive_certificate",
  "ask_tessa",
  "get_similar_drives",
  "ask_digital_twin",
  "list_locations",
  "get_api_call_log",
  "get_location_stats",
  "get_location_history",
  "list_automations",
]);

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: any;
}

type JsonRpcResponse = { jsonrpc: "2.0"; id: number | string | null } & (
  | { result: unknown }
  | { error: { code: number; message: string } }
);

export type McpScope = "full" | "read";

async function dispatch(env: Env, msg: JsonRpcRequest, scope: McpScope): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  // Notifications get no response.
  if (msg.method.startsWith("notifications/")) return null;

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion as string | undefined;
      return reply({
        protocolVersion: requested && SUPPORTED_PROTOCOLS.includes(requested) ? requested : "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case "ping":
      return reply({});
    case "tools/list": {
      const visible = scope === "read" ? TOOLS.filter((t) => READ_TOOLS.has(t.name)) : TOOLS;
      return reply({
        tools: visible.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    }
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${msg.params?.name}`);
      if (scope === "read" && !READ_TOOLS.has(tool.name)) {
        return reply({
          content: [{
            type: "text",
            text: `Error: this token is READ-ONLY — "${tool.name}" requires the full-access token. ` +
              "Read tokens can view data but never send commands, wake the car, or change configuration.",
          }],
          isError: true,
        });
      }
      try {
        const result = await tool.handler(env, msg.params?.arguments ?? {});
        return reply({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (e) {
        const message =
          e instanceof TeslaError
            ? e.message + (e.detail ? `\n\ndetail: ${typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)}` : "")
            : e instanceof Error
              ? e.message
              : String(e);
        return reply({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(request: Request, env: Env, scope: McpScope = "full"): Promise<Response> {
  if (request.method === "GET") {
    // No server-initiated stream support; streamable-HTTP clients fall back to POST.
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const messages = (Array.isArray(body) ? body : [body]) as JsonRpcRequest[];
  const responses = (await Promise.all(messages.map((m) => dispatch(env, m, scope)))).filter(
    (r): r is JsonRpcResponse => r !== null,
  );

  if (responses.length === 0) return new Response(null, { status: 202 });
  const payload = Array.isArray(body) ? responses : responses[0];
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}
