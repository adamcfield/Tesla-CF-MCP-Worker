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

import { generateBrief, generateCoachNote } from "./ai";
import { getVehicle, getVehicleData } from "./api";
import { getBudgetCallLog, getBudgetForecast, getBudgetStatus } from "./budget";
import * as cmd from "./commands";
import { applyVehicleData } from "./ingest";
import { getAppState, getLatest, LatestState, logAlert, putAppState, tzOffsetMinutes } from "./store";
import { createTelemetryConfig } from "./telemetry";
import { TELEMETRY_CA, TELEMETRY_HOSTNAME, TELEMETRY_PLANS, TELEMETRY_PORT, TelemetryPlanStep } from "./telemetry-plans";
import { closeStaleSessions, getTirePressures, getVampireDrain, recordConnectivityState } from "./tracking";
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
    | "log_snapshot"
    | "ai_brief"
    | "sentinel";
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

async function underCooldown(env: Env, rule: AutomationRule, defaultMinutes: number, scope = ""): Promise<boolean> {
  const minutes = rule.cooldown_minutes ?? defaultMinutes;
  if (minutes <= 0) return false;
  // `scope` gives independent conditions (e.g. each tyre, phantom-drain) their
  // own cooldown so one firing doesn't suppress a different, concurrent one.
  const key = `cooldown:${rule.id}:${rule.vin}${scope ? `:${scope}` : ""}`;
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
    try {
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
    } catch {
      // One failed command (asleep car, API blip) must not sink the alert
      // itself or the remaining actions -- `executed` simply won't list it.
      continue;
    }
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

/**
 * DST-aware timezone offset (minutes) for a rule's time gates. Priority:
 * rule.tz (IANA zone, e.g. "Asia/Jerusalem") → rule.tz_offset_minutes (legacy
 * fixed offset — wrong for half the year in DST countries) → the deployment's
 * DEFAULT_TZ zone → UTC. Computed per evaluation so a clock change never
 * shifts "precondition at 07:00" by an hour.
 */
function ruleTzOffsetMin(env: Env, rule: AutomationRule): number {
  const zone = typeof rule.tz === "string" && rule.tz ? rule.tz : null;
  if (zone) {
    const off = tzOffsetMinutes(zone);
    if (off !== null) return off;
  }
  const fixed = asNum(rule.tz_offset_minutes);
  if (fixed !== undefined) return fixed;
  return tzOffsetMinutes(env.DEFAULT_TZ || "Asia/Jerusalem") ?? 0;
}

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
    await fire(env, rule, "alert", `${rule.vin} was unlocked away from home`, { lat, lon }, rule.actions as Action[] | undefined);
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
      const tz = ruleTzOffsetMin(env, rule);
      const hour = Math.floor((((Date.now() / 60000 + tz) % 1440) + 1440) % 1440 / 60);
      const [start, end] = between;
      const inWindow = start <= end ? hour >= start && hour < end : hour >= start || hour < end;
      if (!inWindow) return;
    }
    if (await underCooldown(env, rule, 360)) return;
    await fire(env, rule, "alert", `${rule.vin} battery at ${curSoc}% (below ${threshold}%)`, { soc: curSoc }, rule.actions as Action[] | undefined);
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
        }, rule.actions as Action[] | undefined);
        return;
      }
    }
    return;
  }

  if (when === "sentry_event") {
    // normalizeSentryState vocabulary: off | idle | armed | aware | panic.
    // Only aware/panic are real trigger events (someone near the car / an
    // impact) -- arming transitions are routine and must not page.
    const TRIGGERED = new Set(["aware", "panic"]);
    const before = String(previous.sentry ?? "");
    const after = String(current.sentry ?? "");
    if (TRIGGERED.has(after) && !TRIGGERED.has(before)) {
      if (await underCooldown(env, rule, 10)) return;
      await fire(env, rule, "alert", `${rule.vin} Sentry ${after === "panic" ? "PANIC" : "event"} — the car was just disturbed`, {
        sentry: after, lat: asNum(current.lat), lon: asNum(current.lon),
      }, rule.actions as Action[] | undefined);
    }
    return;
  }

  if (when === "port_open_not_plugged") {
    // Needs persistence, not a transition: door open + latch disengaged +
    // nothing connected, sustained for open_minutes (default 10) -- a KV
    // timer started on first sighting and cleared whenever the condition
    // breaks (plugged in, door closed, or driving off).
    const openNow =
      current.charge_port_door_open === true &&
      String(current.charge_port_latch ?? "") !== "ChargePortLatchEngaged" &&
      String(current.charging_state ?? "") === "Disconnected";
    const key = `port_open_since:${rule.id}:${rule.vin}`;
    if (!openNow) {
      await env.TESLA_KV.delete(key);
      return;
    }
    const nowS = Math.floor(Date.now() / 1000);
    const sinceRaw = await env.TESLA_KV.get(key);
    if (!sinceRaw) {
      await env.TESLA_KV.put(key, String(nowS), { expirationTtl: 24 * 3600 });
      return;
    }
    const openMinutes = asNum(rule.open_minutes) ?? 10;
    if (nowS - Number(sinceRaw) < openMinutes * 60) return;
    if (await underCooldown(env, rule, 120)) return;
    await fire(env, rule, "alert", `${rule.vin} charge port has been open ${openMinutes}+ min without a cable`, {
      since: Number(sinceRaw),
    }, rule.actions as Action[] | undefined);
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
      }, rule.actions as Action[] | undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Cron-path evaluation
