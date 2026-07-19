/**
 * Telemetry ingest: POST /ingest/telemetry
 *
 * Tesla's Fleet Telemetry cannot push directly to a Worker (vehicles speak
 * WebSocket + mTLS with Tesla-issued client certs to a fleet-telemetry
 * server you run). This endpoint is the Worker-side sink that any bridge can
 * POST to over plain HTTPS + bearer token:
 *   - the official fleet-telemetry server → kafka/zmq → tiny forwarder
 *   - a hosted telemetry provider's webhook (e.g. Teslemetry)
 *   - n8n/Make flows, or a manual push for testing
 *
 * Accepted payload shapes (auto-detected):
 *   1. Normalized:      {"vin":"...","ts":1730000000,"data":{"Soc":72,"Location":{"latitude":..,"longitude":..}}}
 *   2. fleet-telemetry: {"vin":"...","createdAt":"2025-..","data":[{"key":"Soc","value":{"stringValue":"72"}}]}
 *   3. Batch of either: {"events":[<shape 1 or 2>, ...]}
 *
 * Each ingest: canonical fields → KV latest-state, structured sample + derived
 * drive/charge/state boundaries (tracking.ts), arbitrary fields → EAV history,
 * then rule evaluation. This path is passive and never wakes the vehicle.
 */

import { recordSpend } from "./budget";
import { evaluateOnIngest } from "./rules";
import { getAppState, getLatest, LatestState, mergeLatest, POSITION_COLUMNS, putAppState, recordEvents, TelemetryEvent } from "./store";
import { applyDerivation } from "./tracking";
import { Env } from "./types";

/**
 * Maps fleet-telemetry Field names → canonical latest-state keys. Names verified
 * against teslamotors/fleet-telemetry protos/vehicle_data.proto (Field enum).
 * Unmapped fields fall back to their lowercased name.
 */
