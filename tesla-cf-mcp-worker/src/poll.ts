/**
 * Adaptive vehicle poller — the mechanism that gives TeslaMate-grade history
 * without streaming infrastructure. TeslaMate itself records by polling every
 * few seconds while the car is active; this does the same, driven externally
 * (a GitHub Actions loop calls /poll/now repeatedly and honors the returned
 * interval), so no always-on server or Durable Object is required.
 *
 * Invariants preserved from the rest of the worker:
 *   - NEVER wakes the vehicle. When it's asleep/offline we do only the free
 *     connectivity check and record the state; we never call vehicle_data
 *     (which requires — and can prolong — an online car).
 *   - Billed vehicle_data reads happen only while the car is already online.
 *   - When the car has been idle-online for a while we back off so it can
 *     fall asleep (mirrors TeslaMate's suspend logic), capping standby cost.
 */

import { getVehicle, getVehicleData } from "./api";
import { applyVehicleData } from "./ingest";
import { deriveActivity, recordConnectivityState } from "./tracking";
import { Env } from "./types";

export interface PollResult {
  vin: string;
  state: string; // online | asleep | offline | unknown
  activity: string; // driving | charging | idle | asleep | offline
  polled: boolean; // whether a billed vehicle_data read happened
  active: boolean; // caller should keep looping at next_interval_s
  next_interval_s: number;
  soc?: number | null;
}

// Poll cadences (seconds). Driving is the finest so drive routes/speed curves
// have resolution; charging is coarser (the curve moves slowly); idle-online
// is a watch cadence until the car sleeps.
const INTERVAL_DRIVING = 10;
const INTERVAL_CHARGING = 30;
const INTERVAL_IDLE = 60;
const INTERVAL_SLEEP = 180;
/** After this many idle-online minutes, stop polling so the car can sleep. */
const IDLE_SUSPEND_MIN = 12;

const POLL_STATE = (vin: string) => `poll_state:${vin}`;

export async function pollOnce(env: Env, vin: string): Promise<PollResult> {
  const now = Math.floor(Date.now() / 1000);

  // 1. Free connectivity check — never wakes.
  let state = "unknown";
  try {
    const v = await getVehicle(env, vin);
    state = v.state;
  } catch {
    state = "unknown";
  }

  // 2. Not online → record the timeline state, do NOT poll data, back off.
  if (state !== "online") {
    await recordConnectivityState(env, vin, state).catch(() => {});
    return { vin, state, activity: state, polled: false, active: false, next_interval_s: INTERVAL_SLEEP };
  }

  // 3. Online → one billed vehicle_data read, folded through the same
  //    ingest → derivation pipeline the telemetry sink uses. The car can drop
  //    offline between the connectivity check and here — treat that as asleep
  //    rather than erroring (getVehicleData throws a 408 in that case).
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

  const pollState = (await env.TESLA_KV.get<{ last_active_ts: number }>(POLL_STATE(vin), "json")) ?? null;

  if (activity === "driving" || activity === "charging") {
    await env.TESLA_KV.put(POLL_STATE(vin), JSON.stringify({ last_active_ts: now }));
    return {
      vin, state, activity, polled: true, active: true, soc,
      next_interval_s: activity === "driving" ? INTERVAL_DRIVING : INTERVAL_CHARGING,
    };
  }

  // idle-online: watch briefly, then suspend so the car can sleep.
  const lastActive = pollState?.last_active_ts ?? now;
  if (pollState === null) await env.TESLA_KV.put(POLL_STATE(vin), JSON.stringify({ last_active_ts: now }));
  const idleMin = (now - lastActive) / 60;
  const suspend = idleMin >= IDLE_SUSPEND_MIN;
  return {
    vin, state, activity: "idle", polled: true, soc,
    active: !suspend,
    next_interval_s: suspend ? INTERVAL_SLEEP : INTERVAL_IDLE,
  };
}
