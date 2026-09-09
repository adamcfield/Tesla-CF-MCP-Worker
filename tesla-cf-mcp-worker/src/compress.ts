/**
 * Per-field telemetry compression: the rule registry and the pure algorithms.
 *
 * WHY THIS EXISTS. `telemetry_events` is EAV — one row per field per sample.
 * The car streams 182 fields, 177 of them at cadences that keep firing while
 * parked, so a car that mostly sits still writes ~69,000 rows a day. That table
 * is now big enough that one scan of it spends D1's entire free-tier budget of
 * 5,000,000 rows read per day, which takes the whole database offline until the
 * next UTC midnight.
 *
 * Most of those rows carry no information. The doors stay locked from the
 * evening until the morning; SoC ramps 50 -> 80 during a charge and then
 * oscillates 80/79/80 all night. The goal is to keep only the points needed to
 * reconstruct each signal to a stated tolerance.
 *
 * WHAT DOESN'T WORK, and why the tolerance matters. Fleet Telemetry only sends
 * a field when it CHANGES (see tracking.ts's field-merge notes), so the store is
 * already change-driven and plain "drop the repeated value" dedup recovers
 * almost nothing. The 69k rows/day exist because analog signals never repeat
 * EXACTLY: brick voltages, module temps, pack current, tyre pressures and cabin
 * temps all wiggle in the last decimal on every sample, so "changed" is true
 * every single time. The entire win therefore comes from the tolerance band,
 * not from deduplication.
 *
 * THE ALGORITHM is Swinging Door Trending, the standard used by process
 * historians. Hold the last archived point A and track the narrowing cone of
 * slopes leaving A that stays within +/-epsilon of every point seen since. When
 * the cone inverts, no straight line from A can represent the run, so the
 * previous point is archived and the cone restarts.
 *
 * On its own that bounds the error at 2*epsilon, not epsilon — see
 * enforceEpsilon(), which adds the few points the door misses so the guarantee
 * this module actually makes is the strict one:
 *
 *     linear interpolation between kept points is within epsilon of every
 *     dropped point.
 *
 * That is exactly the reconstruction the dashboard already performs — charts.js
 * draws each series as an SVG <polyline> — so analog fields render correctly
 * with no client change. Step-shaped fields are the opposite case: a polyline
 * would draw a diagonal ramp through values the car never held, so
 * reconstructSeries() re-inserts an explicit hold point before each transition.
 *
 * TWO INVARIANTS make this safe to bolt onto a codebase that never expected it:
 *
 *   1. GAP ANCHORS. Absence of a row currently means "no data", and compression
 *      would quietly redefine it as "unchanged". Rather than add a ledger of
 *      compressed windows, every field carries a `maxGapS` and a real sample is
 *      force-kept whenever that much time has passed. A gap longer than the
 *      anchor interval therefore still means what it means today, and the
 *      existing gap-based heuristics keep working untouched: STALE_AFTER_S (6h,
 *      the dashboard's "likely actually broken"), MAX_GAP_S_SYNTH (24h,
 *      odometer-jump drive recovery) and getVampireDrain's 3-day ceiling. It
 *      also keeps getTelemetryFieldStatus honest — without anchors a
 *      still-streaming but rarely-changing field would report `last_seen` months
 *      ago and the Fields screen would look broken.
 *
 *   2. FIELD GROUPS. Pack health and tyre balance JOIN separate EAV streams on
 *      exactly equal `ts`. Compressing members independently would drop
 *      brick_v_min at a timestamp where brick_v_max survives and those joins
 *      would silently return nothing — "no data", not a wrong number. Members of
 *      a group are compressed as a unit: if any member is retained at time T,
 *      every member is retained at T. See compressGroup().
 *
 * Everything here is pure and synchronous. Nothing in this file touches D1.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Point {
  ts: number;
  value: number | string | null;
}

/**
 * How a field's history may be thinned.
 *
 * `drive_only` is deliberately absent. Fields that are meaningless at rest
 * (pedal position, nav ETA) are simply `step` with a long `maxGapS`: when the
 * car is parked they are constant, so run-endpoint retention already collapses
 * them to two rows plus anchors. A separate kind would have been a distinct
 * code path with identical behaviour.
 */