const FIELD_MAP: Record<string, string> = {
  Soc: "soc",
  BatteryLevel: "soc",
  UsableBatteryLevel: "usable_soc",
  EnergyRemaining: "energy_remaining",
  EstBatteryRange: "est_range",
  RatedRange: "rated_range",
  IdealBatteryRange: "ideal_range",
  Odometer: "odometer",
  VehicleSpeed: "speed",
  Location: "location",
  GpsHeading: "heading",
  Elevation: "elevation",
  Gear: "gear",
  ShiftState: "gear",
  Locked: "locked",
  SentryMode: "sentry",
  DetailedChargeState: "charging_state",
  ChargeState: "charging_state",
  ChargingState: "charging_state",
  ChargeAmps: "charger_current",
  ChargeCurrentRequest: "charge_current_request",
  ChargeCurrentRequestMax: "charge_current_request_max",
  ChargeLimitSoc: "charge_limit",
  ChargerVoltage: "charger_voltage",
  ACChargingPower: "ac_charging_power",
  DCChargingPower: "dc_charging_power",
  ACChargingEnergyIn: "ac_charge_energy_added",
  DCChargingEnergyIn: "dc_charge_energy_added",
  ChargeEnergyAdded: "charge_energy_added",
  SoftwareUpdateInstallationPercentComplete: "software_update_pct",
  SoftwareVersion: "software_version",
  Version: "software_version",
  InsideTemp: "inside_temp",
  OutsideTemp: "outside_temp",
  TpmsPressureFl: "tpms_fl",
  TpmsPressureFr: "tpms_fr",
  TpmsPressureRl: "tpms_rl",
  TpmsPressureRr: "tpms_rr",
  DoorState: "door_state",
  FdWindow: "window_fd",
  // --- Safety / driving-dynamics fields. Names verified against the official
  // Fleet Telemetry "Available Data" field list (2026). Real onboard IMU +
  // pedals give TRUE g-force & braking effort when streamed, so scoring.ts
  // prefers lon_accel/lat_accel over the Δv/Δt proxy. Units: accel m/s².
  LongitudinalAcceleration: "lon_accel", // m/s² (+ accel, − brake)
  LateralAcceleration: "lat_accel", // m/s² cornering
  BrakePedalPos: "brake_pedal", // master-cylinder pressure (braking effort)
  BrakePedal: "brake_pressed", // boolean pedal status
  PedalPosition: "accel_pedal", // accelerator position
  CruiseSetSpeed: "cruise_set_speed",
  CruiseFollowDistance: "follow_distance", // enum
  CurrentLimitMph: "car_speed_limit_mph", // limit the car itself detects
  LaneDepartureAvoidance: "lane_departure", // enum: assist level
  AutomaticEmergencyBrakingOff: "aeb_off", // boolean: AEB disabled (risk signal)
  ForwardCollisionWarning: "fcw_sensitivity",
  DriverSeatOccupied: "driver_present",
  DriverSeatBelt: "driver_seatbelt_unbuckled", // boolean — a real UBI risk factor
  LightsTurnSignal: "turn_signal", // signaling behaviour
  LightsHazardsActive: "hazards",
  DriveRail: "drive_rail",
  // --- Active-driver-profile fingerprint. Tesla exposes no active-driver name,
  // but these fields TRACK WITH the active profile, so they fingerprint who is
  // driving (like a seat-position memory would): the driver-side climate
  // setpoint and seat-heater habit differ per person, and LocatedAtHome/Work
  // are computed against the ACTIVE driver's own saved locations. tracking.ts
  // uses them as extra votes in driver auto-suggestion.
  HvacLeftTemperatureRequest: "cabin_temp_set",
  SeatHeaterLeft: "seat_heater_l",
  LocatedAtHome: "at_home",
  LocatedAtWork: "at_work",
  // --- Media/infotainment. Deliberately NOT added to POSITION_COLUMNS: these
  // are state changes, not per-sample telemetry, so they belong in the
  // generic EAV history (telemetry_events) — which getMediaStats (tracking.ts)
  // mines for "now playing" transitions to build a most-played leaderboard —
  // rather than bloating the highest-row-count table in the DB.
  MediaNowPlayingTitle: "media_title",
  MediaNowPlayingArtist: "media_artist",
  MediaNowPlayingAlbum: "media_album",
  MediaNowPlayingStation: "media_station",
  MediaPlaybackSource: "media_source",
  MediaPlaybackStatus: "media_status",
  MediaAudioVolume: "media_volume",
  MediaAudioVolumeIncrement: "media_volume_increment",
  MediaAudioVolumeMax: "media_volume_max",
  // Track length + playback position — powers the Now Playing progress bar.
  MediaNowPlayingDuration: "media_duration_ms",
  MediaNowPlayingElapsed: "media_elapsed_ms",

  // ---------------------------------------------------------------------
  // "Track everything (reasonable)" pass — verified against the full Fleet
  // Telemetry field list. Every one of these is EAV-only (never added to
  // POSITION_COLUMNS), so mapping them costs nothing until a field is
  // actually opted into streaming via configure_telemetry, and once
  // captured they're covered by the existing RETENTION_DAYS prune same as
  // any other telemetry_events row. No aggregation/UI built for most of
  // these yet — the point is to start the historical record now and decide
  // what to build on top of it later.
  //
  // 2026-07-11 policy update: NOTHING is excluded anymore — the owner asked
  // for every streamable field, so the previously-excluded groups (per-corner
  // Di* powertrain diagnostics, Semi/Cybertruck-only fields, RouteLastUpdated,
  // static configuration/display preferences) are now mapped at the end of
  // this object. Mapping them keeps their EAV keys stable snake_case instead
  // of the `field.toLowerCase()` fallback; wrong-vehicle-class fields simply
  // never emit, costing nothing.

  // --- Climate / comfort habits (also strengthens the driver-fingerprint
  // classifier in suggestDriverForDrive, the same idea as SeatHeaterLeft).
  AutoSeatClimateLeft: "auto_seat_climate_l",
  AutoSeatClimateRight: "auto_seat_climate_r",
  CabinOverheatProtectionMode: "cop_mode",
  CabinOverheatProtectionTemperatureLimit: "cop_temp_limit",
  ClimateKeeperMode: "climate_keeper_mode",
  ClimateSeatCoolingFrontLeft: "seat_cool_fl",
  ClimateSeatCoolingFrontRight: "seat_cool_fr",
  DefrostForPreconditioning: "defrost_precon",
  DefrostMode: "defrost_mode",
  HvacACEnabled: "hvac_ac_on",
  HvacAutoMode: "hvac_auto_mode",
  HvacFanSpeed: "hvac_fan_speed",
  HvacFanStatus: "hvac_fan_status",
  HvacPower: "hvac_power",
  HvacRightTemperatureRequest: "cabin_temp_set_r",
  HvacSteeringWheelHeatAuto: "steering_heat_auto",
  HvacSteeringWheelHeatLevel: "steering_heat_level",
  RearDefrostEnabled: "rear_defrost",
  RearDisplayHvacEnabled: "rear_display_hvac",
  SeatHeaterRearCenter: "seat_heater_rear_c",
  SeatHeaterRearLeft: "seat_heater_rear_l",
  SeatHeaterRearRight: "seat_heater_rear_r",
  SeatHeaterRight: "seat_heater_r",
  SeatVentEnabled: "seat_vent",
  WiperHeatEnabled: "wiper_heat",

  // --- Safety / ADAS feature adoption + FSD mileage.
  AutomaticBlindSpotCamera: "blind_spot_cam",
  BlindSpotCollisionWarningChime: "blind_spot_chime",
  EmergencyLaneDepartureAvoidance: "emerg_lane_keep",
  // Together these give "% of miles driven on FSD" once both are streamed.
  MilesSinceReset: "miles_since_reset",
  SelfDrivingMilesSinceReset: "fsd_miles_since_reset",
  // CSV notes this field is mislabeled on some platforms (reports the 2nd-row
  // center belt instead) — captured as-is, caveat preserved in the name.
  PassengerSeatBelt: "pass_seatbelt_unbuckled_unreliable",
  PinToDriveEnabled: "pin_to_drive",
  SpeedLimitWarning: "speed_limit_warning",

  // --- Battery pack diagnostics (beyond the simple degradation % already
  // derived) — brick/module imbalance is an early cell-health signal.
  BMSState: "bms_state",
  BatteryHeaterOn: "battery_heater_on",
  BmsFullchargecomplete: "bms_full_charge",
  BrickVoltageMax: "brick_v_max",
  BrickVoltageMin: "brick_v_min",
  NumBrickVoltageMax: "brick_v_max_num",
  NumBrickVoltageMin: "brick_v_min_num",
  ModuleTempMax: "module_temp_max",
  ModuleTempMin: "module_temp_min",
  NumModuleTempMax: "module_temp_max_num",
  NumModuleTempMin: "module_temp_min_num",
  NotEnoughPowerToHeat: "not_enough_power_to_heat",
  PackCurrent: "pack_current",
  PackVoltage: "pack_voltage",
  IsolationResistance: "isolation_resistance",

  // --- Charging behaviour/scheduling (beyond the session curve already tracked).
  ChargeEnableRequest: "charge_enable_req",
  ChargePortColdWeatherMode: "charge_port_cold",
  ChargePortDoorOpen: "charge_port_door_open",
  ChargePortLatch: "charge_port_latch",
  ChargeRateMilePerHour: "charge_rate_mph", // stays imperial (mi/h) — not a distance/speed field toMetric() converts
  ChargerPhases: "charger_phases",
  ChargingCableType: "charge_cable_type",
  EstimatedHoursToChargeTermination: "hours_to_charge_term",
  ExpectedEnergyPercentAtTripArrival: "trip_arrival_pct",
  FastChargerPresent: "fast_charger_present",
  FastChargerType: "fast_charger_type",
  PreconditioningEnabled: "preconditioning",
  ScheduledChargingMode: "sched_charge_mode",
  ScheduledChargingPending: "sched_charge_pending",
  ScheduledChargingStartTime: "sched_charge_start",
  SuperchargerSessionTripPlanner: "supercharger_trip_planner",
  TimeToFullCharge: "time_to_full_charge",

  // --- Navigation (active-route intent, distinct from where you actually
  // parked — a future "top destinations by nav intent" could pair with the
  // existing geofence-visit-based Suggested Places).
  DestinationLocation: "nav_destination_location",
  DestinationName: "nav_destination_name",
  OriginLocation: "nav_origin_location",
  MilesToArrival: "nav_miles_to_arrival",
  MinutesToArrival: "nav_minutes_to_arrival",
  RouteTrafficMinutesDelay: "nav_traffic_delay_min",
  // Google-polyline-encoded (base64) active route shape — captured raw;
  // decoding it into a drawable path is a future exercise, not done here.
  RouteLine: "nav_route_polyline",
  GpsState: "gps_lock",
  LocatedAtFavorite: "at_favorite", // pairs with the existing at_home/at_work fingerprint fields

  // --- Vehicle state / security & access (valet/guest mode, PIN, key count —
  // meaningful for a shared-household car, same theme as driver assignment).
  CenterDisplay: "center_display",
  FpWindow: "window_fp",
  RdWindow: "window_rd",
  RpWindow: "window_rp",
  GuestModeEnabled: "guest_mode",
  GuestModeMobileAccessState: "guest_mode_access",
  HomelinkDeviceCount: "homelink_count",
  HomelinkNearby: "homelink_nearby",
  LightsHighBeams: "high_beams",
  PairedPhoneKeyAndKeyFobQty: "paired_keys_count",
  RemoteStartEnabled: "remote_start",
  ServiceMode: "service_mode",
  SpeedLimitMode: "speed_limit_mode_on",
  ValetModeEnabled: "valet_mode",
  Hvil: "hvil_status", // high-voltage interlock — fault-relevant, unlike the excluded per-motor diagnostics

  // --- Tire pressure staleness/warnings (complements the existing TPMS pressure fields).
  TpmsHardWarnings: "tpms_hard_warning",
  TpmsSoftWarnings: "tpms_soft_warning",
  TpmsLastSeenPressureTimeFl: "tpms_seen_fl",
  TpmsLastSeenPressureTimeFr: "tpms_seen_fr",
  TpmsLastSeenPressureTimeRl: "tpms_seen_rl",
  TpmsLastSeenPressureTimeRr: "tpms_seen_rr",

  // --- Lifetime energy + software update history (closing gaps from the
  // first "track everything" pass — genuinely useful, just missed the first
  // time). LifetimeEnergyUsedDrive (its Semi-truck-only sibling) stays
  // excluded, same as the rest of the Semi-truck-only fields.
  LifetimeEnergyUsed: "lifetime_energy_used_kwh",
  SoftwareUpdateVersion: "software_update_version",
  SoftwareUpdateDownloadPercentComplete: "software_update_download_pct",
  SoftwareUpdateExpectedDurationMinutes: "software_update_duration_min",
  SoftwareUpdateScheduledStartTime: "software_update_scheduled_ts",

  // --- Per-corner powertrain diagnostics (Di*) — previously excluded; now captured because the user wants the complete record. EAV-only like everything else here.
  DCDCEnable: "dcdc_enable",
  DiAxleSpeedF: "di_axle_speed_f",
  DiAxleSpeedR: "di_axle_speed_r",
  DiAxleSpeedREL: "di_axle_speed_rel",
  DiAxleSpeedRER: "di_axle_speed_rer",
  DiHeatsinkTF: "di_heatsink_tf",
  DiHeatsinkTR: "di_heatsink_tr",
  DiHeatsinkTREL: "di_heatsink_trel",
  DiHeatsinkTRER: "di_heatsink_trer",
  DiInverterTF: "di_inverter_tf",
  DiInverterTR: "di_inverter_tr",
  DiInverterTREL: "di_inverter_trel",
  DiInverterTRER: "di_inverter_trer",
  DiMotorCurrentF: "di_motor_current_f",
  DiMotorCurrentR: "di_motor_current_r",
  DiMotorCurrentREL: "di_motor_current_rel",
  DiMotorCurrentRER: "di_motor_current_rer",
  DiSlaveTorqueCmd: "di_slave_torque_cmd",
  DiStateF: "di_state_f",
  DiStateR: "di_state_r",
  DiStateREL: "di_state_rel",
  DiStateRER: "di_state_rer",
  DiStatorTempF: "di_stator_temp_f",
  DiStatorTempR: "di_stator_temp_r",
  DiStatorTempREL: "di_stator_temp_rel",
  DiStatorTempRER: "di_stator_temp_rer",
  DiTorqueActualF: "di_torque_actual_f",
  DiTorqueActualR: "di_torque_actual_r",
  DiTorqueActualREL: "di_torque_actual_rel",
  DiTorqueActualRER: "di_torque_actual_rer",
  DiTorquemotor: "di_torquemotor",
  DiVBatF: "di_v_bat_f",
  DiVBatR: "di_v_bat_r",
  DiVBatREL: "di_v_bat_rel",
  DiVBatRER: "di_v_bat_rer",
  // --- Semi-truck-only fields — will never emit on this vehicle; mapped so nothing streamed is ever stored under a fallback key.
  LifetimeEnergyUsedDrive: "lifetime_energy_used_drive",
  SemitruckPassengerSeatFoldPosition: "semitruck_passenger_seat_fold_position",
  SemitruckTpmsPressureRe1L0: "semitruck_tpms_pressure_re_1_l_0",
  SemitruckTpmsPressureRe1L1: "semitruck_tpms_pressure_re_1_l_1",
  SemitruckTpmsPressureRe1R0: "semitruck_tpms_pressure_re_1_r_0",
  SemitruckTpmsPressureRe1R1: "semitruck_tpms_pressure_re_1_r_1",
  SemitruckTpmsPressureRe2L0: "semitruck_tpms_pressure_re_2_l_0",
  SemitruckTpmsPressureRe2L1: "semitruck_tpms_pressure_re_2_l_1",
  SemitruckTpmsPressureRe2R0: "semitruck_tpms_pressure_re_2_r_0",
  SemitruckTpmsPressureRe2R1: "semitruck_tpms_pressure_re_2_r_1",
  SemitruckTractorParkBrakeStatus: "semitruck_tractor_park_brake_status",
  SemitruckTrailerParkBrakeStatus: "semitruck_trailer_park_brake_status",
  // --- Cybertruck-only fields (tonneau + Powershare) — same rationale as the Semi fields.
  PowershareHoursLeft: "powershare_hours_left",
  PowershareInstantaneousPowerKW: "powershare_instantaneous_power_kw",
  PowershareStatus: "powershare_status",
  PowershareStopReason: "powershare_stop_reason",
  PowershareType: "powershare_type",
  TonneauOpenPercent: "tonneau_open_percent",
  TonneauPosition: "tonneau_position",
  TonneauTentMode: "tonneau_tent_mode",
  // --- Display-unit preferences + static vehicle configuration — near-constant, but they complete the record and document the car's spec in-band.
  CarType: "car_type",
  ChargePort: "charge_port",
  EfficiencyPackage: "efficiency_package",
  EuropeVehicle: "europe_vehicle",
  ExteriorColor: "exterior_color",
  OffroadLightbarPresent: "offroad_lightbar_present",
  RearSeatHeaters: "rear_seat_heaters",
  RightHandDrive: "right_hand_drive",
  RoofColor: "roof_color",
  Setting24HourTime: "setting_24_hour_time",
  SettingChargeUnit: "setting_charge_unit",
  SettingDistanceUnit: "setting_distance_unit",
  SettingTemperatureUnit: "setting_temperature_unit",
  SettingTirePressureUnit: "setting_tire_pressure_unit",
  SunroofInstalled: "sunroof_installed",
  Trim: "trim",
  VehicleName: "vehicle_name",
  WheelType: "wheel_type",
  // --- Remaining odds and ends.
  RouteLastUpdated: "route_last_updated",
};

