/**
 * Web Push (webpush.ts + rules.ts deliverPendingAlerts): the deterministic
 * layer. The aes128gcm ciphertext itself involves a fresh ephemeral key and
 * random salt per message, so these tests don't decrypt — they assert the
 * subscription store, the wire shape of the push POST (RFC 8188 body header,
 * RFC 8292 VAPID Authorization, TTL/Urgency/Content-Encoding), the delivery
 * marking, and the dead-subscription pruning (immediate on 404/410, after 10
 * consecutive misses otherwise).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { deliverPendingAlerts } from "../src/rules";
import {
  deletePushSubscription,
  listPushSubscriptions,
  savePushSubscription,
  sendWebPush,
} from "../src/webpush";
import { logAlert, resetSchemaCacheForTests } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const b64url = (b: Uint8Array | ArrayBuffer) => Buffer.from(b as ArrayBuffer).toString("base64url");
const b64urlJson = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

// Real keys, generated once per run: a VAPID signing pair (what
// gen-vapid-keys.mjs mints) and a browser-side ECDH pair + auth secret (what
// pushManager.subscribe() would hand the dashboard).
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
    VAPID_PUBLIC_KEY: VAPID_PUBLIC,
    VAPID_PRIVATE_KEY: VAPID_PRIVATE,
    ...extra,
  } as Env;
}

const ENDPOINT = "https://push.example.net/send/abc123";

function sub(endpoint = ENDPOINT) {
  return { endpoint, p256dh: SUB_P256DH, auth: SUB_AUTH };
}

/** Stubs global fetch with a canned per-endpoint status; returns the recorded calls. */
function stubPushFetch(statusFor: (url: string) => number) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return new Response(null, { status: statusFor(url) });
  });
  return calls;
}

async function subRow(env: Env, endpoint = ENDPOINT) {
  return env.DB.prepare(`SELECT * FROM push_subscriptions WHERE endpoint = ?1`)
    .bind(endpoint)
    .first<{ endpoint: string; last_ok_ts: number | null; failures: number }>();
}

describe("push subscription store", () => {
  it("stores, lists, upserts (resetting failures) and deletes by endpoint", async () => {
    const env = makeEnv();
    await savePushSubscription(env, sub());
    expect(await listPushSubscriptions(env)).toHaveLength(1);

    await env.DB.prepare(`UPDATE push_subscriptions SET failures = 7 WHERE endpoint = ?1`).bind(ENDPOINT).run();
    await savePushSubscription(env, sub()); // re-subscribe revives the row
    const rows = await listPushSubscriptions(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.failures).toBe(0);
    expect(rows[0]!.p256dh).toBe(SUB_P256DH);

    expect(await deletePushSubscription(env, ENDPOINT)).toBe(true);
    expect(await deletePushSubscription(env, ENDPOINT)).toBe(false); // already gone
    expect(await listPushSubscriptions(env)).toHaveLength(0);
  });
});