export type Rule =
  /** Booleans, enums and strings. Keep both endpoints of every run. */
  | { kind: "step" }
  /** Continuous signals. Swinging door; linear reconstruction. */
  | { kind: "analog"; epsilon: number }
  /** Monotonic counters. Retention is identical to `step`; the kind records
   *  intent, and that a change point must never be merged away. */
  | { kind: "counter" }
  /** Near-constant configuration. `step` with a much longer anchor interval. */
  | { kind: "static" }
  /** Never thinned. */
  | { kind: "never" };

export interface FieldRule {
  rule: Rule;
  /** Force-keep a real sample once this much time has passed. */
  maxGapS: number;
  /** Members of the same group share one retained timestamp set. */
  group?: string;
}

export interface CompressResult {
  /** The points to retain, in ascending `ts`. */
  keep: Point[];
  /** Timestamps of the points to delete, in ascending order. */
  dropTs: number[];
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Default anchor interval. One hour sits comfortably under every gap-based
 * threshold in the codebase — the nearest is the dashboard's 6h "stale" cutoff.
 */
export const DEFAULT_MAX_GAP_S = 3600;
/** Fields nobody analyses at rest, and the hourly config tier. */
export const LONG_MAX_GAP_S = 6 * 3600;

/**
 * Groups whose members must share retained timestamps, because a consumer joins
 * them on equal `ts`. Changing these without changing the corresponding query is
 * how you get a silently empty pack-health card.
 */
export const FIELD_GROUPS: Record<string, readonly string[]> = {
  // restSpreadAvgMv / getPackHealth: (brick_v_max - brick_v_min) filtered by
  // |pack_current| < rest threshold, all three joined ON equal ts.
  pack_brick: ["brick_v_max", "brick_v_min", "pack_current"],
  // getPackHealth module-temp spread, joined ON equal ts.
  pack_module: ["module_temp_max", "module_temp_min"],
  // tireBalance: a four-way join across the corners ON equal ts.
  tpms: ["tpms_fl", "tpms_fr", "tpms_rl", "tpms_rr"],
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const STEP: Rule = { kind: "step" };
const COUNTER: Rule = { kind: "counter" };
const STATIC: Rule = { kind: "static" };
const NEVER: Rule = { kind: "never" };
const analog = (epsilon: number): Rule => ({ kind: "analog", epsilon });

/**
 * Booleans and on/off states. Nothing to interpolate — a run collapses to its
 * two endpoints, which preserves both the value and the exact moment it changed.
 */
const STEP_FIELDS = [
  "locked", "sentry", "brake_pressed", "aeb_off", "driver_present",
  "driver_seatbelt_unbuckled", "hazards", "at_home", "at_work", "at_favorite",
  "auto_seat_climate_l", "auto_seat_climate_r", "defrost_precon", "hvac_ac_on",
  "hvac_auto_mode", "hvac_power", "steering_heat_auto", "rear_defrost",
  "rear_display_hvac", "seat_vent", "wiper_heat", "blind_spot_cam",
  "blind_spot_chime", "emerg_lane_keep", "pass_seatbelt_unbuckled_unreliable",
  "pin_to_drive", "speed_limit_warning", "battery_heater_on", "bms_full_charge",
  "not_enough_power_to_heat", "charge_enable_req", "charge_port_cold",
  "charge_port_door_open", "charge_port_latch", "fast_charger_present",
  "preconditioning", "sched_charge_pending", "supercharger_trip_planner",
  "tpms_hard_warning", "tpms_soft_warning", "gps_lock", "guest_mode",
  "homelink_nearby", "high_beams", "remote_start", "service_mode",
  "speed_limit_mode_on", "valet_mode", "dcdc_enable", "tonneau_tent_mode",

  // Enumerations and string states.
  "gear", "charging_state", "door_state", "window_fd", "window_fp", "window_rd",
  "window_rp", "follow_distance", "lane_departure", "fcw_sensitivity",
  "turn_signal", "drive_rail", "cop_mode", "climate_keeper_mode", "defrost_mode",
  "hvac_fan_status", "bms_state", "charge_cable_type", "fast_charger_type",
  "sched_charge_mode", "hvil_status", "center_display", "guest_mode_access",
  "di_state_f", "di_state_r", "di_state_rel", "di_state_rer", "media_source",
  "media_status", "powershare_status", "powershare_stop_reason",
  "powershare_type", "tonneau_position", "semitruck_tractor_park_brake_status",
  "semitruck_trailer_park_brake_status",

  // Discrete integer levels. These look numeric but only ever take a handful of
  // values, so a tolerance band would be meaningless — level 2 is not "roughly"
  // level 3.
  "seat_heater_l", "seat_heater_r", "seat_heater_rear_c", "seat_heater_rear_l",
  "seat_heater_rear_r", "seat_cool_fl", "seat_cool_fr", "steering_heat_level",
  "hvac_fan_speed", "charge_limit", "charger_phases", "media_volume",
  "media_volume_increment", "media_volume_max", "homelink_count",
  "paired_keys_count", "software_update_pct", "software_update_download_pct",
  "software_update_duration_min", "sched_charge_start",
  "software_update_scheduled_ts", "route_last_updated", "tpms_seen_fl",
  "tpms_seen_fr", "tpms_seen_rl", "tpms_seen_rr",

  // Which brick / module is currently the extreme. Categorical (an index), not a
  // magnitude. SAFE ONLY BECAUSE the weak-brick query weights by dwell time
  // rather than counting rows — see the dwell-weighted rewrite in tracking.ts.
  // If that ever reverts to COUNT(*), a consistently-weak brick emits almost no
  // change events, its evidence gets thinned away, and a noisy brick is flagged
  // instead. test/compress-invariance.test.ts pins this.
  "brick_v_max_num", "brick_v_min_num", "module_temp_max_num",
  "module_temp_min_num",

  // Free-form strings that behave like enums. Run-endpoint retention preserves
  // the '' (playback stopped) rows that mediaLeaderboard relies on as span
  // terminators — an empty string is a value change like any other.
  "media_title", "media_artist", "media_album", "media_station",
  "nav_destination_name", "software_update_version",

  // JSON/blob payloads. No ordering, so nothing to interpolate.
  "nav_destination_location", "nav_origin_location", "nav_route_polyline",
] as const;

/**
 * Fields that are constant while the car is parked and that nobody analyses at
 * rest. Same retention as `step`, but anchored far more loosely.
 */
const REST_IDLE_FIELDS = [
  "accel_pedal", "cruise_set_speed", "car_speed_limit_mph",
  "nav_miles_to_arrival", "nav_minutes_to_arrival", "nav_traffic_delay_min",
  "media_elapsed_ms", "media_duration_ms",
  "powershare_hours_left", "powershare_instantaneous_power_kw",
  "tonneau_open_percent", "semitruck_passenger_seat_fold_position",
] as const;

/** Monotonic. Flat while parked, so run endpoints bracket every real change. */
const COUNTER_FIELDS = [
  "odometer", "lifetime_energy_used_kwh", "lifetime_energy_used_drive",
  "miles_since_reset", "fsd_miles_since_reset", "charge_energy_added",
  "ac_charge_energy_added", "dc_charge_energy_added",
] as const;

/** The hourly config tier — the car's spec, streamed in-band. */
const STATIC_FIELDS = [
  "car_type", "charge_port", "efficiency_package", "europe_vehicle",
  "exterior_color", "offroad_lightbar_present", "rear_seat_heaters",
  "right_hand_drive", "roof_color", "setting_24_hour_time",
  "setting_charge_unit", "setting_distance_unit", "setting_temperature_unit",
  "setting_tire_pressure_unit", "sunroof_installed", "trim", "vehicle_name",
  "wheel_type", "software_version",
] as const;

/**
 * Continuous signals, with the tolerance each one is allowed to lose.
 *
 * Every epsilon below is chosen to sit an order of magnitude under the smallest
 * threshold any consumer applies to that signal, so compression can never be
 * what tips a comparison over.
 */
const ANALOG_FIELDS: Record<string, number> = {
  // Cell voltages feed a brick SPREAD reported in millivolts; healthy spreads
  // are 10-30 mV, so the tolerance has to be a small fraction of that.
  brick_v_max: 0.002,
  brick_v_min: 0.002,
  // Filtered against a rest-current threshold, so the band must not blur the
  // boundary between "at rest" and "under load".
  pack_current: 0.5,
  pack_voltage: 0.5,
  // Module temperature spread, also a difference of two signals.
  module_temp_max: 0.2,
  module_temp_min: 0.2,
  // Trended first-week vs last-week in kOhm; readings run to the hundreds.
  isolation_resistance: 5,
  // The slow-leak alert fires at 0.15 bar/week fitted over 30 days, i.e. a total
  // excursion of ~0.6 bar. 0.02 bar cannot manufacture or mask that.
  tpms_fl: 0.02,
  tpms_fr: 0.02,
  tpms_rl: 0.02,
  tpms_rr: 0.02,
  // Cabin/ambient, in degrees C.
  inside_temp: 0.5,
  outside_temp: 0.5,
  cabin_temp_set: 0.5,
  cabin_temp_set_r: 0.5,
  cop_temp_limit: 0.5,
  // Battery and range. These are POSITION_COLUMNS and only reach EAV on the
  // late-replay path, but they must still be covered when they do — and they
  // are what the row-level `positions` door reads.
  //
  // 1% on SoC is a deliberate choice, not a default: it is what collapses the
  // overnight 80/79/80/79 oscillation to a single point while leaving a real
  // charge ramp intact (the door reproduces a straight line exactly, so
  // 50 -> 80 survives as its two endpoints). The cost is that a reconstructed
  // SoC is accurate to +/-1, so a drain computed across interpolated endpoints
  // carries up to 2 percentage points of error. The phantom-drain alert fires
  // at 8%/day, so that is well clear — but tightening this to 0.5 would defeat
  // the whole purpose, because a one-point oscillation then reopens the door.
  soc: 1,
  usable_soc: 1,
  energy_remaining: 0.2,
  est_range: 1,
  rated_range: 1,
  ideal_range: 1,
  // Charging telemetry.
  charger_voltage: 2,
  charger_current: 0.5,
  charge_current_request: 0.5,
  charge_current_request_max: 0.5,
  charge_rate_mph: 0.5,
  time_to_full_charge: 0.1,
  hours_to_charge_term: 0.1,
  trip_arrival_pct: 1,
  ac_charging_power: 0.1,
  dc_charging_power: 0.1,
  elevation: 5,
  // Structured position columns. In EAV these only appear via late replay, but
  // the row-level `positions` door needs a tolerance for each. GPS jitter while
  // parked is exactly the noise worth losing: 1e-5 degrees is about 1.1 m.
  lat: 0.00001,
  lon: 0.00001,
  speed: 0.5,
  power: 0.2,
  lat_accel: 0.05,
  lon_accel: 0.05,
  brake_pedal: 1,
  // Per-corner powertrain diagnostics. Not in any streaming plan today, so no
  // rows are expected; rules exist so that enabling them later is not a silent
  // regression back to storing every sample.
  di_heatsink_tf: 0.5, di_heatsink_tr: 0.5, di_heatsink_trel: 0.5, di_heatsink_trer: 0.5,
  di_inverter_tf: 0.5, di_inverter_tr: 0.5, di_inverter_trel: 0.5, di_inverter_trer: 0.5,
  di_stator_temp_f: 0.5, di_stator_temp_r: 0.5, di_stator_temp_rel: 0.5, di_stator_temp_rer: 0.5,
  di_v_bat_f: 0.5, di_v_bat_r: 0.5, di_v_bat_rel: 0.5, di_v_bat_rer: 0.5,
  di_axle_speed_f: 1, di_axle_speed_r: 1, di_axle_speed_rel: 1, di_axle_speed_rer: 1,
  di_motor_current_f: 1, di_motor_current_r: 1, di_motor_current_rel: 1, di_motor_current_rer: 1,
  di_torque_actual_f: 1, di_torque_actual_r: 1, di_torque_actual_rel: 1, di_torque_actual_rer: 1,
  di_torquemotor: 1,
  di_slave_torque_cmd: 1,
  semitruck_tpms_pressure_re_1_l_0: 0.02, semitruck_tpms_pressure_re_1_l_1: 0.02,
  semitruck_tpms_pressure_re_1_r_0: 0.02, semitruck_tpms_pressure_re_1_r_1: 0.02,
  semitruck_tpms_pressure_re_2_l_0: 0.02, semitruck_tpms_pressure_re_2_l_1: 0.02,
  semitruck_tpms_pressure_re_2_r_0: 0.02, semitruck_tpms_pressure_re_2_r_1: 0.02,
};

/**
 * Never thinned, each for a specific reason rather than caution.
 *
 * `heading` is the interesting one: it is a CIRCULAR quantity, so 359 -> 0 is a
 * one-degree change that any linear cone reads as a 359-degree excursion. A
 * swinging door would either keep every sample or interpolate the long way round
 * the circle. Correct handling needs unwrapping, which is not worth it for a
 * field that is only ever read inside a drive.
 */
const NEVER_FIELDS = ["heading", "location"] as const;

const REGISTRY: Map<string, FieldRule> = (() => {
  const m = new Map<string, FieldRule>();
  const groupOfField = new Map<string, string>();
  for (const [group, members] of Object.entries(FIELD_GROUPS)) {
    for (const f of members) groupOfField.set(f, group);
  }
  const put = (field: string, rule: Rule, maxGapS: number): void => {
    const group = groupOfField.get(field);
    m.set(field, group ? { rule, maxGapS, group } : { rule, maxGapS });
  };
  for (const f of STEP_FIELDS) put(f, STEP, DEFAULT_MAX_GAP_S);
  for (const f of REST_IDLE_FIELDS) put(f, STEP, LONG_MAX_GAP_S);
  for (const f of COUNTER_FIELDS) put(f, COUNTER, DEFAULT_MAX_GAP_S);
  for (const f of STATIC_FIELDS) put(f, STATIC, LONG_MAX_GAP_S);
  for (const [f, epsilon] of Object.entries(ANALOG_FIELDS)) put(f, analog(epsilon), DEFAULT_MAX_GAP_S);
  for (const f of NEVER_FIELDS) put(f, NEVER, DEFAULT_MAX_GAP_S);
  return m;
})();

/** Never thinned, and the default for anything not in the registry. */
const UNKNOWN_FIELD_RULE: FieldRule = { rule: NEVER, maxGapS: DEFAULT_MAX_GAP_S };

/**
 * The rule for a canonical field name.
 *
 * Unknown fields are NEVER compressed. ingest.ts falls back to
 * `field.toLowerCase()` for anything absent from FIELD_MAP, so the catalog is
 * open-ended in practice — a new Tesla field must not silently inherit somebody
 * else's tolerance. It stays uncompressed until a human picks a rule for it.
 */
export function ruleFor(field: string): FieldRule {
  return REGISTRY.get(field) ?? UNKNOWN_FIELD_RULE;
}

/** The group a field belongs to, if its retained timestamps are shared. */
export function groupOf(field: string): string | undefined {
  return REGISTRY.get(field)?.group;
}

/** Every field with an explicit rule. Exported for tests and diagnostics. */
export function registeredFields(): string[] {
  return [...REGISTRY.keys()].sort();
}

// ---------------------------------------------------------------------------
// Algorithms
// ---------------------------------------------------------------------------

function numeric(v: Point["value"]): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Keep the last sample of every run and the first sample of the next.
 *
 * Both endpoints, not just the opening one: the closing sample is what records
 * WHEN the old value stopped being true. Keeping only the opening sample would
 * leave "locked at 19:04, unlocked at 07:20" indistinguishable from a night with
 * no data at all.
 */
function runEndpointIndices(points: Point[]): Set<number> {
  const keep = new Set<number>([0, points.length - 1]);
  for (let i = 1; i < points.length; i++) {
    if (points[i - 1]!.value !== points[i]!.value) {
      keep.add(i - 1);
      keep.add(i);
    }
  }
  return keep;
}

/**
 * Swinging Door Trending.
 *
 * Invariant: for every dropped point, the straight line between the kept points
 * bracketing it passes within `epsilon`.
 *
 * Non-numeric samples inside an analog series (a null, or a string where a
 * number was expected) cannot participate in the cone, so they are treated as
 * hard transitions: both sides are kept and the door restarts.
 */
function swingingDoorIndices(points: Point[], epsilon: number): Set<number> {
  const keep = new Set<number>([0, points.length - 1]);
  let anchorIdx = 0;
  let upper = Infinity;
  let lower = -Infinity;

  const resetCone = (fromIdx: number, at: Point): void => {
    anchorIdx = fromIdx;
    const av = numeric(points[fromIdx]!.value);
    const pv = numeric(at.value);
    const dt = at.ts - points[fromIdx]!.ts;
    if (av === null || pv === null || dt <= 0) {
      upper = Infinity;
      lower = -Infinity;
      return;
    }
    upper = (pv + epsilon - av) / dt;
    lower = (pv - epsilon - av) / dt;
  };

  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const anchor = points[anchorIdx]!;
    const av = numeric(anchor.value);
    const pv = numeric(p.value);

    if (av === null || pv === null) {
      keep.add(i - 1);
      keep.add(i);
      anchorIdx = i;
      upper = Infinity;
      lower = -Infinity;
      continue;
    }

    const dt = p.ts - anchor.ts;
    if (dt <= 0) {
      // Out-of-order or duplicate timestamp: no slope is defined, so keep it
      // rather than guess.
      keep.add(i);
      continue;
    }

    const up = (pv + epsilon - av) / dt;
    const lo = (pv - epsilon - av) / dt;
    const nextUpper = Math.min(upper, up);
    const nextLower = Math.max(lower, lo);

    if (nextLower > nextUpper) {
      // The door has closed. Archive the previous point — the last one a
      // straight line from the anchor could still represent — and restart from
      // there. A single point can never close a fresh cone (its own bounds are
      // 2*epsilon/dt apart), so i - 1 is always past the anchor; the guard is
      // belt and braces against a pathological epsilon of 0.
      const archived = Math.max(i - 1, anchorIdx + 1);
      keep.add(archived);
      resetCone(archived, p);
    } else {
      upper = nextUpper;
      lower = nextLower;
    }
  }
  return keep;
}

/**
 * Split any segment whose interior deviates from its chord by more than epsilon.
 *
 * WHY THIS IS NEEDED. Swinging Door on its own does NOT bound reconstruction
 * error at epsilon — its textbook worst case is 2*epsilon, because the door
 * tracks a cone of admissible slopes but then archives the previous sample,
 * whose own chord can sit anywhere inside that cone. Measured on a random walk
 * with epsilon = 0.05 the door alone produced a 0.060 excursion.
 *
 * Rather than document a 2*epsilon guarantee and halve every tolerance in the
 * registry (4 mV of slop on a brick spread that is only 10-30 mV wide is not
 * acceptable), this pass makes the stated bound literally true: recursively keep
 * the worst-deviating interior point of any segment that breaches it, exactly as
 * Douglas-Peucker does. The door remains as the fast first pass that gets the
 * answer nearly right; this only ever adds the handful of points it missed.
 *
 * Terminates because every split strictly shrinks both halves and segments
 * shorter than three points have no interior.
 */
function enforceEpsilon(points: Point[], keep: Set<number>, epsilon: number): void {
  const sorted = [...keep].sort((a, b) => a - b);
  const stack: [number, number][] = [];
  for (let i = 1; i < sorted.length; i++) stack.push([sorted[i - 1]!, sorted[i]!]);

  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const pa = points[a]!;
    const pb = points[b]!;
    const va = numeric(pa.value);
    const vb = numeric(pb.value);
    if (va === null || vb === null) continue;

    const dt = pb.ts - pa.ts;
    let worst = -1;
    let worstErr = epsilon + 1e-12;
    for (let j = a + 1; j < b; j++) {
      const pj = points[j]!;
      const vj = numeric(pj.value);
      if (vj === null) {
        worst = j;
        break;
      }
      const interp = dt === 0 ? va : va + ((vb - va) * (pj.ts - pa.ts)) / dt;
      const err = Math.abs(vj - interp);
      if (err > worstErr) {
        worstErr = err;
        worst = j;
      }
    }
    if (worst >= 0) {
      keep.add(worst);
      stack.push([a, worst], [worst, b]);
    }
  }
}