/** Canonical fields that live only on `current` for derivation — never stored to EAV. */
const META_FIELDS = new Set([
  "charger_kind", "ac_charging_power", "dc_charging_power",
  "ac_charge_energy_added", "dc_charge_energy_added",
]);

const MI_TO_KM = 1.609344;
/**
 * Canonical fields the Tesla Fleet API reports in imperial units, on BOTH the
 * REST poll path and the telemetry stream, regardless of the car's region or
 * GUI setting (verified against Tesla's official Fleet Telemetry "Available
 * Data" docs + TeslaMate/Home-Assistant, 2026-07). Distances are miles, speed
 * is mph — same 1.609344 factor. Everything else (temps °C, TPMS bar, energy
 * kWh, power kW) is already metric and passes through untouched. Normalizing
 * here, before mergeLatest/derivation, means every downstream table, derived
 * stat, and `/data` route is uniformly metric.
 */
const MILES_FIELDS = new Set(["odometer", "speed", "est_range", "rated_range", "ideal_range"]);

function toMetric(canonical: string, value: unknown): unknown {
  if (MILES_FIELDS.has(canonical) && typeof value === "number" && Number.isFinite(value)) {
    return value * MI_TO_KM;
  }
  return value;
}

/** DetailedChargeState enum strings arrive prefixed, e.g. "DetailedChargeStateCharging". */
function normalizeChargingState(v: unknown): unknown {
  if (typeof v === "string" && v.startsWith("DetailedChargeState")) {
    return v.slice("DetailedChargeState".length);
  }
  return v;
}

