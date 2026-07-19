/**
 * Automation extensions: TOU tariff windows for price_charging (clock
 * schedule, no price feed — Israel's TAOZ shape), the sentry_event /
 * port_open_not_plugged / not_ready_by alert kinds, and actions passthrough
 * on plain alert rules.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { evaluateOnIngest, evalCronAlert, inTouWindow, type AutomationRule } from "../src/rules";
import { putAppState, resetSchemaCacheForTests } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";
import type { LatestState } from "../src/store";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
});
afterEach(() => vi.restoreAllMocks());

const VIN = "TESTVINAUTOALRT01";

function makeEnv(kv = new FakeKV()): Env {
  resetSchemaCacheForTests();
  return {
    TESLA_KV: kv as unknown as KVNamespace,
    DB: new FakeD1() as unknown as D1Database,
    TESLA_REGION: "eu",
    PUBLIC_ORIGIN: "https://test.example.com",
    TESLA_CLIENT_ID: "cid",
    TESLA_CLIENT_SECRET: "csecret",
    TESLA_PRIVATE_KEY: "pk",
    MCP_AUTH_TOKEN: "tok",
  } as Env;
}

async function putRules(env: Env, rules: AutomationRule[]): Promise<void> {
  await env.TESLA_KV.put("automations", JSON.stringify(rules));
}

async function alertRows(env: Env): Promise<Array<{ kind: string; message: string }>> {
  try {
    const rs = await env.DB.prepare(`SELECT kind, message FROM alert_log`).all<{ kind: string; message: string }>();
    return rs.results ?? [];
  } catch {
    return [];
  }
}

const st = (over: Partial<LatestState>): LatestState =>
  ({ vin: VIN, updated_at: Math.floor(Date.now() / 1000), ...over }) as LatestState;

describe("inTouWindow — clock-schedule tariff windows", () => {
  // tz offset 0 for determinism; windows in "local" == UTC here.
  const at = (day: number, hhmm: string): number => {
    // 2026-07-05 was a Sunday (day 0); build UTC ms for that weekday + time.
    const [h, m] = hhmm.split(":").map(Number);
    return Date.UTC(2026, 6, 5 + day, h, m);
  };

  it("simple daytime window", () => {
    const w = [{ start: "14:00", end: "17:00" }];
    expect(inTouWindow(w, at(1, "15:30"), 0)).toBe(true);
    expect(inTouWindow(w, at(1, "17:00"), 0)).toBe(false); // end exclusive
    expect(inTouWindow(w, at(1, "13:59"), 0)).toBe(false);
  });

  it("overnight window wraps midnight and attributes the tail to the start day", () => {
    // TAOZ-style cheap night: Sunday 23:00 → Monday 07:00, Sundays only.
    const w = [{ days: [0], start: "23:00", end: "07:00" }];
    expect(inTouWindow(w, at(0, "23:30"), 0)).toBe(true); // Sunday night
    expect(inTouWindow(w, at(1, "06:30"), 0)).toBe(true); // Monday pre-dawn tail
    expect(inTouWindow(w, at(1, "23:30"), 0)).toBe(false); // Monday night — not a start day
    expect(inTouWindow(w, at(0, "12:00"), 0)).toBe(false);
  });

  it("day mask limits a daytime window to the listed days", () => {
    const w = [{ days: [5], start: "10:00", end: "12:00" }]; // Fridays only
    expect(inTouWindow(w, at(5, "11:00"), 0)).toBe(true);
    expect(inTouWindow(w, at(4, "11:00"), 0)).toBe(false);
  });

  it("tz offset shifts the local clock", () => {
    const w = [{ start: "14:00", end: "17:00" }];
    // 12:30 UTC + 180min offset = 15:30 local → inside.
    expect(inTouWindow(w, at(1, "12:30"), 180)).toBe(true);
    expect(inTouWindow(w, at(1, "12:30"), 0)).toBe(false);
  });
});

describe("sentry_event alert", () => {
  it("fires on the armed→aware transition with location attached", async () => {
    const env = makeEnv();
    await putRules(env, [{ id: "r1", type: "alert", vin: VIN, when: "sentry_event" }]);
    await evaluateOnIngest(env, VIN, st({ sentry: "armed" }), st({ sentry: "aware", lat: 32.1, lon: 34.8 }));
    const rows = await alertRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("Sentry event");
  });

  it("stays silent on routine arming and while already triggered", async () => {
    const env = makeEnv();
    await putRules(env, [{ id: "r1", type: "alert", vin: VIN, when: "sentry_event" }]);
    await evaluateOnIngest(env, VIN, st({ sentry: "off" }), st({ sentry: "armed" }));
    await evaluateOnIngest(env, VIN, st({ sentry: "aware" }), st({ sentry: "panic" }));
    expect(await alertRows(env)).toHaveLength(0);
  });
});

describe("port_open_not_plugged alert", () => {
  const open = () => st({ charge_port_door_open: true, charge_port_latch: "ChargePortLatchDisengaged", charging_state: "Disconnected" });

  it("does not fire before open_minutes have elapsed, fires after", async () => {
    const kv = new FakeKV();
    const env = makeEnv(kv);
    await putRules(env, [{ id: "r1", type: "alert", vin: VIN, when: "port_open_not_plugged", open_minutes: 10 }]);

    await evaluateOnIngest(env, VIN, st({}), open()); // starts the timer
    await evaluateOnIngest(env, VIN, st({}), open()); // still fresh
    expect(await alertRows(env)).toHaveLength(0);

    // Age the stored timer past the threshold, then observe again.
    await kv.put(`port_open_since:r1:${VIN}`, String(Math.floor(Date.now() / 1000) - 11 * 60));
    await evaluateOnIngest(env, VIN, st({}), open());
    const rows = await alertRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("charge port has been open");
  });

  it("plugging in clears the timer", async () => {
    const kv = new FakeKV();
    const env = makeEnv(kv);
    await putRules(env, [{ id: "r1", type: "alert", vin: VIN, when: "port_open_not_plugged" }]);
    await evaluateOnIngest(env, VIN, st({}), open());
    await kv.put(`port_open_since:r1:${VIN}`, String(Math.floor(Date.now() / 1000) - 3600));
    // Cable connected: latch engages.
    await evaluateOnIngest(env, VIN, st({}), st({ charge_port_door_open: true, charge_port_latch: "ChargePortLatchEngaged", charging_state: "Charging" }));
    expect(await kv.get(`port_open_since:r1:${VIN}`)).toBeNull();
    expect(await alertRows(env)).toHaveLength(0);
  });
});

describe("not_ready_by cron alert", () => {
  // Pin the clock to noon UTC: the warn window deliberately doesn't wrap
  // midnight, so a real 22:30+ run would otherwise flake these tests.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 21, 12, 0, 0)));
  });
  afterEach(() => vi.useRealTimers());

  const inWindowRule = (over: Partial<AutomationRule> = {}): AutomationRule => {
    // Deadline 90 minutes from "now" in UTC so the 2h warn window is active.
    const dl = new Date(Date.now() + 90 * 60_000);
    return {
      id: "r1", type: "alert", vin: VIN, when: "not_ready_by",
      by: `${String(dl.getUTCHours()).padStart(2, "0")}:${String(dl.getUTCMinutes()).padStart(2, "0")}`,
      min_soc: 60, tz_offset_minutes: 0,
      ...over,
    } as AutomationRule;
  };

  it("fires inside the warn window when SoC is short and not charging", async () => {
    const env = makeEnv();
    await putAppState(env, `latest:${VIN}`, JSON.stringify(st({ soc: 45, charging_state: "Disconnected" })));
    expect(await evalCronAlert(env, inWindowRule())).toBe(true);
    // Once per day: immediately again is silent.
    expect(await evalCronAlert(env, inWindowRule())).toBe(false);
  });

  it("stays silent when charging, when ready, or outside the window", async () => {
    const env = makeEnv();
    await putAppState(env, `latest:${VIN}`, JSON.stringify(st({ soc: 45, charging_state: "Charging" })));
    expect(await evalCronAlert(env, inWindowRule())).toBe(false);
    await putAppState(env, `latest:${VIN}`, JSON.stringify(st({ soc: 80, charging_state: "Disconnected" })));
    expect(await evalCronAlert(env, inWindowRule())).toBe(false);
    await putAppState(env, `latest:${VIN}`, JSON.stringify(st({ soc: 45, charging_state: "Disconnected" })));
    // Deadline 5 hours away — before the 2h warn window opens.
    const far = new Date(Date.now() + 5 * 3600_000);
    expect(await evalCronAlert(env, inWindowRule({
      by: `${String(far.getUTCHours()).padStart(2, "0")}:${String(far.getUTCMinutes()).padStart(2, "0")}`,
    }))).toBe(false);
  });
});
