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
 *     monthly poll budget has headroom, at a BUDGET-PACED cadence:
 *       driving  → 10s when at/ahead of monthly pace, degrading 15→30→60s
 *                  as the month's budget tightens (pacedDrivingIntervalS)
 *       charging → 60s when ahead of pace, else 150s
 *       idle     → 90s while recently active
 *     10s driving samples are what make harsh-brake/accel detection real —
 *     at 60s a 3-second brake event is smeared to invisibility.
 *   - After ~12 idle minutes we SUSPEND billed reads (the car can sleep) and
 *     fall back to a cheap probe every 15 min — needed because a car with
 *     Sentry on stays "online" forever, so connectivity alone can't reveal a
 *     drive starting. Optional QUIET_HOURS_UTC pauses even those probes.
 *   - When the poll budget is exhausted, ONLY free checks continue; billed
 *     reads resume automatically on the 1st.
 *
 * Hot-path state (poll bookkeeping, liveness stamp) lives in D1 app_state,
 * not KV — the KV free tier's 1,000 writes/day would be exhausted by a single
 * hour of burst polling. The static vehicle_config endpoint is fetched at most
 * once per 30 days (it's immutable trim/options data; reads bill a flat unit
 * regardless, so this trims payload, not dollars).
 *
 * Never wakes the vehicle, under any circumstances.
 */

import { getVehicle, getVehicleData } from "./api";
import { getBudgetStatus, pacedChargingIntervalS, pacedDrivingIntervalS, pollBudgetMicro } from "./budget";
import { applyVehicleData } from "./ingest";
import { casAppState, getAppState, getLatest, putAppState } from "./store";
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

const INTERVAL_IDLE = 90;
const INTERVAL_SLEEP = 300;
/** While stream-covered and NOT currently driving, re-check this often (free
 *  connectivity check only) so a drive starting is discovered promptly —
 *  otherwise a short drive can start and finish entirely inside the 300s
 *  INTERVAL_SLEEP window before the scheduler ever wakes to notice. */
const STREAM_COVERED_IDLE_POLL_S = 30;
/** After this many idle-online minutes, stop per-minute reads (car can sleep). */
const IDLE_SUSPEND_MIN = 12;
/** While suspended-but-online (e.g. Sentry keeps the car awake), probe this often. */
const PROBE_INTERVAL_S = 15 * 60;
/** Re-fetch the (immutable) vehicle_config endpoint at most this often. */
const VCFG_REFRESH_S = 30 * 86400;
/**
 * Minimum seconds between BILLED reads across ALL pollers. Multiple pollers now
 * run (the DO alarm, the GitHub loop, an optional cron) — without this they'd
 * each bill during the same 10s driving window and burn 2-3× the budget. A
 * poller landing inside this window does only the free connectivity check. 8s
 * still permits the intended ~10s driving cadence.
 *
 * 8s alone only deduped the driving burst: at the slower paced cadences the
 * pollers interleave far apart (DO alarm at 90s, GH loop at 150s — every call
 * lands >8s from the other's), so BOTH billed at full rate, ~2x the intended
 * spend for every charging/idle-online hour. The gap therefore SCALES with
 * the last billed read's own paced interval (stamped next to its timestamp),
 * clamped to [MIN, MAX]: whichever poller fires first claims the slot, and
 * every other poller stays free until ~that interval has elapsed.
 */
const MIN_BILLED_GAP_S = 8;
/** Hard cap on the scaled gap — never lock billed reads out longer than this. */
const MAX_BILLED_GAP_S = 240;
/** Fraction of the last paced interval that must elapse before any poller may bill again. */
const BILLED_GAP_FRAC = 0.8;

/** Skip billed REST reads while the telemetry stream stamped liveness within this window
 *  (a hair over the slowest configured resend interval, 300s, so a healthy stream never flaps). */
const STREAM_FRESH_S = 330;
/** Even with a healthy stream, do one billed reconciliation read this often (odometer/full-snapshot drift). */
const RECONCILE_BILLED_S = 3600;
/**
 * Reconciliation gap while streaming shows the car DRIVING. PR #56 ran this
 * at the full 10-60s budget-paced driving cadence purely because motor power
 * was REST-only; power is now derived from streamed PackVoltage×PackCurrent
 * (derivePower in ingest.ts), so the billed read is back to being just an
 * odometer/full-snapshot drift check — 10 minutes keeps drive distances
 * honest at ~1/60th of the burst cost ($0.012/driving-hour vs $0.72).
 */