/**
 * SentryMode arrives as either a plain boolean (REST `vehicle_state.sentry_mode`,
 * or the older Fleet Telemetry `BooleanValue` framing) or the richer
 * `SentryModeState` enum (prefixed string, e.g. "SentryModeStateAware") once a
 * vehicle's telemetry config streams it. Normalize both into one lowercase
 * vocabulary — "off" | "idle" | "armed" | "aware" | "panic" — so downstream
 * code (getSentryLog) can read either shape uniformly.
 */
function normalizeSentryState(v: unknown): unknown {
  if (typeof v === "boolean") return v ? "armed" : "off";
  if (typeof v === "string") {
    const stripped = v.startsWith("SentryModeState") ? v.slice("SentryModeState".length) : v;
    return stripped.toLowerCase();
  }
  return v;
}

function coerce(v: unknown): unknown {
  if (typeof v !== "string") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : v;
}

/**
 * Unwraps a fleet-telemetry Value. The proto has one field per type
 * (stringValue, intValue, doubleValue, booleanValue, locationValue, and enum
 * wrappers like detailedChargeStateValue / shiftStateValue / sentryModeStateValue),
 * so match generically on any single `*Value` key rather than a hardcoded list —
 * otherwise enum/sensor fields fall through and get stored as "[object Object]".
 * `{invalid:true}` markers carry no reading and are dropped.
 */