// ---------------------------------------------------------------------------

export async function runCronTick(env: Env): Promise<Record<string, unknown>> {
  // Lock so the 15-min cron and an on-demand run_automations_now can't overlap
  // and double-execute commands. Lives in D1 app_state (timestamp-expiry, 120s)
  // rather than KV: D1 is strongly consistent AND this avoids burning 2 KV
  // writes per tick against the 1,000/day free cap.
  const LOCK_KEY = "tick_lock";
  const now = Math.floor(Date.now() / 1000);
  const held = Number((await getAppState(env, LOCK_KEY).catch(() => "0")) ?? "0");
  if (held && now - held < 120) return { skipped: "another automation tick is in progress" };
  await putAppState(env, LOCK_KEY, String(now));
  try {
    return await runCronTickInner(env);
  } finally {
    await putAppState(env, LOCK_KEY, "0").catch(() => {});
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
        case "ai_brief":
          if (await evalAiBrief(env, rule)) fired.push(rule.id);
          break;
        case "sentinel":
          if (await evalSentinel(env, rule)) fired.push(rule.id);
          break;
        case "alert":
          // Ingest-path alerts are transition-driven; only the deadline check
          // belongs on the clock.
          if (await evalCronAlert(env, rule)) fired.push(rule.id);
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

  // Close sessions orphaned by a mid-drive/mid-charge signal loss — without
  // this, the next sample days later becomes the "end" of a bogus mega-drive.
  try {
    const closed = await closeStaleSessions(env);
    if (closed.closed_drives || closed.closed_charges) summary.stale_closed = closed;
  } catch (e) {
    summary.stale_close_error = e instanceof Error ? e.message : String(e);
  }

  await pollWatchdog(env, summary);
  await budgetWatchdog(env, summary);
  await manageTelemetryLadder(env, summary);
  // Generate AI coach notes for recently-closed drives that don't have one.
  try {
    const n = await backfillCoachNotes(env);
    if (n > 0) summary.coach_notes = n;
  } catch { /* AI is best-effort */ }
  await purgeExpiredHistory(env, summary);
  await compactOldHistory(env, summary);
  return summary;
}

/**
 * ai_brief rule: once per configured cadence, generate a one-sentence briefing
 * from the month's derivations via Workers AI and push it through the normal
 * notify/webhook path. Edge-triggered by a daily key so it never spams; skips
 * silently when the model has nothing noteworthy to say (generateBrief → null).
 */
async function evalAiBrief(env: Env, rule: AutomationRule): Promise<boolean> {
  const everyHours = asNum(rule.every_hours) ?? 24;
  const key = `aibrief:${rule.id}`;
  const last = Number((await getAppState(env, key).catch(() => "0")) ?? "0");
  const now = Math.floor(Date.now() / 1000);
  if (now - last < everyHours * 3600) return false;
  const line = await generateBrief(env, rule.vin).catch(() => null);
  await putAppState(env, key, String(now)).catch(() => {});
  if (!line) return false;
  await dispatchWebhooks(env, rule, "ai_brief", line, { brief: line });
  return true;
}

/**
 * sentinel rule: statistical-process-control alerts over signals we already
 * compute but never acted on — a slow tyre leak, a phantom-drain regression,
 * abnormal awake-idle drain. Fires through the existing alert/webhook path,
 * cooldown-guarded so a persisting condition alerts once, not every tick.
 */
async function evalSentinel(env: Env, rule: AutomationRule): Promise<boolean> {
  let fired = false;
  // Tyre slow-leak: any wheel losing pressure faster than the threshold/week.
  const leakBar = asNum(rule.leak_bar_per_week) ?? 0.15;
  const tires = (await getTirePressures(env, rule.vin, 30).catch(() => null)) as
    | { trend_bar_per_week?: Record<string, number> | null; latest?: Record<string, number> | null }
    | null;
  const trend = tires?.trend_bar_per_week;
  if (trend) {
    for (const w of ["fl", "fr", "rl", "rr"] as const) {
      if (typeof trend[w] === "number" && trend[w]! <= -leakBar) {
        if (!(await underCooldown(env, rule, 1440, `tyre:${w}`))) {
          await fire(env, rule, "sentinel", `${rule.vin} ${w.toUpperCase()} tyre losing ${Math.abs(trend[w]!).toFixed(2)} bar/week — likely a slow leak`, { wheel: w, trend_bar_per_week: trend[w] });
          fired = true;
        }
      }
    }
  }
  // Phantom-drain regression: awake-idle drain far above the sleep baseline.
  const vamp = (await getVampireDrain(env, rule.vin, 21).catch(() => null)) as
    | { awake?: { pct_per_day?: number | null } | null; sleep?: { pct_per_day?: number | null } | null }
    | null;
  const awake = vamp?.awake?.pct_per_day;
  const maxAwake = asNum(rule.max_awake_pct_per_day) ?? 8;
  if (typeof awake === "number" && awake >= maxAwake) {
    if (!(await underCooldown(env, rule, 1440, "drain"))) {
      await fire(env, rule, "sentinel", `${rule.vin} awake-idle drain ${awake.toFixed(1)}%/day (Sentry/preconditioning?) — well above a healthy sleep baseline`, { awake_pct_per_day: awake });
      fired = true;
    }
  }
  return fired;
}

/** Generates coach notes for up to N recent drives that lack one (best-effort). */
async function backfillCoachNotes(env: Env, limit = 3): Promise<number> {
  if (!env.AI) return 0;
  const rs = await env.DB.prepare(
    `SELECT * FROM drives WHERE status = 'complete' AND coach_note IS NULL AND behavior_score IS NOT NULL
     ORDER BY end_ts DESC LIMIT ?1`,
  ).bind(limit).all<Record<string, unknown>>();
  let n = 0;
  for (const drive of rs.results ?? []) {
    const note = await generateCoachNote(env, drive).catch(() => null);
    if (note) {
      await env.DB.prepare(`UPDATE drives SET coach_note = ?2 WHERE id = ?1`).bind(drive.id, note).run().catch(() => {});
      n++;
    } else {
      // Mark as attempted (empty string) so we don't retry a note-less drive forever.
      await env.DB.prepare(`UPDATE drives SET coach_note = '' WHERE id = ?1`).bind(drive.id).run().catch(() => {});
    }
  }
  return n;
}

/**
 * Dead-man's switch: pollOnce() stamps poll_ok_ts on EVERY cycle (even free
 * connectivity-only ones), so a stale stamp means the GH-Actions poll loop
 * itself is dead — disabled workflow, revoked token, outage — regardless of
 * whether the car is asleep. Logged to the alert log (visible on the
 * dashboard) at most once per 6h; the tick workflow independently turns the
 * same signal into a red run + GitHub notification email via /health.
 */
async function pollWatchdog(env: Env, summary: Record<string, unknown>): Promise<void> {
  const STALE_S = 2 * 3600;
  const COOLDOWN_S = 6 * 3600;
  try {
    const rs = await env.DB.prepare(
      `SELECT key, value FROM app_state WHERE key LIKE 'poll_ok_ts:%'`,
    ).all<{ key: string; value: string }>();
    const now = Math.floor(Date.now() / 1000);
    const stale: string[] = [];
    for (const r of rs.results ?? []) {
      const age = now - Number(r.value);
      if (Number.isFinite(age) && age > STALE_S) stale.push(`${r.key.slice("poll_ok_ts:".length).slice(-6)} (${Math.round(age / 60)}m)`);
    }
    if (!stale.length) return;
    summary.poll_watchdog_stale = stale;
    const last = Number((await getAppState(env, "watchdog_alert_ts")) ?? "0");
    if (now - last < COOLDOWN_S) return;
    await putAppState(env, "watchdog_alert_ts", String(now));
    await logAlert(env, {
      ruleId: "poll_watchdog",
      kind: "watchdog",
      message: `Polling appears DEAD (no /poll/now in >2h) for: ${stale.join(", ")} — check the tesla-poll GitHub Action`,
      delivered: false,
    });
  } catch {
    /* watchdog must never break the tick */
  }
}

/**
 * Budget watchdog: an alert-log entry (dashboard-visible, same channel as the
 * poll watchdog) when month-to-date spend crosses 95% of BUDGET_POLL_USD.
 * Streaming signal spend can't be stopped worker-side, so this is the
 * early-warning layer in front of the $9.70 hard ceiling and Tesla's own
 * $10 suspend — it catches a runaway (bridge outage double-posting, a burst
 * of billed reads) while there's still headroom. At most once per 24h;
 * exported for tests.
 */
export async function budgetWatchdog(env: Env, summary: Record<string, unknown>): Promise<void> {
  try {
    const b = await getBudgetStatus(env);
    const budgetMicro = Math.round(b.poll_budget_usd * 1_000_000);
    if (budgetMicro <= 0) return;
    const pct = (b.spent_micro / budgetMicro) * 100;
    summary.budget_watchdog = { spent_usd: b.spent_usd, cap_usd: b.poll_budget_usd };

    // State: "<month> <lastAlertedThreshold> <forecastStreak>" -- resets when
    // the month rolls over. Graduated crossing alerts replace the old flat
    // 95%+24h-cooldown rule, which by design could only fire once the month
    // was already lost (July 2026: first alert at 97%, drained next day).
    const raw = (await getAppState(env, "budget_alert_state").catch(() => null)) ?? "";
    const [m, thrRaw, fcRaw] = raw.split(" ");
    let lastThr = m === b.month ? Number(thrRaw) || 0 : 0;
    let fcStreak = m === b.month ? Number(fcRaw) || 0 : 0;

    const crossed = [50, 75, 90, 100].filter((t) => pct >= t && t > lastThr).pop();
    if (crossed) {
      lastThr = crossed;
      await logAlert(env, {
        ruleId: "budget_watchdog",
        kind: "budget",
        message:
          `Tesla API spend crossed ${crossed}% of the $${b.poll_budget_usd} monthly cap ` +
          `($${b.spent_usd.toFixed(2)} MTD). Automated polling stops at the cap; streaming ` +
          `continues up to the $${b.hard_ceiling_usd} ceiling and Tesla suspends (never ` +
          `charges) past $10. Everything resets on the 1st.`,
        delivered: false,
      });
    }

    // Predictive: the forecast regression already knows when the current burn
    // rate lands before month-end -- in July it knew ~10 days before the
    // drain, but nothing consulted it. Two consecutive ticks of hysteresis so
    // a single heavy road-trip day doesn't page.
    const f = pct < 100 ? await getBudgetForecast(env).catch(() => null) : null;
    if (f && f.budget_exhausted_in_days != null) {
      fcStreak += 1;
      if (fcStreak === 2) {
        const top = (await getBudgetCallLog(env, 7).catch(() => null))?.by_kind?.[0];
        await logAlert(env, {
          ruleId: "budget_watchdog",
          kind: "budget",
          message:
            `At the current burn rate the Tesla API budget runs out in ~${Math.round(f.budget_exhausted_in_days)} ` +
            `days -- before month-end. Top spender last 7 days: ${top ? `${top.label} ($${top.cost_usd.toFixed(2)})` : "unknown"}. ` +
            `The telemetry plan ladder will step fidelity down automatically if this persists.`,
          delivered: false,
        });
      }
    } else {
      fcStreak = 0;
    }

    await putAppState(env, "budget_alert_state", `${b.month} ${lastThr} ${fcStreak}`);
  } catch {
    /* watchdog must never break the tick */
  }
}

// ---------------------------------------------------------------------------
// Telemetry plan ladder — automatic fidelity degradation before the wall
// ---------------------------------------------------------------------------

/**
 * Pure ladder decision (exported for tests). Steps only DOWN within a month
 * (spend is monotonic; auto-upgrading mid-month would flap), and restores the
 * permanent plan when the month rolls over -- which also replaces the manual
 * "restore on the 1st" chore. pct is spend as % of the poll cap.
 */
export function nextTelemetryPlanStep(
  month: string,
  storedRaw: string | null,
  pct: number,
): TelemetryPlanStep | null {
  const [m, stored] = (storedRaw ?? "").split(" ");
  const current = m === month ? (stored as TelemetryPlanStep) : null;
  let target: TelemetryPlanStep = current ?? "permanent";
  if (pct >= 90) target = "minimal";
  else if (pct >= 75 && current !== "minimal") target = "lean";
  if (current === "minimal") target = "minimal"; // never upgrade mid-month
  else if (current === "lean" && target === "permanent") target = "lean";
  return target !== current ? target : null;
}

/**
 * Applies the ladder: reads spend, decides via nextTelemetryPlanStep, pushes
 * the new field plan to the vehicle(s) when the step changes, and alerts on
 * every transition. The July 2026 trim was this exact operation done by hand;
 * budget.ts's own header notes that exceeding the credit WIPES the telemetry
 * config -- stepping down before the ceiling protects stream continuity, not
 * just dollars. Apply failures are swallowed and retried next tick (the car
 * syncs the config whenever it comes online; the POST itself can fail past
 * the command ceiling).
 */
export async function manageTelemetryLadder(env: Env, summary: Record<string, unknown>): Promise<void> {
  try {
    const vins = (env.POLL_VINS ?? "").split(/[,\s]+/).map((v) => v.trim()).filter(Boolean);
    if (!vins.length) return;
    const b = await getBudgetStatus(env);
    const budgetMicro = Math.round(b.poll_budget_usd * 1_000_000);
    if (budgetMicro <= 0) return;
    const pct = (b.spent_micro / budgetMicro) * 100;
    const stored = await getAppState(env, "telemetry_plan_state").catch(() => null);
    const target = nextTelemetryPlanStep(b.month, stored, pct);
    if (!target) return;
    await createTelemetryConfig(env, {
      vins,
      config: {
        hostname: TELEMETRY_HOSTNAME,
        port: TELEMETRY_PORT,
        ca: TELEMETRY_CA,
        fields: TELEMETRY_PLANS[target],
      },
    });
    await putAppState(env, "telemetry_plan_state", `${b.month} ${target}`);
    summary.telemetry_plan = target;
    await logAlert(env, {
      ruleId: "telemetry_ladder",
      kind: "budget",
      message:
        `Telemetry plan stepped to "${target}" (${Object.keys(TELEMETRY_PLANS[target]).length} fields) ` +
        `at ${Math.round(pct)}% of the monthly cap. ` +
        (target === "permanent"
          ? "Monthly reset -- full steady-state fidelity restored."
          : "Fidelity reduced to keep the stream alive inside the $10 credit; restores automatically on the 1st."),
      delivered: false,
    });
  } catch {
    /* ladder must never break the tick; retried next tick */
  }
}

/**
 * Raw-history retention (RETENTION_DAYS env var; default 400 days, set "0" to
 * keep forever). Only the bulky raw stores are pruned: the generic
 * telemetry_events EAV table and positions NOT attached to a drive (idle
 * samples). Derived history — drives, charge sessions + curves, state
 * timeline — and drive-route positions are never touched: they are the
 * long-term value (degradation trends need years) and grow far slower than
 * raw samples. The default keeps D1 well under its 5 GB free cap even at
 * burst/streaming cadence.
 */
async function purgeExpiredHistory(env: Env, summary: Record<string, unknown>): Promise<void> {
  const raw = env.RETENTION_DAYS;
  const days = raw === undefined || raw === "" ? 400 : Number(raw);
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = Math.floor(Date.now() / 1000) - Math.round(days * 86400);
  try {
    const events = await env.DB.prepare(`DELETE FROM telemetry_events WHERE ts < ?1`).bind(cutoff).run();
    const positions = await env.DB.prepare(
      `DELETE FROM positions WHERE ts < ?1 AND drive_id IS NULL`,
    ).bind(cutoff).run();
    const purged = (events.meta.changes ?? 0) + (positions.meta.changes ?? 0);
    if (purged > 0) summary.purged_rows = purged;
  } catch (e) {
    summary.purge_error = e instanceof Error ? e.message : String(e);
  }
}

/** How many not-yet-compacted drives/sessions to process per tick — bounds a single cron invocation's D1 round-trips. */
const COMPACT_BATCH = 100;

/**
 * Decimates one drive's `positions` rows (or one charge session's `charges`
 * rows) down to `target`, keeping the first row, the last row, and an evenly
 * spaced selection in between — a route/curve driven a year ago rarely needs
 * every ~10s sample to still be useful, just its shape. Returns rows removed.
 * No-ops (but still marks compacted) when there's nothing to trim.
 */
async function decimateSeries(
  env: Env,
  table: "positions" | "charges",
  fkColumn: "drive_id" | "session_id",
  fkValue: number,
  target: number,
): Promise<number> {
  const countRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${fkColumn} = ?1`)
    .bind(fkValue)
    .first<{ n: number }>();
  const n = countRow?.n ?? 0;
  if (n <= target) return 0;
  const step = Math.ceil(n / target);
  const res = await env.DB.prepare(
    `DELETE FROM ${table}
     WHERE ${fkColumn} = ?1
     AND id NOT IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY ts ASC) AS rn
         FROM ${table} WHERE ${fkColumn} = ?1
       )
       WHERE rn = 1 OR rn = ?2 OR (rn - 1) % ?3 = 0
     )`,
  )
    .bind(fkValue, n, step)
    .run();
  return res.meta.changes ?? 0;
}

/**
 * Storage compaction (COMPACT_AFTER_DAYS env var; default 365 days, set "0"
 * to disable). Unlike purgeExpiredHistory above, this never DELETES a drive
 * or charge session — the summary row (distance, energy, cost, behavior
 * score, degradation samples, etc.) is the long-term "essence" and stays
 * forever. It only thins the attached raw time-series (route positions /
 * charge curve samples) for old, completed drives and sessions down to a
 * fixed point budget, so a route/curve is still viewable — just at lower
 * resolution — instead of being either kept at full density forever or
 * deleted outright. Batched and marked (`positions_compacted` /
 * `curve_compacted`) so a fixed-size slice of the backlog is done per tick
 * rather than rescanning everything every time.
 */
export async function compactOldHistory(env: Env, summary: Record<string, unknown> = {}): Promise<void> {
  const rawDays = env.COMPACT_AFTER_DAYS;
  const days = rawDays === undefined || rawDays === "" ? 365 : Number(rawDays);
  if (!Number.isFinite(days) || days <= 0) return;
  const cutoff = Math.floor(Date.now() / 1000) - Math.round(days * 86400);
  const maxPoints = Math.max(10, Math.round(Number(env.COMPACT_MAX_POINTS) || 60));
  const maxChargePoints = Math.max(10, Math.round(maxPoints / 2));

  try {
    const drives = await env.DB.prepare(
      `SELECT id FROM drives
       WHERE status = 'complete' AND start_ts < ?1 AND (positions_compacted IS NULL OR positions_compacted = 0)
       ORDER BY start_ts ASC LIMIT ?2`,
    )
      .bind(cutoff, COMPACT_BATCH)
      .all<{ id: number }>();

    let positionsRemoved = 0;
    for (const d of drives.results ?? []) {
      positionsRemoved += await decimateSeries(env, "positions", "drive_id", d.id, maxPoints);
      await env.DB.prepare(`UPDATE drives SET positions_compacted = 1 WHERE id = ?1`).bind(d.id).run();
    }

    const sessions = await env.DB.prepare(
      `SELECT id FROM charge_sessions
       WHERE status = 'complete' AND start_ts < ?1 AND (curve_compacted IS NULL OR curve_compacted = 0)
       ORDER BY start_ts ASC LIMIT ?2`,
    )
      .bind(cutoff, COMPACT_BATCH)
      .all<{ id: number }>();

    let chargePointsRemoved = 0;
    for (const s of sessions.results ?? []) {
      chargePointsRemoved += await decimateSeries(env, "charges", "session_id", s.id, maxChargePoints);
      await env.DB.prepare(`UPDATE charge_sessions SET curve_compacted = 1 WHERE id = ?1`).bind(s.id).run();
    }

    if ((drives.results?.length ?? 0) || (sessions.results?.length ?? 0)) {
      summary.compacted = {
        drives: drives.results?.length ?? 0,
        positions_removed: positionsRemoved,
        sessions: sessions.results?.length ?? 0,
        charge_points_removed: chargePointsRemoved,
      };
    }
  } catch (e) {
    summary.compact_error = e instanceof Error ? e.message : String(e);
  }
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
    // Automated polls stop at the POLL budget, not the command ceiling — the
    // $0.70 band above it is reserved for user-initiated commands. (pollOnce
    // already gates on poll_allowed; this closes the same gate on the cron
    // path, which otherwise billed up to the ceiling via getVehicleData.)
    const budget = await getBudgetStatus(env);
    if (!budget.poll_allowed) return { latest, fresh: false, polled: false };
    const vd = await getVehicleData(env, rule.vin, ["charge_state", "climate_state", "drive_state", "location_data", "vehicle_state"]);
    return { latest: await applyVehicleData(env, rule.vin, vd), fresh: true, polled: true };
  }
  return { latest, fresh: false, polled: false };
}

const PLUGGED_STATES = new Set(["Charging", "Starting", "Stopped", "Complete", "NoPower"]);

/**
 * Cron-side alert: "not ready by a deadline". Crossing-edge alerts like
 * soc_below can never fire for a battery that was ALREADY low, so a car
 * sitting at 45% all Thursday would sail silently into a Friday road trip.
 * Rule: {when:"not_ready_by", by:"HH:MM", days?:[0-6], min_soc, warn_minutes?}.
 * Fires once per day inside the [by - warn_minutes, by) window when SoC is
 * under min_soc and the car isn't charging. Exported for tests.
 */
export async function evalCronAlert(env: Env, rule: AutomationRule): Promise<boolean> {
  if (String(rule.when ?? "") !== "not_ready_by") return false;
  const by = String(rule.by ?? "");
  const m = /^(\d{1,2}):(\d{2})$/.exec(by);
  if (!m) return false;
  const minSoc = asNum(rule.min_soc) ?? 60;
  const warnMin = asNum(rule.warn_minutes) ?? 120;

  const tz = ruleTzOffsetMin(env, rule);
  const local = new Date(Date.now() + tz * 60_000);
  const days = rule.days as number[] | undefined;
  if (days && !days.includes(local.getUTCDay())) return false;
  const nowMin = local.getUTCHours() * 60 + local.getUTCMinutes();
  const byMin = Number(m[1]) * 60 + Number(m[2]);
  if (!(nowMin >= byMin - warnMin && nowMin < byMin)) return false;

  const latest = await getLatest(env, rule.vin).catch(() => null);
  const soc = asNum(latest?.soc);
  if (soc === undefined || soc >= minSoc) return false;
  if (String(latest?.charging_state ?? "") === "Charging") return false;

  const dateKey = `${local.getUTCFullYear()}-${local.getUTCMonth() + 1}-${local.getUTCDate()}`;
  if (await underCooldown(env, rule, 720, dateKey)) return false;
  await fire(env, rule, "alert", `${rule.vin} is at ${soc}% but should be ${minSoc}%+ by ${by} — not charging`, {
    soc, min_soc: minSoc, by,
  }, rule.actions as Action[] | undefined);
  return true;
}

/**
 * Clock-schedule tariff window for price_charging: {days?, start, end} in the
 * rule's timezone ("HH:MM" each, end exclusive; overnight windows like
 * 23:00-07:00 wrap). Israel's TAOZ — and most non-spot tariffs — are FIXED
 * clock schedules, so requiring a live price feed made the single most
 * valuable charging automation unconfigurable for them.
 */
export interface TouWindow {
  days?: number[]; // 0=Sunday..6=Saturday, default all
  start: string;
  end: string;
}

/** True when local time (per tzOffsetMin) falls inside any window (exported for tests). */
export function inTouWindow(windows: TouWindow[], nowUtcMs: number, tzOffsetMin: number): boolean {
  const local = new Date(nowUtcMs + tzOffsetMin * 60_000);
  const day = local.getUTCDay();
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const toMin = (hhmm: string): number => {
    const [h, m] = hhmm.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  for (const w of windows) {
    const start = toMin(w.start);
    const end = toMin(w.end);
    const wraps = end <= start;
    // For an overnight window the pre-midnight leg belongs to the START day
    // and the post-midnight leg to the following day.
    const inToday = wraps ? minutes >= start : minutes >= start && minutes < end;
    const inYesterdayTail = wraps && minutes < end;
    const dayOk = (d: number) => !w.days || w.days.includes(d);
    if ((inToday && dayOk(day)) || (inYesterdayTail && dayOk((day + 6) % 7))) return true;
  }
  return false;
}

async function evalPriceCharging(
  env: Env,
  rule: AutomationRule,
  online: boolean,
  state: CronState,
): Promise<boolean> {
  if (!online || !state.fresh || !state.latest) return false;
  const chargingState = String(state.latest.charging_state ?? "");
  if (!PLUGGED_STATES.has(chargingState)) return false; // not plugged in — nothing to control

  const charging = chargingState === "Charging" || chargingState === "Starting";
  const tou = rule.tou_windows as TouWindow[] | undefined;

  // Classify the price regime and act only when it changes (edge-trigger),
  // so a price that stays cheap for hours doesn't re-command + re-notify every
  // 15-min tick. Two regime sources: tou_windows (clock schedule, no feed,
  // works stream-only) or a live price feed — windows win when both are set.
  let regime = "neutral";
  let detail = "";
  if (tou?.length) {
    const cheap = inTouWindow(tou, Date.now(), ruleTzOffsetMin(env, rule));
    regime = cheap ? "cheap" : "expensive";
    detail = cheap ? "inside a cheap tariff window" : "outside the cheap tariff windows";
  } else {
    const price = await fetchNumber(rule.feed as FeedSource);
    const cheapBelow = asNum(rule.cheap_below_cents);
    const expensiveAbove = asNum(rule.expensive_above_cents);
    if (cheapBelow !== undefined && price <= cheapBelow) regime = "cheap";
    else if (expensiveAbove !== undefined && price >= expensiveAbove) regime = "expensive";
    detail = regime === "cheap" ? `price ${price}c ≤ ${cheapBelow}c` : `price ${price}c ≥ ${expensiveAbove}c`;
  }
  if (!(await regimeChanged(env, rule, `price:${regime}`))) return false;

  if (regime === "cheap") {
    const amps = asNum(rule.amps_cheap);
    const limit = asNum(rule.limit_cheap);
    if (amps) await cmd.setChargingAmps(env, rule.vin, amps);
    if (limit) await cmd.setChargeLimit(env, rule.vin, limit);
    if (!charging) await cmd.startCharging(env, rule.vin);
    await dispatchWebhooks(env, rule, "price_charging", `${detail} — charging at ${amps ?? "current"}A`, {});
    return true;
  }
  if (regime === "expensive" && charging) {
    await cmd.stopCharging(env, rule.vin);
    await dispatchWebhooks(env, rule, "price_charging", `${detail} — stopped charging`, {});
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
  const tz = ruleTzOffsetMin(env, rule);
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
