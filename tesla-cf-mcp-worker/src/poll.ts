/**
 * Budget-governed adaptive vehicle poller.
 *
 * Records TeslaMate-style history from the official Fleet API while
 * guaranteeing the account never exceeds its free $10/month credit (with no
 * payment method, Tesla hard-disables the app past the credit — the governor
 * in budget.ts stops us well before that line).
 *
 * How the budget is spent (see budget.ts for prices):
 *   - Connectivity checks (GET /vehicles/{id}) are FREE — they drive the
 *     online/asleep timeline and cost nothing, so they run every cycle.
 *   - Billed vehicle_data reads happen only when the car is online AND the
 *     monthly poll budget has headroom, at an adaptive cadence:
 *       driving ~30s · charging ~90s · recently-active idle ~60s
 *   - After ~12 idle minutes we SUSPEND billed reads (the car can sleep) and
 *     fall back to a cheap probe every 15 min — needed because a car with
 *     Sentry on stays "online" forever, so connectivity alone can't reveal a
 *     drive starting. Optional QUIET_HOURS_UTC pauses even those probes.
 *   - When the poll budget is exhausted, ONLY free checks continue; billed
 *     reads resume automatically on the 1st.
 *
 * Never wakes the vehicle, under any circumstances.
 */

import { getVehicle, getVehicleData } from "./api";
import { getBudgetStatus } from "./budget";
import { applyVehicleData } from "./ingest";
import { deriveActivity, recordConnectivityState } from "./tracking";
import { Env } from "./types";

export interface PollResult {
  vin: string;
  state: string; // online | asleep | offline | unknown
  activity: string; // driving | charging | idle | asleep | offline | budget_exhausted | quiet
  polled: boolean; // whether a billed vehicle_data read happened
  active: boolean; // caller should keep looping at next_interval_s
  next_interval_s: number;
  soc?: number | null;
  budget_spent_usd?: number;
}

// Tuned for LOGGING/analysis over real-time: coarser per-drive sampling (still
// ample to reconstruct routes, efficiency, charge curves) buys far more
// coverage-hours per month within the free budget. A 60s driving point is
// ~every 250m-1km — a recognizable route — at ~half the cost of 30s.
const INTERVAL_DRIVING = 60;
const INTERVAL_CHARGING = 150;
const INTERVAL_IDLE = 90;
const INTERVAL_SLEEP = 300;
/** After this many idle-online minutes, stop per-minute reads (car can sleep). */
const IDLE_SUSPEND_MIN = 12;
/** While suspended-but-online (e.g. Sentry keeps the car awake), probe this often. */
const PROBE_INTERVAL_S = 15 * 60;

const POLL_STATE = (vin: string) => `poll_state:${vin}`;

interface PollState {
  last_active_ts?: number;
  last_probe_ts?: number;
}

/** True inside the configured billed-probe quiet window (UTC hours "start-end"). */
export function inQuietHours(spec: string | undefined, utcHour: number): boolean {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(spec ?? "");
  if (!m) return false;
  const start = Number(m[1]) % 24;
  const end = Number(m[2]) % 24;
  if (start === end) return false;
  return start < end ? utcHour >= start && utcHour < end : utcHour >= start || utcHour < end;
}

export async function pollOnce(env: Env, vin: string): Promise<PollResult> {
  const now = Math.floor(Date.now() / 1000);

  // 1. FREE connectivity check — never wakes, feeds the state timeline.
  let state = "unknown";
  try {
    const v = await getVehicle(env, vin);
    state = v.state;
  } catch {
    state = "unknown";
  }
  if (state !== "online") {
    await recordConnectivityState(env, vin, state).catch(() => {});
    return { vin, state, activity: state, polled: false, active: false, next_interval_s: INTERVAL_SLEEP };
  }

  // 2. Budget gate — when the monthly poll budget is spent, stay free-only.
  const budget = await getBudgetStatus(env);
  if (!budget.poll_allowed) {
    await recordConnectivityState(env, vin, state).catch(() => {});
    return {
      vin, state, activity: "budget_exhausted", polled: false, active: false,
      next_interval_s: INTERVAL_SLEEP, budget_spent_usd: budget.spent_usd,
    };
  }

  // 3. Suspension: idle long enough that we only probe occasionally.
  const ps = ((await env.TESLA_KV.get<PollState>(POLL_STATE(vin), "json")) ?? {}) as PollState;
  const idleMin = ps.last_active_ts != null ? (now - ps.last_active_ts) / 60 : null;
  const suspended = idleMin != null && idleMin >= IDLE_SUSPEND_MIN;
  if (suspended) {
    const probeDue = now - (ps.last_probe_ts ?? 0) >= PROBE_INTERVAL_S;
    const quiet = inQuietHours(env.QUIET_HOURS_UTC, new Date().getUTCHours());
    if (!probeDue || quiet) {
      await recordConnectivityState(env, vin, "online").catch(() => {});
      return {
        vin, state, activity: quiet ? "quiet" : "idle", polled: false, active: false,
        next_interval_s: INTERVAL_SLEEP, budget_spent_usd: budget.spent_usd,
      };
    }
  }

  // 4. One billed vehicle_data read, folded through ingest → derivation.
  //    (The car can drop offline between the check and here — treat as asleep.)
  let vd: Record<string, unknown>;
  try {
    vd = await getVehicleData(env, vin, [
      "charge_state", "climate_state", "drive_state", "vehicle_state", "location_data", "vehicle_config",
    ]);
  } catch {
    await recordConnectivityState(env, vin, "asleep").catch(() => {});
    return { vin, state: "asleep", activity: "asleep", polled: false, active: false, next_interval_s: INTERVAL_SLEEP };
  }
  const current = await applyVehicleData(env, vin, vd);
  const activity = deriveActivity(current);
  const soc = typeof current.soc === "number" ? current.soc : null;

  if (activity === "driving" || activity === "charging") {
    await env.TESLA_KV.put(POLL_STATE(vin), JSON.stringify({ last_active_ts: now, last_probe_ts: now } satisfies PollState));
    return {
      vin, state, activity, polled: true, active: true, soc,
      next_interval_s: activity === "driving" ? INTERVAL_DRIVING : INTERVAL_CHARGING,
      budget_spent_usd: budget.spent_usd,
    };
  }

  // idle: refresh the probe stamp; keep last_active for the suspend clock.
  await env.TESLA_KV.put(
    POLL_STATE(vin),
    JSON.stringify({ last_active_ts: ps.last_active_ts ?? now, last_probe_ts: now } satisfies PollState),
  );
  return {
    vin, state, activity: "idle", polled: true, soc,
    active: !suspended,
    next_interval_s: suspended ? INTERVAL_SLEEP : INTERVAL_IDLE,
    budget_spent_usd: budget.spent_usd,
  };
}