function unwrapFtValue(v: unknown): unknown {
  // Bare primitives go through coerce too: a bridge posting the array shape
  // with an unwrapped string value ({"key":"Odometer","value":"50000"}) must
  // yield a NUMBER, or toMetric()'s number-only guard skips the mi->km
  // conversion and the sample is stored as unconverted miles.
  if (v === null || typeof v !== "object") return coerce(v);
  const o = v as Record<string, unknown>;
  if (o.invalid === true) return undefined;
  if (o.locationValue && typeof o.locationValue === "object") return o.locationValue;
  for (const [k, inner] of Object.entries(o)) {
    if (k.endsWith("Value") && (inner === null || typeof inner !== "object")) {
      return coerce(inner);
    }
  }
  return v;
}

interface ParsedIngest {
  vin: string;
  ts: number;
  fields: Record<string, unknown>; // raw telemetry field name -> value
}

function parseOne(body: Record<string, unknown>): ParsedIngest | null {
  const vin = typeof body.vin === "string" ? body.vin : null;
  if (!vin) return null;
  let ts = Math.floor(Date.now() / 1000);
  if (typeof body.ts === "number") ts = Math.floor(body.ts > 1e12 ? body.ts / 1000 : body.ts);
  else if (typeof body.createdAt === "string") {
    const parsed = Date.parse(body.createdAt);
    if (!Number.isNaN(parsed)) ts = Math.floor(parsed / 1000);
  }

  const fields: Record<string, unknown> = {};
  if (Array.isArray(body.data)) {
    for (const item of body.data) {
      const { key, value } = (item ?? {}) as { key?: string; value?: unknown };
      if (!key) continue;
      const unwrapped = unwrapFtValue(value);
      if (unwrapped !== undefined) fields[key] = unwrapped;
    }
  } else if (body.data && typeof body.data === "object") {
    for (const [k, v] of Object.entries(body.data as Record<string, unknown>)) fields[k] = coerce(v);
  } else {
    return null;
  }
  return { vin, ts, fields };
}