/**
 * Force-keep a real sample once `maxGapS` has elapsed since the last kept one.
 *
 * Uses an existing sample rather than synthesising a timestamp, so every stored
 * row remains something the car actually reported. The resulting guarantee is
 * that consecutive kept points are at most `maxGapS` plus one sample interval
 * apart — unless the source itself had a gap there, which is precisely the case
 * that must stay visible.
 */
function applyGapAnchors(points: Point[], keep: Set<number>, maxGapS: number): void {
  if (!(maxGapS > 0)) return;
  let lastTs = points[0]!.ts;
  for (let i = 1; i < points.length; i++) {
    if (keep.has(i)) {
      lastTs = points[i]!.ts;
      continue;
    }
    if (points[i]!.ts - lastTs >= maxGapS) {
      keep.add(i);
      lastTs = points[i]!.ts;
    }
  }
}

function indicesToResult(points: Point[], keep: Set<number>): CompressResult {
  const kept: Point[] = [];
  const dropTs: number[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep.has(i)) kept.push(points[i]!);
    else dropTs.push(points[i]!.ts);
  }
  return { keep: kept, dropTs };
}

/** The retained indices for one series under one rule, before grouping. */
function retainedIndices(points: Point[], fieldRule: FieldRule): Set<number> {
  const { rule, maxGapS } = fieldRule;
  if (rule.kind === "never") {
    return new Set(points.map((_, i) => i));
  }
  let keep: Set<number>;
  if (rule.kind === "analog") {
    keep = swingingDoorIndices(points, rule.epsilon);
    enforceEpsilon(points, keep, rule.epsilon);
  } else {
    keep = runEndpointIndices(points);
  }
  applyGapAnchors(points, keep, maxGapS);
  return keep;
}

