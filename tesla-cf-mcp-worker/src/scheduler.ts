/**
 * PollScheduler — a Durable Object that polls the vehicle on a self-rearming
 * alarm. This is the RELIABLE native poller: unlike GitHub Actions (whose free
 * cron is throttled to ~hourly) and unlike Cloudflare cron triggers (limited /
 * unregisterable on this account), a DO alarm fires on time, every time, at
 * whatever cadence pollOnce asks for — including the 10s burst during a drive.
 *
 * Free-tier friendly: a SQLite-backed DO (see wrangler.toml migration). Once
 * armed (GET /scheduler/start, or auto-armed on any request / cron tick) it
 * self-sustains: each alarm polls, then schedules the next alarm at the
 * interval pollOnce returned (clamped 10–300s). Budget-governed and never
 * wakes the car — same guarantees as every other poll path.
 */

import { pollOnce } from "./poll";
import { Env } from "./types";

const MIN_INTERVAL_S = 10;
const MAX_INTERVAL_S = 300;
const DEFAULT_INTERVAL_S = 90;

export class PollScheduler {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** Arm the alarm if it isn't already scheduled (idempotent). */
  async fetch(_request: Request): Promise<Response> {
    const existing = await this.state.storage.getAlarm();
    if (existing === null) {
      await this.state.storage.setAlarm(Date.now() + 3000);
    }
    return new Response(
      JSON.stringify({ armed: true, next_alarm: existing ?? Date.now() + 3000 }),
      { headers: { "content-type": "application/json" } },
    );
  }

  /** Fires on schedule: poll each configured VIN, then re-arm at the pace the
   *  poller asks for (fast while driving, slow while parked/asleep). */
  async alarm(): Promise<void> {
    let nextS = DEFAULT_INTERVAL_S;
    try {
      const vins = (this.env.POLL_VINS ?? "").split(/[,\s]+/).map((v) => v.trim()).filter(Boolean);
      for (const vin of vins) {
        try {
          const r = await pollOnce(this.env, vin);
          if (typeof r.next_interval_s === "number") nextS = Math.min(nextS, r.next_interval_s);
        } catch (e) {
          console.error("DO poll failed:", e instanceof Error ? e.message : e);
        }
      }
    } finally {
      // Re-arm is the LAST thing that runs, always — a try/finally guarantees it
      // even if code above throws. A failed setAlarm is re-thrown so the runtime
      // retries alarm() (rather than silently leaving the DO with no next alarm);
      // the /scheduler/start + GH re-arm paths are the outer safety net.
      const clamped = Math.max(MIN_INTERVAL_S, Math.min(MAX_INTERVAL_S, nextS));
      await this.state.storage.setAlarm(Date.now() + clamped * 1000);
    }
  }
}

/** Arms the singleton scheduler DO (idempotent). Called to start/keep it alive. */
export async function ensureSchedulerArmed(env: Env): Promise<void> {
  if (!env.POLL_SCHEDULER) return;
  const id = env.POLL_SCHEDULER.idFromName("poller");
  await env.POLL_SCHEDULER.get(id).fetch("https://do/arm");
}