/** Applies one parsed ingest: latest + structured sample + derivation + EAV + rules. */
export async function applyIngest(env: Env, parsed: ParsedIngest): Promise<LatestState> {
  const events: TelemetryEvent[] = [];
  const patch: Record<string, unknown> = {};

  for (const [field, rawValue] of Object.entries(parsed.fields)) {
    let value = rawValue;
    const canonical = FIELD_MAP[field] ?? field.toLowerCase();
    if (canonical === "charging_state") value = normalizeChargingState(value);
    if (canonical === "sentry") value = normalizeSentryState(value);
    value = toMetric(canonical, value);

    if (canonical === "location" && value && typeof value === "object") {
      const loc = value as { latitude?: number; longitude?: number };
      if (typeof loc.latitude === "number" && typeof loc.longitude === "number") {
        patch.lat = loc.latitude;
        patch.lon = loc.longitude;
      }
      continue;
    }

    patch[canonical] = value;
    // Companion timestamp so timelineState can tell a genuinely fresh
    // "installing" reading apart from mergeLatest's merge-forever carrying a
    // stale one indefinitely (Tesla never sends a terminal packet for this
    // field — see UPDATE_STALE_S in tracking.ts).
    if (canonical === "software_update_pct") patch.software_update_pct_ts = parsed.ts;
    // Companion timestamp for the same merge-forever problem: Tesla's Fleet
    // Telemetry stream has no equivalent of REST's drive_state.power (checked
    // against the full streaming field catalog — only per-corner Di* torque/
    // current diagnostics exist, no aggregate figure), so "power" can only
    // ever be set here via a billed REST poll. Since those are now throttled
    // to ~hourly whenever streaming is healthy (see poll.ts RECONCILE_BILLED_S),
    // buildSample() needs this to know how old the value is before trusting it
    // for a sample taken seconds ago.
    if (canonical === "power") patch.power_ts = parsed.ts;
    // EAV history holds only fields not captured as structured position columns.
    if (!POSITION_COLUMNS.has(canonical) && !META_FIELDS.has(canonical) && canonical !== "location") {
      events.push({ field: canonical, value, ts: parsed.ts });
    }
  }

  // Fold AC/DC charging power + energy into single canonical fields, tagging the
  // charge type so charge sessions record AC vs DC.
  resolveCharging(patch);
  derivePower(patch, parsed.ts);

  await recordEvents(env, parsed.vin, events);
  const { previous, current } = await mergeLatest(env, parsed.vin, patch, parsed.ts);
  await applyDerivation(env, parsed.vin, parsed.ts, previous, current);
  await evaluateOnIngest(env, parsed.vin, previous, current);
  return current;
}