/**
 * Compress one field's series.
 *
 * `points` must be sorted ascending by `ts`. Series of fewer than three points
 * are returned untouched — there is nothing between the endpoints to drop.
 */
export function compressSeries(points: Point[], fieldRule: FieldRule): CompressResult {
  if (points.length < 3) return { keep: [...points], dropTs: [] };
  return indicesToResult(points, retainedIndices(points, fieldRule));
}

/**
 * Compress several fields that must keep identical timestamps.
 *
 * Each member is compressed on its own merits, then the union of every member's
 * retained timestamps is applied to all of them. Consumers that join these
 * streams `ON a.ts = b.ts` therefore see exactly the co-arrival they see today,
 * just less often. Retention is the union rather than the intersection because
 * losing a point one member needed would breach that member's epsilon.
 *
 * Fields absent from `seriesByField` are simply not in the result; a group whose
 * members did not all arrive together still compresses correctly, it just has
 * fewer timestamps to reconcile.
 */
export function compressGroup(
  seriesByField: Map<string, Point[]>,
  ruleLookup: (field: string) => FieldRule = ruleFor,
): Map<string, CompressResult> {
  const union = new Set<number>();
  const perField = new Map<string, Set<number>>();

  for (const [field, points] of seriesByField) {
    if (points.length < 3) {
      for (const p of points) union.add(p.ts);
      perField.set(field, new Set(points.map((_, i) => i)));
      continue;
    }
    const keep = retainedIndices(points, ruleLookup(field));
    perField.set(field, keep);
    for (const i of keep) union.add(points[i]!.ts);
  }

  const out = new Map<string, CompressResult>();
  for (const [field, points] of seriesByField) {
    const keep = perField.get(field) ?? new Set<number>();
    for (let i = 0; i < points.length; i++) {
      if (union.has(points[i]!.ts)) keep.add(i);
    }
    out.set(field, indicesToResult(points, keep));
  }
  return out;
}