const DRIVING_RECONCILE_S = 600;

const POLL_STATE = (vin: string) => `poll_state:${vin}`;
const POLL_OK = (vin: string) => `poll_ok_ts:${vin}`;
const VCFG_TS = (vin: string) => `vcfg_ts:${vin}`;
const BILLED_TS = (vin: string) => `billed_ts:${vin}`;
const STREAM_OK = (vin: string) => `stream_ok_ts:${vin}`;

interface PollState {
  last_active_ts?: number;
  last_probe_ts?: number;
}

async function readPollState(env: Env, vin: string): Promise<PollState> {
  try {
    const raw = await getAppState(env, POLL_STATE(vin));
    if (raw) return JSON.parse(raw) as PollState;
    // Migration: pre-D1 deployments kept this in KV.
    return ((await env.TESLA_KV.get<PollState>(POLL_STATE(vin), "json")) ?? {}) as PollState;
  } catch {
    return {};
  }
}

/**
 * Liveness stamp for the dead-man's switch: every pollOnce() — even a free
 * connectivity-only cycle — stamps poll_ok. If this goes stale for hours the
 * GH-Actions loop itself is dead (disabled workflow, bad token, outage),
 * regardless of whether the car is asleep. Throttled to ≥60s between writes.
 */
async function stampPollAlive(env: Env, vin: string, now: number): Promise<void> {
  try {
    const prev = Number((await getAppState(env, POLL_OK(vin))) ?? "0");
    if (now - prev >= 60) await putAppState(env, POLL_OK(vin), String(now));
  } catch {
    /* liveness accounting must never break polling */
  }
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
  await stampPollAlive(env, vin, now);

  // 1. FREE connectivity check — never wakes, feeds the state timeline.
  //    A fresh telemetry stream OVERRIDES a non-online answer: the car is
  //    demonstrably awake and transmitting, so a thrown/timed-out check (or
  //    Tesla momentarily misreporting) must not stall every gate below for
  //    the 300s sleep interval — against 7-28 minute drives, one bad check
  //    could eat a large fraction of a drive's reconciliation window.
  const streamOk = Number((await getAppState(env, STREAM_OK(vin)).catch(() => "0")) ?? "0");
  const streamFresh = now - streamOk < STREAM_FRESH_S;
  let state = "unknown";
  try {
    const v = await getVehicle(env, vin);
    state = v.state;
  } catch {
    state = "unknown";
  }
  if (state !== "online") {
    if (!streamFresh) {
      await recordConnectivityState(env, vin, state).catch(() => {});
      return { vin, state, activity: state, polled: false, active: false, next_interval_s: INTERVAL_SLEEP };
    }
    state = "online"; // the stream is live data FROM the car; trust it over the check
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

  // 2a. Streaming-derived activity, computed once and used to bypass every
  //     gate below that was designed around REST's OWN staleness bookkeeping
  //     (ps.last_active_ts, billed_ts's stamped interval). Under telemetry-
  //     first, billed reads are rare, so that bookkeeping can go stale for
  //     hours or days -- but a car streaming "driving" RIGHT NOW must never
  //     be treated as suspended or throttled to a stale idle-era cadence,
  //     regardless of how out of date the REST side's own markers are
  //     (regression: a whole day of drives got zero reconciliation reads
  //     because the suspension/dedup gates below, unaware of the live
  //     streaming state, kept deferring to markers last updated hours ago).
  //
  //     Gated on the stream itself being fresh (not just "some latest doc
  //     exists"): getLatest/deriveActivity trust whatever gear/speed were
  //     last merged in, with no expiry of their own (unlike power_ts /
  //     POWER_STALE_S). Without this gate, a stream that dies outright while
  //     gear="D"/speed>1 happens to be the last-merged values would leave
  //     drivingNow stuck true forever, permanently disabling the suspension
  //     backstop below -- adversarial review of the driving-cadence fix
  //     caught this before it shipped; this codebase has already hit the
  //     same "stuck merged-forever field" failure mode twice for gear (#50)
  //     and power (this file's own history). Reusing STREAM_FRESH_S bounds
  //     the exposure to one resend window instead of indefinitely.
  //     (streamOk/streamFresh are read in step 1, which also uses them.)
  const latest = streamFresh ? await getLatest(env, vin).catch(() => null) : null;
  const drivingNow = latest != null && deriveActivity(latest) === "driving";
  const drivingPaceS = pacedDrivingIntervalS(budget.spent_micro, pollBudgetMicro(env));

  // 2b. TELEMETRY-FIRST: when Fleet Telemetry is actively delivering (the
  //     ingest route stamped liveness within the freshness window), a billed
  //     REST read is redundant -- the stream records the same signals at finer
  //     grain for ~1/300th the price, and its ingest path runs the exact same
  //     drive/charge/state derivations. Keep one billed reconciliation read
  //     per hour, and fall back to normal REST pacing automatically the
  //     moment the stream goes quiet.
  //
  //     While the last streaming-derived activity is "driving", tighten the
  //     gap to DRIVING_RECONCILE_S: drives are where odometer/snapshot drift
  //     accumulates fastest, and an hour-long blind spot once swallowed whole
  //     drives (see PR #56/#59 history). Motor power itself no longer depends
  //     on these reads -- it's derived stream-side from PackVoltage ×
  //     PackCurrent (derivePower in ingest.ts).
  if (streamFresh) {
    const lastBilledTs = Number(String((await getAppState(env, BILLED_TS(vin)).catch(() => "0")) ?? "0").split(" ")[0]) || 0;
    const reconcileGapS = drivingNow ? DRIVING_RECONCILE_S : RECONCILE_BILLED_S;
    if (now - lastBilledTs < reconcileGapS) {
      await recordConnectivityState(env, vin, "online").catch(() => {});
      return {
        vin, state, activity: "stream_covered", polled: false, active: drivingNow,
        next_interval_s: drivingNow
          ? Math.max(MIN_BILLED_GAP_S, reconcileGapS - (now - lastBilledTs))
          // Not driving: re-check this often so a drive starting is
          // discovered promptly (free connectivity check only, no billed
          // cost) instead of only every 300s -- a short drive can start and
          // finish entirely inside that window otherwise.
          : STREAM_COVERED_IDLE_POLL_S,
        budget_spent_usd: budget.spent_usd,
      };
    }
  }

  // 3. Suspension: idle long enough that we only probe occasionally. Bypassed
  //    while streaming shows the car driving right now (see 2a) -- REST's own
  //    "last active" bookkeeping only updates on a billed read, which under
  //    telemetry-first may not have happened in hours, but that must never be
  //    read as "the car has been idle" when it demonstrably has not.
  const ps = await readPollState(env, vin);
  const idleMin = ps.last_active_ts != null ? (now - ps.last_active_ts) / 60 : null;
  const suspended = !drivingNow && idleMin != null && idleMin >= IDLE_SUSPEND_MIN;
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

  // 3b. Cross-poller dedup: if any poller did a billed read more recently
  //     than the gap scaled to that read's own paced interval, skip the
  //     billed read here (free check already ran) so out-of-phase pollers
  //     can't multiply the paced spend. Return active with the REMAINING gap
  //     so the caller retries just as the window clears. The stamp is
  //     "<ts> <intervalS>"; legacy ts-only stamps fall back to the 8s minimum.
  //     While driving, cap the interval this scales from at the current
  //     driving pace -- otherwise a stale interval stamped by the LAST
  //     (non-driving) billed read, possibly hours old, throttles the FIRST
  //     reconciliation read after a driving transition to that stale, much
  //     slower cadence (up to 240s -- long enough to swallow a short drive).
  //     (With DRIVING_RECONCILE_S at 600s > MAX_BILLED_GAP_S, step 2b is
  //     currently the binding gate on that path; the cap stays as insurance
  //     should that constant ever tighten below 240s again.)
  const rawBilled = String((await getAppState(env, BILLED_TS(vin)).catch(() => "0")) ?? "0");
  const [billedTsRaw, billedIvalRaw] = rawBilled.split(" ");
  const lastBilled = Number(billedTsRaw) || 0;
  const lastBilledIval = drivingNow
    ? Math.min(Number(billedIvalRaw) || drivingPaceS, drivingPaceS)
    : Number(billedIvalRaw) || 0;
  const gapS = Math.min(MAX_BILLED_GAP_S, Math.max(MIN_BILLED_GAP_S, Math.round(lastBilledIval * BILLED_GAP_FRAC)));
  if (now - lastBilled < gapS) {
    await recordConnectivityState(env, vin, "online").catch(() => {});
    return {
      vin, state, activity: "throttled", polled: false, active: true,
      next_interval_s: Math.max(MIN_BILLED_GAP_S, gapS - (now - lastBilled)),
      budget_spent_usd: budget.spent_usd,
    };
  }

  // 4. One billed vehicle_data read, folded through ingest → derivation.
  //    vehicle_config is static trim data — refresh it monthly, not per-poll.
  //    (The car can drop offline between the check and here — treat as asleep.)
  const endpoints = ["charge_state", "climate_state", "drive_state", "vehicle_state", "location_data"];
  let refreshVcfg = false;
  try {
    refreshVcfg = now - Number((await getAppState(env, VCFG_TS(vin))) ?? "0") >= VCFG_REFRESH_S;
  } catch {
    /* skip refresh on state-read failure */
  }
  if (refreshVcfg) endpoints.push("vehicle_config");

  // Claim the billed-read slot BEFORE the network call (which takes seconds) —
  // otherwise a concurrent poller reads the stale stamp during that window and
  // double-bills (TOCTOU). The claim is a compare-and-swap against the stamp
  // read in step 3b: two pollers passing the gap check in the same instant
  // both used to "claim" with a plain overwrite and both proceeded to bill —
  // now whoever loses the CAS backs off to the free-only throttled response.
  // recordSpend inside getVehicleData is likewise counted before the call, so
  // the timings match. A subsequent failed read just throttles the next poll
  // for 8s (harmless).
  const claimed = await casAppState(
    env, BILLED_TS(vin), rawBilled === "0" ? null : rawBilled, String(now),
  ).catch(() => true); // a CAS-infra error must not stall polling entirely
  if (!claimed) {
    await recordConnectivityState(env, vin, "online").catch(() => {});
    return {
      vin, state, activity: "throttled", polled: false, active: true,
      next_interval_s: MIN_BILLED_GAP_S, budget_spent_usd: budget.spent_usd,
    };
  }

  let vd: Record<string, unknown>;
  try {
    vd = await getVehicleData(env, vin, endpoints);
  } catch {
    await recordConnectivityState(env, vin, "asleep").catch(() => {});
    return { vin, state: "asleep", activity: "asleep", polled: false, active: false, next_interval_s: INTERVAL_SLEEP };
  }
  if (refreshVcfg) await putAppState(env, VCFG_TS(vin), String(now)).catch(() => {});

  const current = await applyVehicleData(env, vin, vd);
  const activity = deriveActivity(current);
  const soc = typeof current.soc === "number" ? current.soc : null;

  if (activity === "driving" || activity === "charging") {
    // Throttle the bookkeeping write: at 10s cadence, rewriting the marker on
    // every poll would triple the row churn for no informational gain.
    if (ps.last_active_ts == null || now - ps.last_active_ts >= 45) {
      await putAppState(env, POLL_STATE(vin), JSON.stringify({ last_active_ts: now, last_probe_ts: now } satisfies PollState));
    }
    const budgetTotal = pollBudgetMicro(env);
    const nextIntervalS =
      activity === "driving"
        ? pacedDrivingIntervalS(budget.spent_micro, budgetTotal)
        : pacedChargingIntervalS(budget.spent_micro, budgetTotal);
    // Re-stamp the claim with the paced interval so the cross-poller gap in
    // step 3b scales to the cadence this read was actually paced at.
    await putAppState(env, BILLED_TS(vin), `${now} ${nextIntervalS}`).catch(() => {});
    return {
      vin, state, activity, polled: true, active: true, soc,
      next_interval_s: nextIntervalS,
      budget_spent_usd: budget.spent_usd,
    };
  }

  // idle: refresh the probe stamp; keep last_active for the suspend clock.
  await putAppState(
    env,
    POLL_STATE(vin),
    JSON.stringify({ last_active_ts: ps.last_active_ts ?? now, last_probe_ts: now } satisfies PollState),
  );
  const idleIntervalS = suspended ? INTERVAL_SLEEP : INTERVAL_IDLE;
  await putAppState(env, BILLED_TS(vin), `${now} ${idleIntervalS}`).catch(() => {});
  return {
    vin, state, activity: "idle", polled: true, soc,
    active: !suspended,
    next_interval_s: idleIntervalS,
    budget_spent_usd: budget.spent_usd,
  };
}