/** Collapses ac_/dc_ charging fields into charger_power / charge_energy_added + charger_kind. */
function resolveCharging(patch: Record<string, unknown>): void {
  const asNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const ac = asNum(patch.ac_charging_power);
  const dc = asNum(patch.dc_charging_power);
  if (dc !== undefined && dc > 0) {
    patch.charger_power = dc;
    patch.charger_kind = "DC";
  } else if (ac !== undefined) {
    patch.charger_power = ac;
    patch.charger_kind = "AC";
  } else if (dc !== undefined) {
    patch.charger_power = dc;
  }
  const acE = asNum(patch.ac_charge_energy_added);
  const dcE = asNum(patch.dc_charge_energy_added);
  if (patch.charge_energy_added === undefined) {
    if (dcE !== undefined && (patch.charger_kind === "DC" || acE === undefined)) patch.charge_energy_added = dcE;
    else if (acE !== undefined) patch.charge_energy_added = acE;
  }
}

/**
 * Streamed motor power. Fleet Telemetry has no drive_state.power equivalent,
 * but PackVoltage × PackCurrent (both streamed each minute) IS the pack's
 * instantaneous power. Sign verified against live data 2026-07-19: pack
 * current is NEGATIVE on discharge (parked drain -0.6A, hard acceleration
 * -90A) and POSITIVE flowing in (AC charging +23A, regen +40..98A), so the
 * product is negated to match the REST drive_state.power convention
 * (positive = propulsion draw, negative = regen). This is battery-side power
 * (motor + ~1-2 kW aux), close enough to REST's figure — and unlike REST it
 * keeps flowing when billed polling is paused, which is what ended the
 * power-starvation bug family (#55/#56/#59) for good.
 *
 * Skipped while the same batch shows active charging: there the product is
 * the CHARGER's power flowing in, which already lives in charger_power, and
 * letting it land in "power" would smear large negative readings across a
 * charging session's samples. (A mid-charge batch that happens to carry
 * neither charging field can leak one such sample through — harmless, no
 * consumer reads positions.power during charges.) A REST-provided power in
 * the same batch wins: it's the true motor figure.
 */
function derivePower(patch: Record<string, unknown>, ts: number): void {
  const asNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  if (patch.power !== undefined) return;
  const v = asNum(patch.pack_voltage);
  const a = asNum(patch.pack_current);
  if (v === undefined || a === undefined) return;
  const chargerPower = asNum(patch.charger_power);
  const chargingState = typeof patch.charging_state === "string" ? patch.charging_state : "";
  if ((chargerPower !== undefined && chargerPower > 0) || chargingState === "Charging") return;
  patch.power = Math.round((-(v * a) / 1000) * 10) / 10;
  patch.power_ts = ts;
}

export async function handleIngest(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), { status: 400 });
  }

  const items: Record<string, unknown>[] = [];
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.events)) items.push(...(b.events as Record<string, unknown>[]));
  else if (Array.isArray(body)) items.push(...(body as Record<string, unknown>[]));
  else items.push(b);

  // Apply in timestamp order: the derivation state machine assumes monotonic
  // time, so an out-of-order batch would corrupt drive/charge/state boundaries.
  const parsed = items.map(parseOne).filter((x): x is NonNullable<typeof x> => x !== null);
  parsed.sort((a, b2) => a.ts - b2.ts);

  // Fleet Telemetry billing: each transmitted field is one billed signal
  // ($1/150k). Counted HERE (the streaming sink) — NOT in applyIngest, which
  // the REST poll path also calls and already bills as one vehicle_data read.
  // This lets the budget gates + pacing see streaming spend and throttle the
  // poller accordingly, so poll + stream together can't cross Tesla's line.
  const signals = parsed.reduce((n, p) => n + Object.keys(p.fields).length, 0);
  if (signals > 0) await recordSpend(env, "signal", signals);

  for (const p of parsed) await applyIngest(env, p);

  // Stream-liveness stamp (per vin, throttled to >=60s between writes):
  // pollOnce reads this to skip billed REST reads while streaming is
  // delivering (telemetry-first). Only the HTTP ingest route stamps it --
  // the REST poll path enters via applyVehicleData and must not count as
  // "streaming is alive".
  const nowS = Math.floor(Date.now() / 1000);
  for (const vinSeen of new Set(parsed.map((p) => p.vin))) {
    try {
      const prev = Number((await getAppState(env, `stream_ok_ts:${vinSeen}`)) ?? "0");
      if (nowS - prev >= 60) await putAppState(env, `stream_ok_ts:${vinSeen}`, String(nowS));
    } catch {
      /* liveness stamp must never break ingest */
    }
  }

  return new Response(JSON.stringify({ accepted: parsed.length, rejected: items.length - parsed.length }), {
    headers: { "content-type": "application/json" },
  });
}