/**
 * Re-expand a compressed series for display.
 *
 * Analog series are returned unchanged: the caller (and charts.js) already joins
 * points with straight lines, which is the reconstruction the swinging door
 * guarantees.
 *
 * Step-shaped series get an explicit hold point one second before each
 * transition, so a renderer that draws straight lines produces a square edge
 * instead of a diagonal ramp through values the car never held. The synthetic
 * point is inserted only where it does not collide with a real sample.
 */
export function reconstructSeries(points: Point[], fieldRule: FieldRule): Point[] {
  if (fieldRule.rule.kind === "analog" || fieldRule.rule.kind === "never") return [...points];
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const prev = points[i - 1];
    if (prev && prev.value !== p.value && p.ts - prev.ts > 1) {
      out.push({ ts: p.ts - 1, value: prev.value });
    }
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Write-side gate
// ---------------------------------------------------------------------------

/** Last value written per field, carried between ingests in `app_state`. */
export type WriteState = Record<string, { ts: number; v: number | string | null }>;

/** Forget fields that have not reported in this long, so the doc stays small. */
export const WRITE_STATE_TTL_S = 7 * 86400;

export interface WriteCandidate {
  field: string;
  ts: number;
  /** The value as it will be STORED, so "unchanged" is judged the way SQL will. */
  value: number | string | null;
}

/**
 * Should this sample be written at all, given the last one that was?
 *
 * This is a plain deadband — "record on significant change" — NOT the swinging
 * door. The door has to emit the point BEFORE the one that closed it, which
 * means buffering a sample and writing it a beat late; at ingest time that
 * complexity buys little, because the retroactive grinder re-runs the real door
 * over the same history later and collapses whatever this pass left behind.
 *
 * The division of labour is deliberate: this is the cheap gate that stops the
 * bleeding on every ingest, and the grinder is the optimiser that runs once a
 * day with a budget check in front of it. A deadband keeps a point every epsilon
 * along a ramp where the door would keep only its two ends — more rows than
 * necessary, never fewer, and never outside the tolerance.
 */
function retainOnWrite(
  prev: WriteState[string] | undefined,
  e: WriteCandidate,
  fieldRule: FieldRule,
): boolean {
  if (fieldRule.rule.kind === "never") return true;
  if (!prev) return true; // first sight of this field
  if (e.ts <= prev.ts) return true; // out of order — store it, don't judge it
  if (e.ts - prev.ts >= fieldRule.maxGapS) return true; // anchor
  if (fieldRule.rule.kind === "analog") {
    const a = numeric(prev.v);
    const b = numeric(e.value);
    if (a === null || b === null) return true;
    return Math.abs(b - a) > fieldRule.rule.epsilon;
  }
  return prev.v !== e.value;
}

/**
 * Filter one ingest's worth of events, updating `state` in place for whatever
 * survives.
 *
 * A group is written whole or not at all. Every member arrives in the same
 * batch under one timestamp, so honouring that here is just a second pass — and
 * it is what keeps the pack-health and tyre-balance joins (which pair fields ON
 * equal ts) finding matches.
 */
export function filterForWrite<T extends WriteCandidate>(
  state: WriteState,
  events: T[],
  ruleLookup: (field: string) => FieldRule = ruleFor,
): T[] {
  const keep = new Set<number>();
  const liveGroups = new Set<string>();

  events.forEach((e, i) => {
    const fieldRule = ruleLookup(e.field);
    if (retainOnWrite(state[e.field], e, fieldRule)) {
      keep.add(i);
      if (fieldRule.group) liveGroups.add(fieldRule.group);
    }
  });

  if (liveGroups.size > 0) {
    events.forEach((e, i) => {
      const group = ruleLookup(e.field).group;
      if (group !== undefined && liveGroups.has(group)) keep.add(i);
    });
  }

  const out: T[] = [];
  events.forEach((e, i) => {
    if (!keep.has(i)) return;
    out.push(e);
    state[e.field] = { ts: e.ts, v: e.value };
  });
  return out;
}

/** Drop fields that stopped reporting, so the carried state cannot grow forever. */
export function pruneWriteState(state: WriteState, nowTs: number, ttlS = WRITE_STATE_TTL_S): void {
  for (const [field, last] of Object.entries(state)) {
    if (nowTs - last.ts > ttlS) delete state[field];
  }
}

/**
 * The value a compressed series implies at `ts` — the last sample at or before
 * it, with analog series interpolated linearly between their neighbours.
 *
 * This is the "fill in the gaps" half of the contract, for callers that need a
 * value at an arbitrary instant rather than a series to draw.
 */
export function valueAt(points: Point[], ts: number, fieldRule: FieldRule): number | string | null {
  if (points.length === 0) return null;
  let lo = 0;
  let hi = points.length - 1;
  if (ts <= points[0]!.ts) return points[0]!.value;
  if (ts >= points[hi]!.ts) return points[hi]!.value;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.ts <= ts) lo = mid;
    else hi = mid;
  }
  const a = points[lo]!;
  const b = points[hi]!;
  if (fieldRule.rule.kind !== "analog") return a.value;
  const av = numeric(a.value);
  const bv = numeric(b.value);
  if (av === null || bv === null || b.ts === a.ts) return a.value;
  return av + ((bv - av) * (ts - a.ts)) / (b.ts - a.ts);
}
