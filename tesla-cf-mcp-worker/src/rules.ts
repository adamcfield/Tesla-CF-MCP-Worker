/**
 * Automation rules engine.
 *
 * Rules are JSON documents stored in KV (key "automations"), managed via the
 * list_automations / set_automation / delete_automation MCP tools. Two
 * evaluation paths:
 *
 *   - evaluateOnIngest(): runs on every telemetry ingest — geofences and
 *     state-transition alerts (unlocked-while-away, soc-below, TPMS drop,
 *     charging start/stop).
 *   - runCronTick(): runs on the Worker cron (every 15 min) — price-aware
 *     charging, solar-surplus charging, conditional preconditioning,
 *     connectivity-transition alerts (unexpected wake), optional snapshot
 *     polling.
 *
 * Cost hygiene: the cron only ever calls the free connectivity endpoint by
 * default. Billed vehicle_data polls happen ONLY for rules that explicitly
 * set "allow_poll": true and only when the vehicle is already online — a
 * telemetry stream makes polling unnecessary. Commands are never sent to a
 * sleeping vehicle and nothing here ever wakes one.
 *
 * Safety: automation actions are allowlisted — deliberately NO unlock and NO
 * trunk/frunk opening from automations (those remain manual MCP tools).
 */

import { getVehicle, getVehicleData } from "./api";
import * as cmd from "./commands";
import { applyVehicleData } from "./ingest";
import { getLatest, LatestState, logAlert } from "./store";
import { recordConnectivityState } from "./tracking";
import { Env } from "./types";

// ---------------------------------------------------------------------------
// Rule model
// ---------------------------------------------------------------------------

export interface FeedSource {
  url: string;
  headers?: Record<string, string>;
  /** Dot path into the JSON response, e.g. "0.perKwh" or "power.export_w". */
  json_path?: string;
  /** "amber" picks perKwh of the channelType=="general" entry. */
  format?: "amber" | "raw";
}

export interface AutomationRule {
  id: string;
  type:
    | "price_charging"
    | "solar_surplus"
    | "scheduled_precondition"
    | "geofence"
    | "alert"
    | "log_snapshot";
  vin: string;
  enabled?: boolean;
  /** Webhook URLs notified when the rule fires (MessageBird flow, Make, n8n, Sheets…). */
  notify?: string[];
  /** Opt-in to billed vehicle_data polls when telemetry is stale. Default false. */
  allow_poll?: boolean;
  /** Minimum minutes between firings (default 60 for alerts, 0 for control rules). */
  cooldown_minutes?: number;
  [key: string]: unknown;
}

export interface Action {
  command:
    | "climate_on"
    | "climate_off"
    | "set_temperature"
    | "set_charge_limit"
    | "set_charging_amps"
    | "start_charging"
    | "stop_charging"
    | "open_charge_port"
    | "close_charge_port"
    | "lock"
    | "flash_lights"
    | "sentry_on"
    | "sentry_off"
    | "navigate_to";
  args?: Record<string, number>;
}

const AUTOMATIONS_KEY = "automations";
const TICK_MINUTES = 15;
/** Telemetry newer than this is trusted without polling. */
const FRESH_SECONDS = 20 * 60;

export async function getAutomations(env: Env): Promise<AutomationRule[]> {
  return (await env.TESLA_KV.get<AutomationRule[]>(AUTOMATIONS_KEY, "json")) ?? [];
}

export async function saveAutomation(env: Env, rule: AutomationRule): Promise<AutomationRule> {
  const rules = await getAutomations(env);
  if (!rule.id) rule.id = `rule_${crypto.randomUUID().slice(0, 8)}`;
  const i = rules.findIndex((r) => r.id === rule.id);
  if (i >= 0) rules[i] = rule;
  else rules.push(rule);
  await env.TESLA_KV.put(AUTOMATIONS_KEY, JSON.stringify(rules));
  return rule;
}