/** Folds a REST vehicle_data response into the same store (poll path). */
export async function applyVehicleData(
  env: Env,
  vin: string,
  vd: Record<string, unknown>,
): Promise<LatestState> {
  const ts = Math.floor(Date.now() / 1000);
  const charge = (vd.charge_state ?? {}) as Record<string, unknown>;
  const climate = (vd.climate_state ?? {}) as Record<string, unknown>;
  const drive = (vd.drive_state ?? {}) as Record<string, unknown>;
  const vehicle = (vd.vehicle_state ?? {}) as Record<string, unknown>;

  const fields: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => {
    if (v !== undefined && v !== null) fields[k] = v;
  };
  put("Soc", charge.battery_level);
  put("UsableBatteryLevel", charge.usable_battery_level);
  put("EstBatteryRange", charge.est_battery_range);
  put("RatedRange", charge.battery_range);
  put("IdealBatteryRange", charge.ideal_battery_range);
  put("ChargingState", charge.charging_state);
  put("ChargeLimitSoc", charge.charge_limit_soc);
  put("ChargeAmps", charge.charger_actual_current);
  put("ChargerVoltage", charge.charger_voltage);
  put("ChargeEnergyAdded", charge.charge_energy_added);
  // charger_power is reported in kW; fast_charger_present distinguishes DC.
  if (charge.fast_charger_present === true) put("DCChargingPower", charge.charger_power);
  else put("ACChargingPower", charge.charger_power);
  put("InsideTemp", climate.inside_temp);
  put("OutsideTemp", climate.outside_temp);
  put("Odometer", vehicle.odometer);
  put("Locked", vehicle.locked);
  put("SentryMode", (vehicle.sentry_mode as boolean) ?? undefined);
  put("TpmsPressureFl", vehicle.tpms_pressure_fl);
  put("TpmsPressureFr", vehicle.tpms_pressure_fr);
  put("TpmsPressureRl", vehicle.tpms_pressure_rl);
  put("TpmsPressureRr", vehicle.tpms_pressure_rr);
  put("Gear", drive.shift_state);
  put("VehicleSpeed", drive.speed);
  put("GpsHeading", drive.heading);
  put("power", drive.power); // kW; drive_state.power maps 1:1 to the canonical field
  put("SoftwareVersion", vehicle.car_version); // e.g. "2026.20.3 abc123" — dashboard shows it
  if (typeof drive.latitude === "number" && typeof drive.longitude === "number") {
    fields.Location = { latitude: drive.latitude, longitude: drive.longitude };
  }
  return applyIngest(env, { vin, ts, fields });
}

// ---------------------------------------------------------------------------
// Telemetry field status — powers the dashboard's "Telemetry fields" screen
// ---------------------------------------------------------------------------

/**
 * Per-field live status for every Tesla field name this worker maps: the
 * canonical key it lands under, the latest merged value (null = never seen),
 * and when it was last recorded. The dashboard joins this against the vendored
 * fleet_streaming_fields.csv so the user can scroll every attribute Tesla can
 * stream and see what's actually coming in. EAV last-seen comes from one
 * indexed GROUP BY; position-column fields share the latest positions row's
 * timestamp (they're sampled together into that row).
 */
export async function getTelemetryFieldStatus(env: Env, vin: string): Promise<unknown> {
  const latest = ((await getLatest(env, vin)) ?? {}) as Record<string, unknown>;
  const rs = await env.DB.prepare(
    `SELECT field, MAX(ts) AS last_ts FROM telemetry_events WHERE vin = ?1 GROUP BY field`,
  )
    .bind(vin)
    .all<{ field: string; last_ts: number }>();
  const lastSeen = new Map((rs.results ?? []).map((r) => [r.field, r.last_ts]));
  const pos = await env.DB.prepare(`SELECT MAX(ts) AS last_ts FROM positions WHERE vin = ?1`)
    .bind(vin)
    .first<{ last_ts: number | null }>();

  const fields = Object.entries(FIELD_MAP).map(([tesla, canonical]) => {
    // Location is unwrapped into lat/lon before it reaches the latest doc.
    const value =
      canonical === "location"
        ? (latest.lat != null && latest.lon != null ? `${latest.lat}, ${latest.lon}` : null)
        : latest[canonical] === undefined ? null : latest[canonical];
    const seen =
      lastSeen.get(canonical) ??
      (POSITION_COLUMNS.has(canonical) || canonical === "location"
        ? (value != null ? pos?.last_ts ?? null : null)
        : null);
    return { tesla, canonical, value, last_seen: seen ?? null };
  });
  return { vin, fields };
}
