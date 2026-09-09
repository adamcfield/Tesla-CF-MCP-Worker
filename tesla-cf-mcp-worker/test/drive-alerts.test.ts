/**
 * Drive-lifecycle and arrival alerts, plus the delivery path that makes them
 * reach a phone.
 *
 * Two defects used to make automation alerts unreachable in the app:
 *   1. dispatchWebhooks set `delivered = urls.length === 0`, so a rule with no
 *      webhook URLs was logged as already-delivered — and deliverPendingAlerts
 *      only ever pushes rows with delivered = 0. Rule alerts produced no Web
 *      Push at all.
 *   2. The push fan-out ran only on the automation tick. The dashboard claims
 *      "~15 min"; GitHub throttles that schedule to 5-12 runs/day, so an event
 *      alert could arrive hours after the event.
 * Both are pinned below: a rule with no webhooks must still push, and the push
 * must happen during the ingest call rather than being deferred.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { evaluateOnIngest, type AutomationRule } from "../src/rules";
import { resetSchemaCacheForTests } from "../src/store";
import { savePushSubscription } from "../src/webpush";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";
import type { LatestState } from "../src/store";

const VIN = "TESTVINDRIVEALT01";

// Real keys, generated once per run — the same approach as webpush.test.ts.
// Hard-coded placeholders don't work: sendWebPush does genuine ECDH and ECDSA,
// so invalid key material fails before any fetch and the delivery assertions
// below would pass for the wrong reason.
const b64url = (b: Uint8Array | ArrayBuffer) => Buffer.from(b as ArrayBuffer).toString("base64url");
let VAPID_PUBLIC = "";
let VAPID_PRIVATE = "";
let SUB_P256DH = "";
let SUB_AUTH = "";

beforeAll(async () => {
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  VAPID_PUBLIC = b64url(await crypto.subtle.exportKey("raw", vapid.publicKey));
  VAPID_PRIVATE = ((await crypto.subtle.exportKey("jwk", vapid.privateKey)) as JsonWebKey).d!;
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  SUB_P256DH = b64url(await crypto.subtle.exportKey("raw", ua.publicKey));
  SUB_AUTH = b64url(crypto.getRandomValues(new Uint8Array(16)));
});

function makeEnv(extra: Partial<Env> = {}): Env {
  resetSchemaCacheForTests();
  return {
    TESLA_KV: new FakeKV() as unknown as KVNamespace,
    DB: new FakeD1() as unknown as D1Database,
    TESLA_REGION: "eu",
    PUBLIC_ORIGIN: "https://test.example.com",
    TESLA_CLIENT_ID: "cid",
    TESLA_CLIENT_SECRET: "csecret",
    TESLA_PRIVATE_KEY: "pk",
    MCP_AUTH_TOKEN: "tok",
    ...extra,
  } as Env;
}

const state = (o: Partial<LatestState>): LatestState =>
  ({ vin: VIN, updated_at: Math.floor(Date.now() / 1000), ...o }) as LatestState;

const parked = state({ gear: "P", speed: 0 });
const driving = state({ gear: "D", speed: 40, lat: 32.1, lon: 34.8, odometer: 42000, soc: 72 });

async function putRules(env: Env, rules: AutomationRule[]): Promise<void> {
  await env.TESLA_KV.put("automations", JSON.stringify(rules));
}

async function alerts(env: Env): Promise<Array<{ kind: string; message: string; delivered: number }>> {
  try {
    const rs = await env.DB.prepare(`SELECT kind, message, delivered FROM alert_log ORDER BY id`)
      .all<{ kind: string; message: string; delivered: number }>();
    return rs.results ?? [];
  } catch {
    return [];
  }
}

afterEach(() => vi.restoreAllMocks());

describe("drive lifecycle alerts", () => {
  let env: Env;
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    env = makeEnv();
  });

  it("fires on the parked → driving edge, and not while driving continues", async () => {
    await putRules(env, [{ id: "d1", type: "alert", vin: VIN, when: "drive_started" } as AutomationRule]);

    await evaluateOnIngest(env, VIN, parked, driving);
    let rows = await alerts(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("started driving");

    // Still driving: no second alert.
    await evaluateOnIngest(env, VIN, driving, state({ gear: "D", speed: 55 }));
    expect(await alerts(env)).toHaveLength(1);
  });

  it("treats a drive that ends on a charger as parked, not as still driving", async () => {
    // driving -> charging is the classic "arrived home and plugged in" case;
    // an `activity === idle` test would silently miss it.
    await putRules(env, [{ id: "d2", type: "alert", vin: VIN, when: "drive_ended" } as AutomationRule]);
    const charging = state({ gear: "P", speed: 0, charging_state: "Charging" });

    await evaluateOnIngest(env, VIN, driving, charging);
    const rows = await alerts(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("parked");
  });

  it("names the destination when the car has one", async () => {
    await putRules(env, [{ id: "d3", type: "alert", vin: VIN, when: "drive_ended" } as AutomationRule]);
    await evaluateOnIngest(env, VIN, driving, state({ gear: "P", speed: 0, nav_destination_name: "Dizengoff Center" }));
    expect((await alerts(env))[0].message).toContain("Dizengoff Center");
  });
});

describe("approaching_destination", () => {
  let env: Env;
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    env = makeEnv();
  });

  it("fires once on the downward ETA crossing, not on every sample inside the window", async () => {
    await putRules(env, [
      { id: "a1", type: "alert", vin: VIN, when: "approaching_destination", minutes_before: 5 } as AutomationRule,
    ]);
    const at = (m: number) => state({ gear: "D", speed: 40, nav_minutes_to_arrival: m, nav_destination_name: "Home" });

    // 12 → 8: still outside the window.
    await evaluateOnIngest(env, VIN, at(12), at(8));
    expect(await alerts(env)).toHaveLength(0);

    // 8 → 4: crosses.
    await evaluateOnIngest(env, VIN, at(8), at(4));
    const rows = await alerts(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("Home");
    expect(rows[0].message).toMatch(/~4 min/);

    // 4 → 3: already inside, no re-fire.
    await evaluateOnIngest(env, VIN, at(4), at(3));
    expect(await alerts(env)).toHaveLength(1);
  });

  it("ignores a cleared route reporting 0 minutes while stopped", async () => {
    // Ending a route sets the ETA to 0; that is not an approach.
    await putRules(env, [
      { id: "a2", type: "alert", vin: VIN, when: "approaching_destination", minutes_before: 5 } as AutomationRule,
    ]);
    await evaluateOnIngest(
      env,
      VIN,
      state({ gear: "P", speed: 0, nav_minutes_to_arrival: 9 }),
      state({ gear: "P", speed: 0, nav_minutes_to_arrival: 0 }),
    );
    expect(await alerts(env)).toHaveLength(0);
  });

  it("stays silent when the car has no active route", async () => {
    await putRules(env, [
      { id: "a3", type: "alert", vin: VIN, when: "approaching_destination" } as AutomationRule,
    ]);
    await evaluateOnIngest(env, VIN, driving, state({ gear: "D", speed: 60 }));
    expect(await alerts(env)).toHaveLength(0);
  });
});

describe("alert delivery", () => {
  it("pushes a rule with NO webhook URLs — the defect that made app alerts silent", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      sent.push(String(url));
      return new Response(null, { status: 201 });
    }));
    const env = makeEnv({ VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE } as Partial<Env>);
    await savePushSubscription(env, {
      endpoint: "https://push.example.com/sub-1",
      p256dh: SUB_P256DH,
      auth: SUB_AUTH,
    });
    await putRules(env, [{ id: "p1", type: "alert", vin: VIN, when: "drive_started" } as AutomationRule]);

    await evaluateOnIngest(env, VIN, parked, driving);

    // The push went out DURING the ingest call, not deferred to the tick.
    expect(sent.some((u) => u.includes("push.example.com"))).toBe(true);
    const rows = await alerts(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].delivered).toBe(1);
  });

  it("leaves an alert undelivered when the push service rejects it, so the tick retries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    const env = makeEnv({ VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE } as Partial<Env>);
    await savePushSubscription(env, {
      endpoint: "https://push.example.com/sub-2",
      p256dh: SUB_P256DH,
      auth: SUB_AUTH,
    });
    await putRules(env, [{ id: "p2", type: "alert", vin: VIN, when: "drive_started" } as AutomationRule]);

    await evaluateOnIngest(env, VIN, parked, driving);
    const rows = await alerts(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].delivered).toBe(0);
  });

  it("marks delivered when nothing is configured, so no backlog accumulates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
    const env = makeEnv(); // no VAPID keys, rule has no notify[]
    await putRules(env, [{ id: "p3", type: "alert", vin: VIN, when: "drive_started" } as AutomationRule]);

    await evaluateOnIngest(env, VIN, parked, driving);
    const rows = await alerts(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].delivered).toBe(1);
  });
});