export async function deleteAutomation(env: Env, id: string): Promise<boolean> {
  const rules = await getAutomations(env);
  const next = rules.filter((r) => r.id !== id);
  await env.TESLA_KV.put(AUTOMATIONS_KEY, JSON.stringify(next));
  return next.length !== rules.length;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

function dig(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Fetches a numeric signal (price in cents, surplus in watts, …) from a feed. */
export async function fetchNumber(source: FeedSource): Promise<number> {
  const resp = await fetch(source.url, { headers: source.headers });
  if (!resp.ok) throw new Error(`feed ${source.url} → ${resp.status}`);
  const body = (await resp.json()) as unknown;
  let value: unknown = body;
  if (source.format === "amber" && Array.isArray(body)) {
    const general = body.find(
      (e) => (e as Record<string, unknown>).channelType === "general",
    ) as Record<string, unknown> | undefined;
    value = general?.perKwh;
  } else if (source.json_path) {
    value = dig(body, source.json_path);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`feed ${source.url}: non-numeric value ${String(value)}`);
  return n;
}

async function underCooldown(env: Env, rule: AutomationRule, defaultMinutes: number): Promise<boolean> {
  const minutes = rule.cooldown_minutes ?? defaultMinutes;
  if (minutes <= 0) return false;
  const key = `cooldown:${rule.id}:${rule.vin}`;
  if (await env.TESLA_KV.get(key)) return true;
  await env.TESLA_KV.put(key, "1", { expirationTtl: Math.max(60, minutes * 60) });
  return false;
}

/**
 * Edge-trigger: returns true only when `regime` differs from the last regime
 * recorded for this rule. Control rules (price/solar) use it so a persisting
 * condition acts + notifies ONCE per transition rather than every cron tick.
 */
async function regimeChanged(env: Env, rule: AutomationRule, regime: string): Promise<boolean> {
  const key = `regime:${rule.id}:${rule.vin}`;
  const prev = await env.TESLA_KV.get(key);
  if (prev === regime) return false;
  await env.TESLA_KV.put(key, regime);
  return true;
}

async function runActions(env: Env, rule: AutomationRule, actions: Action[]): Promise<string[]> {
  const done: string[] = [];
  for (const a of actions) {
    const vin = rule.vin;
    const g = a.args ?? {};
    switch (a.command) {
      case "climate_on": await cmd.climateOn(env, vin); break;
      case "climate_off": await cmd.climateOff(env, vin); break;
      case "set_temperature": await cmd.setTemperature(env, vin, g.temp_celsius ?? 21); break;
      case "set_charge_limit": await cmd.setChargeLimit(env, vin, g.percent ?? 80); break;
      case "set_charging_amps": await cmd.setChargingAmps(env, vin, g.amps ?? 16); break;
      case "start_charging": await cmd.startCharging(env, vin); break;
      case "stop_charging": await cmd.stopCharging(env, vin); break;
      case "open_charge_port": await cmd.openChargePort(env, vin); break;
      case "close_charge_port": await cmd.closeChargePort(env, vin); break;
      case "lock": await cmd.lockDoors(env, vin); break;
      case "flash_lights": await cmd.flashLights(env, vin); break;
      case "sentry_on": await cmd.setSentryMode(env, vin, true); break;
      case "sentry_off": await cmd.setSentryMode(env, vin, false); break;
      case "navigate_to": await cmd.navigateToCoords(env, vin, g.lat ?? 0, g.lon ?? 0); break;
      default: continue; // unknown/disallowed commands are ignored, never executed
    }
    done.push(a.command);
  }
  return done;
}

async function dispatchWebhooks(
  env: Env,
  rule: AutomationRule,
  kind: string,
  message: string,
  data: unknown,
): Promise<void> {
  const urls = rule.notify ?? [];
  let delivered = urls.length === 0;
  for (const url of urls) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(env.WEBHOOK_SECRET ? { "x-webhook-token": env.WEBHOOK_SECRET } : {}),
        },
        body: JSON.stringify({ rule_id: rule.id, kind, vin: rule.vin, message, data, ts: Math.floor(Date.now() / 1000) }),
      });
      delivered = delivered || resp.ok;
    } catch {
      // logged below as undelivered
    }
  }
  await logAlert(env, { vin: rule.vin, ruleId: rule.id, kind, message, payload: data, delivered });
}