describe("sendWebPush", () => {
  it("POSTs an aes128gcm message with VAPID auth and stamps last_ok_ts on success", async () => {
    const env = makeEnv();
    await savePushSubscription(env, sub());
    const calls = stubPushFetch(() => 201);

    const before = Math.floor(Date.now() / 1000);
    expect(await sendWebPush(env, sub(), { title: "Tesla — budget", body: "spend crossed 90%", url: "/#al" })).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ENDPOINT);
    expect(calls[0]!.init.method).toBe("POST");
    const headers = new Headers(calls[0]!.init.headers as HeadersInit);
    expect(headers.get("ttl")).toBe("300");
    expect(headers.get("urgency")).toBe("high");
    expect(headers.get("content-encoding")).toBe("aes128gcm");
    expect(headers.get("content-type")).toBe("application/octet-stream");

    // Authorization: vapid t=<ES256 JWT>, k=<our public key>.
    const auth = headers.get("authorization") ?? "";
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=(.+)$/.exec(auth);
    expect(m).not.toBeNull();
    expect(m![4]).toBe(VAPID_PUBLIC);
    expect(b64urlJson(m![1]!)).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = b64urlJson(m![2]!);
    expect(claims.aud).toBe("https://push.example.net"); // push-service ORIGIN, not the full endpoint
    expect(claims.sub).toMatch(/^mailto:/);
    expect(claims.exp).toBeGreaterThan(before + 11 * 3600);
    expect(claims.exp).toBeLessThanOrEqual(before + 12 * 3600 + 60);
    expect(Buffer.from(m![3]!, "base64url")).toHaveLength(64); // raw r‖s ES256 signature

    // RFC 8188 body header: salt(16) ‖ rs=4096 ‖ idlen=65 ‖ keyid ‖ ciphertext.
    const body = new Uint8Array(calls[0]!.init.body as Uint8Array);
    expect(Array.from(body.subarray(16, 20))).toEqual([0, 0, 0x10, 0]);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(0x04); // keyid = uncompressed ephemeral P-256 point
    const payloadLen = Buffer.byteLength(
      JSON.stringify({ title: "Tesla — budget", body: "spend crossed 90%", url: "/#al" }),
      "utf8",
    );
    expect(body.length).toBe(86 + payloadLen + 1 + 16); // header + plaintext + delimiter + GCM tag

    const row = await subRow(env);
    expect(row!.failures).toBe(0);
    expect(row!.last_ok_ts).toBeGreaterThanOrEqual(before);
  });

  it("does nothing without VAPID keys", async () => {
    const env = makeEnv({ VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined });
    const calls = stubPushFetch(() => 201);
    expect(await sendWebPush(env, sub(), { title: "t", body: "b" })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("deletes the subscription immediately on a 410 from the push service", async () => {
    const env = makeEnv();
    await savePushSubscription(env, sub());
    stubPushFetch(() => 410);
    expect(await sendWebPush(env, sub(), { title: "t", body: "b" })).toBe(false);
    expect(await listPushSubscriptions(env)).toHaveLength(0);
  });

  it("counts consecutive failures and prunes the row on the 10th", async () => {
    const env = makeEnv();
    await savePushSubscription(env, sub());
    stubPushFetch(() => 500);
    for (let i = 1; i <= 9; i++) {
      expect(await sendWebPush(env, sub(), { title: "t", body: "b" })).toBe(false);
      expect((await subRow(env))!.failures).toBe(i);
    }
    await sendWebPush(env, sub(), { title: "t", body: "b" }); // 10th miss
    expect(await subRow(env)).toBeNull();
  });

  it("a success resets the failure streak", async () => {
    const env = makeEnv();
    await savePushSubscription(env, sub());
    let status = 500;
    stubPushFetch(() => status);
    await sendWebPush(env, sub(), { title: "t", body: "b" });
    expect((await subRow(env))!.failures).toBe(1);
    status = 201;
    await sendWebPush(env, sub(), { title: "t", body: "b" });
    expect((await subRow(env))!.failures).toBe(0);
  });
});

describe("deliverPendingAlerts", () => {
  async function pendingAlert(env: Env, message: string) {
    await logAlert(env, { ruleId: "budget_watchdog", kind: "budget", message, delivered: false });
  }
  async function alertRows(env: Env) {
    const rs = await env.DB.prepare(`SELECT id, message, delivered FROM alert_log ORDER BY id`).all<{
      id: number;
      message: string;
      delivered: number;
    }>();
    return rs.results ?? [];
  }

  it("pushes undelivered alerts to every subscription and marks them delivered", async () => {
    const env = makeEnv();
    const dead = "https://push.example.net/send/dead";
    await savePushSubscription(env, sub());
    await savePushSubscription(env, sub(dead));
    await pendingAlert(env, "spend crossed 90%");
    const calls = stubPushFetch((url) => (url === dead ? 410 : 201));

    expect(await deliverPendingAlerts(env)).toBe(1);

    expect(calls.map((c) => c.url).sort()).toEqual([dead, ENDPOINT].sort());
    expect((await alertRows(env))[0]!.delivered).toBe(1);
    // The 410 endpoint got pruned in the same pass; the healthy one remains.
    expect((await listPushSubscriptions(env)).map((s) => s.endpoint)).toEqual([ENDPOINT]);

    // A second run has nothing left to send.
    calls.length = 0;
    expect(await deliverPendingAlerts(env)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("leaves an alert undelivered when every push fails", async () => {
    const env = makeEnv();
    await savePushSubscription(env, sub());
    await pendingAlert(env, "nobody home");
    stubPushFetch(() => 500);
    expect(await deliverPendingAlerts(env)).toBe(0);
    expect((await alertRows(env))[0]!.delivered).toBe(0);
  });

  it("skips entirely without VAPID keys or without subscriptions", async () => {
    const noKeys = makeEnv({ VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined });
    await savePushSubscription(noKeys, sub());
    await logAlert(noKeys, { ruleId: "r", kind: "watchdog", message: "m", delivered: false });
    const calls = stubPushFetch(() => 201);
    expect(await deliverPendingAlerts(noKeys)).toBe(0);

    const noSubs = makeEnv();
    await logAlert(noSubs, { ruleId: "r", kind: "watchdog", message: "m", delivered: false });
    expect(await deliverPendingAlerts(noSubs)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("ignores already-delivered rows and alerts older than 24h, oldest-first capped at 10", async () => {
    const env = makeEnv();
    await savePushSubscription(env, sub());
    await logAlert(env, { ruleId: "r", kind: "alert", message: "webhook got this one", delivered: true });
    for (let i = 0; i < 12; i++) await pendingAlert(env, `pending ${i}`);
    // Age one pending row past the 24h window.
    const stale = Math.floor(Date.now() / 1000) - 25 * 3600;
    await env.DB.prepare(`UPDATE alert_log SET ts = ?1 WHERE message = 'pending 0'`).bind(stale).run();
    const calls = stubPushFetch(() => 201);

    expect(await deliverPendingAlerts(env)).toBe(10); // cap per run

    expect(calls).toHaveLength(10); // one push per alert for the single subscription
    const rows = await alertRows(env);
    expect(rows.find((r) => r.message === "pending 0")!.delivered).toBe(0); // too old
    expect(rows.find((r) => r.message === "pending 11")!.delivered).toBe(0); // beyond the 10-cap this run
    expect(rows.filter((r) => r.delivered === 1)).toHaveLength(11); // webhook one + 10 pushed
  });
});