async function fire(
  env: Env,
  rule: AutomationRule,
  kind: string,
  message: string,
  data: unknown,
  actions?: Action[],
): Promise<void> {
  const executed = actions?.length ? await runActions(env, rule, actions) : [];
  await dispatchWebhooks(env, rule, kind, message, { ...(data as object), executed });
}

const asNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

// ---------------------------------------------------------------------------
// Ingest-path evaluation: geofences + transition alerts
// ---------------------------------------------------------------------------

export async function evaluateOnIngest(
  env: Env,
  vin: string,
  previous: LatestState | null,
  current: LatestState,
): Promise<void> {
  let rules: AutomationRule[];
  try {
    rules = (await getAutomations(env)).filter((r) => r.enabled !== false && r.vin === vin);
  } catch {
    return;
  }
  for (const rule of rules) {
    try {
      if (rule.type === "geofence") await evalGeofence(env, rule, current);
      else if (rule.type === "alert") await evalAlert(env, rule, previous, current);
    } catch (e) {
      await logAlert(env, {
        vin,
        ruleId: rule.id,
        kind: "rule_error",
        message: e instanceof Error ? e.message : String(e),
        delivered: false,
      });
    }
  }
}

async function evalGeofence(env: Env, rule: AutomationRule, current: LatestState): Promise<void> {
  const lat = asNum(current.lat);
  const lon = asNum(current.lon);
  const zLat = asNum(rule.lat);
  const zLon = asNum(rule.lon);
  if (lat === undefined || lon === undefined || zLat === undefined || zLon === undefined) return;
  const radius = asNum(rule.radius_m) ?? 200;
  const inside = haversineMeters(lat, lon, zLat, zLon) <= radius;

  const stateKey = `geo:${rule.id}:${rule.vin}`;
  const prev = await env.TESLA_KV.get(stateKey);
  const now = inside ? "in" : "out";
  if (prev === now) return;
  await env.TESLA_KV.put(stateKey, now);
  if (prev === null) return; // first sighting — establish state, don't fire

  const name = typeof rule.name === "string" ? rule.name : rule.id;
  if (inside) {
    await fire(env, rule, "geofence_enter", `${rule.vin} entered ${name}`, { lat, lon }, rule.on_enter as Action[] | undefined);
  } else {
    await fire(env, rule, "geofence_exit", `${rule.vin} left ${name}`, { lat, lon }, rule.on_exit as Action[] | undefined);
  }
}

async function evalAlert(
  env: Env,
  rule: AutomationRule,
  previous: LatestState | null,
  current: LatestState,
): Promise<void> {
  if (!previous) return;
  const when = String(rule.when ?? "");

  if (when === "door_unlocked_while_away") {
    const home = rule.home as { lat: number; lon: number; radius_m?: number } | undefined;
    const lat = asNum(current.lat);
    const lon = asNum(current.lon);
    const wasLocked = previous.locked === true || previous.locked === 1;
    const nowUnlocked = current.locked === false || current.locked === 0;
    if (!(wasLocked && nowUnlocked)) return;
    if (home && lat !== undefined && lon !== undefined) {
      if (haversineMeters(lat, lon, home.lat, home.lon) <= (home.radius_m ?? 200)) return; // at home — fine
    }
    if (await underCooldown(env, rule, 30)) return;
    await fire(env, rule, "alert", `${rule.vin} was unlocked away from home`, { lat, lon });
    return;
  }

  if (when === "soc_below") {
    const threshold = asNum(rule.threshold) ?? 20;
    const prevSoc = asNum(previous.soc);
    const curSoc = asNum(current.soc);
    if (prevSoc === undefined || curSoc === undefined) return;
    if (!(prevSoc > threshold && curSoc <= threshold)) return;
    const between = rule.between_hours as [number, number] | undefined;
    if (between) {
      const tz = asNum(rule.tz_offset_minutes) ?? 0;
      const hour = Math.floor((((Date.now() / 60000 + tz) % 1440) + 1440) % 1440 / 60);
      const [start, end] = between;
      const inWindow = start <= end ? hour >= start && hour < end : hour >= start || hour < end;
      if (!inWindow) return;
    }
    if (await underCooldown(env, rule, 360)) return;
    await fire(env, rule, "alert", `${rule.vin} battery at ${curSoc}% (below ${threshold}%)`, { soc: curSoc });
    return;
  }

  if (when === "tire_pressure_drop") {
    const drop = asNum(rule.drop_bar) ?? 0.3;
    for (const wheel of ["tpms_fl", "tpms_fr", "tpms_rl", "tpms_rr"]) {
      const before = asNum(previous[wheel]);
      const after = asNum(current[wheel]);
      if (before !== undefined && after !== undefined && before - after >= drop) {
        if (await underCooldown(env, rule, 120)) return;
        await fire(env, rule, "alert", `${rule.vin} ${wheel.slice(5).toUpperCase()} tire dropped ${before}→${after} bar`, {
          wheel,
          before,
          after,
        });
        return;
      }
    }
    return;
  }

  if (when === "charging_started" || when === "charging_stopped") {
    const before = String(previous.charging_state ?? "");
    const after = String(current.charging_state ?? "");
    if (before === after) return;
    const started = after === "Charging";
    const stopped = before === "Charging" && after !== "Charging";
    if ((when === "charging_started" && started) || (when === "charging_stopped" && stopped)) {
      await fire(env, rule, "alert", `${rule.vin} ${started ? "started" : "stopped"} charging (soc ${current.soc ?? "?"}%)`, {
        charging_state: after,
        soc: current.soc,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Cron-path evaluation
// ---------------------------------------------------------------------------

export async function runCronTick(env: Env): Promise<Record<string, unknown>> {
  // Lock so the 15-min cron and an on-demand run_automations_now can't overlap
  // and double-execute commands. KV is eventually consistent, so this dedupes
  // the common (same-colo, seconds-apart) case rather than being a hard mutex.
  const LOCK_KEY = "tick_lock";
  if (await env.TESLA_KV.get(LOCK_KEY)) return { skipped: "another automation tick is in progress" };
  await env.TESLA_KV.put(LOCK_KEY, "1", { expirationTtl: 120 });
  try {
    return await runCronTickInner(env);
  } finally {
    await env.TESLA_KV.delete(LOCK_KEY);
  }
}

async function runCronTickInner(env: Env): Promise<Record<string, unknown>> {
  const rules = (await getAutomations(env)).filter((r) => r.enabled !== false);
  const summary: Record<string, unknown> = { evaluated: rules.length, fired: [] as string[] };
  const fired = summary.fired as string[];

  // One free connectivity check per involved VIN.
  const vins = [...new Set(rules.map((r) => r.vin).filter(Boolean))];
  const connectivity = new Map<string, string>();
  for (const vin of vins) {
    try {
      const v = await getVehicle(env, vin);
      connectivity.set(vin, v.state);
      // Feed the state timeline: asleep/offline/wake come from this free check.
      await recordConnectivityState(env, vin, v.state).catch(() => {});
      await detectWakeTransition(env, rules, vin, v.state, fired);
    } catch {
      connectivity.set(vin, "unknown");
    }
  }

  for (const rule of rules) {
    try {
      const online = connectivity.get(rule.vin) === "online";
      const state = await freshState(env, rule, online);
      switch (rule.type) {
        case "price_charging":
          if (await evalPriceCharging(env, rule, online, state)) fired.push(rule.id);
          break;
        case "solar_surplus":
          if (await evalSolarSurplus(env, rule, online, state)) fired.push(rule.id);
          break;
        case "scheduled_precondition":
          if (await evalScheduledPrecondition(env, rule, online, state)) fired.push(rule.id);
          break;
        case "log_snapshot":
          if (online && rule.allow_poll && state.polled) fired.push(rule.id);
          break;
      }
    } catch (e) {
      await logAlert(env, {
        vin: rule.vin,
        ruleId: rule.id,
        kind: "rule_error",
        message: e instanceof Error ? e.message : String(e),
        delivered: false,
      });
    }
  }
  return summary;
}

async function detectWakeTransition(
  env: Env,
  rules: AutomationRule[],
  vin: string,
  state: string,
  fired: string[],
): Promise<void> {
  const key = `conn:${vin}`;
  const prev = await env.TESLA_KV.get(key);
  if (prev !== state) await env.TESLA_KV.put(key, state);
  if (prev && prev !== "online" && state === "online") {
    for (const rule of rules) {
      if (rule.vin === vin && rule.type === "alert" && rule.when === "unexpected_wake") {
        if (!(await underCooldown(env, rule, 60))) {
          await fire(env, rule, "alert", `${vin} woke up (${prev} → online)`, { previous: prev });
          fired.push(rule.id);
        }
      }
    }
  }
}

interface CronState {
  latest: LatestState | null;
  fresh: boolean;
  polled: boolean;
}

/**
 * Returns the freshest state we're allowed to have: telemetry-fed KV if
 * recent; else a billed vehicle_data poll ONLY when the rule opted in with
 * allow_poll and the vehicle is already online. Never wakes the vehicle.
 */
async function freshState(env: Env, rule: AutomationRule, online: boolean): Promise<CronState> {
  const latest = await getLatest(env, rule.vin);
  const age = latest ? Date.now() / 1000 - latest.updated_at : Infinity;
  const interval = (asNum(rule.interval_minutes) ?? 0) * 60;
  const staleAfter = rule.type === "log_snapshot" ? Math.max(interval, 60) : FRESH_SECONDS;
  if (age <= staleAfter) return { latest, fresh: true, polled: false };
  if (rule.allow_poll && online) {
    const vd = await getVehicleData(env, rule.vin, ["charge_state", "climate_state", "drive_state", "location_data", "vehicle_state"]);
    return { latest: await applyVehicleData(env, rule.vin, vd), fresh: true, polled: true };
  }
  return { latest, fresh: false, polled: false };
}

const PLUGGED_STATES = new Set(["Charging", "Starting", "Stopped", "Complete", "NoPower"]);

async function evalPriceCharging(
  env: Env,
  rule: AutomationRule,
  online: boolean,
  state: CronState,
): Promise<boolean> {
  if (!online || !state.fresh || !state.latest) return false;
  const chargingState = String(state.latest.charging_state ?? "");
  if (!PLUGGED_STATES.has(chargingState)) return false; // not plugged in — nothing to control

  const price = await fetchNumber(rule.feed as FeedSource);
  const cheapBelow = asNum(rule.cheap_below_cents);
  const expensiveAbove = asNum(rule.expensive_above_cents);
  const charging = chargingState === "Charging" || chargingState === "Starting";

  // Classify the price regime and act only when it changes (edge-trigger),
  // so a price that stays cheap for hours doesn't re-command + re-notify every
  // 15-min tick.
  let regime = "neutral";
  if (cheapBelow !== undefined && price <= cheapBelow) regime = "cheap";
  else if (expensiveAbove !== undefined && price >= expensiveAbove) regime = "expensive";
  if (!(await regimeChanged(env, rule, `price:${regime}`))) return false;

  if (regime === "cheap") {
    const amps = asNum(rule.amps_cheap);
    const limit = asNum(rule.limit_cheap);
    if (amps) await cmd.setChargingAmps(env, rule.vin, amps);
    if (limit) await cmd.setChargeLimit(env, rule.vin, limit);
    if (!charging) await cmd.startCharging(env, rule.vin);
    await dispatchWebhooks(env, rule, "price_charging", `price ${price}c ≤ ${cheapBelow}c — charging at ${amps ?? "current"}A`, { price });
    return true;
  }
  if (regime === "expensive" && charging) {
    await cmd.stopCharging(env, rule.vin);
    await dispatchWebhooks(env, rule, "price_charging", `price ${price}c ≥ ${expensiveAbove}c — stopped charging`, { price });
    return true;
  }
  return false;
}

async function evalSolarSurplus(
  env: Env,
  rule: AutomationRule,
  online: boolean,
  state: CronState,
): Promise<boolean> {
  if (!online || !state.fresh || !state.latest) return false;
  const chargingState = String(state.latest.charging_state ?? "");
  if (!PLUGGED_STATES.has(chargingState)) return false;

  // Optional location gate: only solar-charge at the site with the panels.
  const at = rule.at as { lat: number; lon: number; radius_m?: number } | undefined;
  if (at) {
    const lat = asNum(state.latest.lat);
    const lon = asNum(state.latest.lon);
    if (lat === undefined || lon === undefined) return false;
    if (haversineMeters(lat, lon, at.lat, at.lon) > (at.radius_m ?? 300)) return false;
  }

  const surplusRaw = await fetchNumber(rule.source as FeedSource);
  const volts = asNum(rule.volts) ?? 230;
  const phases = asNum(rule.phases) ?? 1;
  const minAmps = asNum(rule.min_amps) ?? 5;
  const maxAmps = asNum(rule.max_amps) ?? 16;
  const charging = chargingState === "Charging" || chargingState === "Starting";

  // Add the car's own charging draw back into the reading. A grid-export feed
  // already has the car's consumption subtracted, so regulating on the raw
  // figure oscillates: start → export drops → below stop → stop → export rises
  // → above start → start. `surplus` here is PV surplus as if the car were idle.
  const measuredKw = asNum(state.latest.charger_power);
  const measuredAmps = asNum(state.latest.charger_current);
  const carDrawW = charging
    ? measuredKw !== undefined
      ? measuredKw * 1000
      : (measuredAmps ?? 0) * volts * phases
    : 0;
  const surplus = surplusRaw + carDrawW;

  const startAbove = asNum(rule.start_above_w) ?? volts * phases * minAmps;
  const stopBelow = asNum(rule.stop_below_w) ?? Math.round(startAbove / 2);
  const targetAmps = Math.min(maxAmps, Math.max(minAmps, Math.floor(surplus / (volts * phases))));

  if (surplus >= startAbove && targetAmps >= minAmps) {
    if (!charging) {
      await cmd.setChargingAmps(env, rule.vin, targetAmps);
      await cmd.startCharging(env, rule.vin);
      if (await regimeChanged(env, rule, "solar:charging")) {
        await dispatchWebhooks(env, rule, "solar_surplus", `surplus ${Math.round(surplus)}W → charging at ${targetAmps}A`, { surplus, amps: targetAmps });
      }
      return true;
    }
    // Already charging — track the sun by nudging amps only when they change
    // (no command/webhook spam when steady).
    if (targetAmps !== asNum(state.latest.charger_current)) {
      await cmd.setChargingAmps(env, rule.vin, targetAmps);
      return true;
    }
    return false;
  }
  if (charging && surplus <= stopBelow) {
    await cmd.stopCharging(env, rule.vin);
    if (await regimeChanged(env, rule, "solar:stopped")) {
      await dispatchWebhooks(env, rule, "solar_surplus", `surplus ${Math.round(surplus)}W ≤ ${stopBelow}W → stopped charging`, { surplus });
    }
    return true;
  }
  return false;
}

const DAY_ORDER = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Bit for a day token (first 3 letters), or -1 if unrecognized. */
function dayIndex(token: string): number {
  return DAY_ORDER.indexOf(token.trim().toLowerCase().slice(0, 3));
}

/**
 * Parses a days spec into a bitmask (bit 0 = Sunday, matching getUTCDay()).
 * Accepts "All"/"Everyday"/"Daily", "Weekdays", "Weekend(s)", comma lists
 * ("Mon,Tue"), and inclusive (wrapping) ranges ("Mon-Fri", "Sun-Thu").
 * Throws on genuinely unrecognized tokens rather than silently mis-gating —
 * the old version dropped unknown tokens and fell back to all-days.
 */
function daysMask(days: unknown): number {
  if (typeof days !== "string") return 127;
  const s = days.trim().toLowerCase();
  if (s === "" || s === "all" || s === "every" || s === "everyday" || s === "daily") return 127;
  if (s === "weekday" || s === "weekdays") return bits(["mon", "tue", "wed", "thu", "fri"]);
  if (s === "weekend" || s === "weekends") return bits(["sat", "sun"]);

  let mask = 0;
  for (const rawPart of s.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part.includes("-")) {
      const [a, b] = part.split("-");
      const ia = dayIndex(a ?? "");
      const ib = dayIndex(b ?? "");
      if (ia < 0 || ib < 0) throw new Error(`Unrecognized day range "${part}" — use e.g. "Mon-Fri"`);
      for (let i = ia; ; i = (i + 1) % 7) {
        mask |= 1 << i;
        if (i === ib) break;
      }
    } else {
      const idx = dayIndex(part);
      if (idx < 0) throw new Error(`Unrecognized day "${part}" — use e.g. "Mon,Tue", "Mon-Fri", "Weekdays", or "All"`);
      mask |= 1 << idx;
    }
  }
  if (mask === 0) throw new Error(`No valid days parsed from "${days}"`);
  return mask;
}

function bits(names: string[]): number {
  return names.reduce((m, n) => m | (1 << dayIndex(n)), 0);
}

async function evalScheduledPrecondition(
  env: Env,
  rule: AutomationRule,
  online: boolean,
  state: CronState,
): Promise<boolean> {
  const time = String(rule.time ?? "07:00");
  const [hh, mm] = time.split(":").map(Number);
  const tz = asNum(rule.tz_offset_minutes) ?? 0;
  const nowLocalMin = (((Date.now() / 60000 + tz) % 1440) + 1440) % 1440;
  const targetMin = (hh ?? 7) * 60 + (mm ?? 0);
  // Fire on the tick whose window [now, now+TICK) contains the target time.
  const delta = targetMin - nowLocalMin;
  if (delta < 0 || delta >= TICK_MINUTES) return false;

  const localDay = new Date(Date.now() + tz * 60000).getUTCDay(); // 0=Sun
  if ((daysMask(rule.days) & (1 << localDay)) === 0) return false;
  if (await underCooldown(env, rule, 180)) return false;

  const cond = (rule.conditions ?? {}) as { outside_temp_below_c?: number; soc_above?: number };
  if (cond.outside_temp_below_c !== undefined || cond.soc_above !== undefined) {
    if (!state.fresh || !state.latest) {
      await logAlert(env, {
        vin: rule.vin,
        ruleId: rule.id,
        kind: "skipped",
        message: "precondition skipped: no fresh state to evaluate conditions (enable telemetry or allow_poll)",
        delivered: false,
      });
      return false;
    }
    const temp = asNum(state.latest.outside_temp);
    const soc = asNum(state.latest.soc);
    if (cond.outside_temp_below_c !== undefined && !(temp !== undefined && temp < cond.outside_temp_below_c)) return false;
    if (cond.soc_above !== undefined && !(soc !== undefined && soc > cond.soc_above)) return false;
  }

  if (!online) {
    await logAlert(env, {
      vin: rule.vin,
      ruleId: rule.id,
      kind: "skipped",
      message: "precondition skipped: vehicle not online (this rule never wakes the car)",
      delivered: false,
    });
    return false;
  }

  await cmd.climateOn(env, rule.vin);
  const temp = asNum(rule.temp_celsius);
  if (temp) await cmd.setTemperature(env, rule.vin, temp);
  await dispatchWebhooks(env, rule, "scheduled_precondition", `preconditioning ${rule.vin} for ${time}`, {});
  return true;
}
