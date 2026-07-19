/**
 * Web Push delivery — RFC 8291 message encryption (aes128gcm) + RFC 8292
 * VAPID authentication, WebCrypto only, no dependencies.
 *
 * The dashboard PWA registers a browser PushSubscription via
 * POST /data/push-subscribe (index.ts); rows live in the push_subscriptions
 * table (ensureSchema, store.ts). deliverPendingAlerts (rules.ts) fans
 * undelivered alert_log rows out through sendWebPush on every cron tick, so
 * alerts reach the phone even when the dashboard is closed. This is ADDITIVE
 * to the ALERT_WEBHOOK raw-text fallback in logAlert — neither replaces the
 * other.
 *
 * Crypto walk-through (per message):
 *   1. ECDH over P-256 between a fresh ephemeral key and the subscription's
 *      p256dh public key, mixed with the subscription's 16-byte auth secret
 *      through HKDF-SHA-256 into the input keying material (RFC 8291 §3.3-3.4).
 *   2. A random 16-byte salt derives the AES-128-GCM content key + 12-byte
 *      nonce ("Content-Encoding: aes128gcm"/"nonce" info strings).
 *   3. The JSON payload + a 0x02 last-record delimiter is encrypted as a
 *      single RFC 8188 record; the body is salt‖rs‖idlen‖ephemeral-pub‖ct.
 *   4. The request carries a 12h ES256 JWT (aud = push-service origin) built
 *      from the VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY env keys — generate a pair
 *      once with scripts/gen-vapid-keys.mjs.
 *
 * Hygiene: a 404/410 from the push service means the browser dropped the
 * subscription — the row is deleted immediately. Any other failure increments
 * a consecutive-failures counter; 10 in a row also deletes the row, so a dead
 * phone can't make every future tick pay for its timeouts forever.
 */

import { ensureSchema } from "./store";
import { Env } from "./types";

/** Contact URI the push service may use to reach the operator (RFC 8292 §2.1). */
const VAPID_SUBJECT = "mailto:owner@example.com";
/** Consecutive send failures after which a subscription is presumed dead. */
const MAX_FAILURES = 10;
/** RFC 8188 record size advertised in the body header (single-record messages). */
const RECORD_SIZE = 4096;

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  created_ts?: number;
  last_ok_ts?: number | null;
  failures?: number;
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  /** Dashboard-relative URL the notification click should open (default /#al). */
  url?: string;
}

// ---------------------------------------------------------------------------
// Subscription store (push_subscriptions — see ensureSchema in store.ts)
// ---------------------------------------------------------------------------

/** Upsert a browser subscription (re-subscribing revives a failing row). */
export async function savePushSubscription(
  env: Env,
  sub: { endpoint: string; p256dh: string; auth: string },
): Promise<void> {
  await ensureSchema(env);
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_ts, failures)
     VALUES (?1, ?2, ?3, ?4, 0)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, failures = 0`,
  )
    .bind(sub.endpoint, sub.p256dh, sub.auth, Math.floor(Date.now() / 1000))
    .run();
}

export async function deletePushSubscription(env: Env, endpoint: string): Promise<boolean> {
  await ensureSchema(env);
  const res = await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?1`).bind(endpoint).run();
  return Number(res.meta.changes ?? 0) > 0;
}

export async function listPushSubscriptions(env: Env): Promise<PushSubscriptionRow[]> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT endpoint, p256dh, auth, created_ts, last_ok_ts, failures FROM push_subscriptions ORDER BY created_ts`,
  ).all<PushSubscriptionRow>();
  return rs.results ?? [];
}

// ---------------------------------------------------------------------------
// Small byte/base64url helpers (module-local, mirroring fleetjws.ts)
// ---------------------------------------------------------------------------

function b64urlBytes(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
/** One-shot HKDF-SHA-256 (extract with `salt`, expand with `info`) via WebCrypto. */
async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm.buffer as ArrayBuffer, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt.buffer as ArrayBuffer, info: info.buffer as ArrayBuffer },
      key,
      bytes * 8,
    ),
  );
}

// ---------------------------------------------------------------------------
// RFC 8292: VAPID authorization header
// ---------------------------------------------------------------------------

/**
 * `Authorization: vapid t=<ES256 JWT>, k=<public key>` for one push-service
 * origin. The JWT is signed with the raw P-256 scalar in VAPID_PRIVATE_KEY;
 * WebCrypto's ECDSA output is already the raw r‖s form JWS wants.
 */
async function vapidAuthHeader(env: Env, audience: string): Promise<string> {
  const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY!); // 65-byte uncompressed point 0x04‖x‖y
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: env.VAPID_PRIVATE_KEY!,
    x: b64urlBytes(pub.slice(1, 33)),
    y: b64urlBytes(pub.slice(33, 65)),
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64urlBytes(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlBytes(
    utf8(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT })),
  );
  const signingInput = `${header}.${claims}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(signingInput).buffer as ArrayBuffer),
  );
  return `vapid t=${signingInput}.${b64urlBytes(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// ---------------------------------------------------------------------------
// RFC 8291: aes128gcm content encryption
// ---------------------------------------------------------------------------

async function encryptPayload(p256dh: string, authSecret: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPub = b64urlToBytes(p256dh); // the browser's public key (65-byte uncompressed)
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPub.buffer as ArrayBuffer,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const eph = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const asPub = new Uint8Array((await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer);
  // workers-types spells the runtime's `public` field `$public` (reserved-word
  // escaping in its codegen) — the cast keeps the runtime-correct shape.
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      eph.privateKey,
      256,
    ),
  );

  // RFC 8291 §3.3-3.4: IKM = HKDF(salt=auth_secret, ecdh, "WebPush: info"‖0x00‖ua_pub‖as_pub, 32).
  const ikm = await hkdf(ecdhSecret, b64urlToBytes(authSecret), concatBytes(utf8("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, utf8("Content-Encoding: nonce\0"), 12);

  // RFC 8188 single record: plaintext ‖ 0x02 delimiter (last record), AES-128-GCM.
  const record = concatBytes(plaintext, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey("raw", cek.buffer as ArrayBuffer, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce.buffer as ArrayBuffer }, aesKey, record.buffer as ArrayBuffer),
  );

  // Body: salt(16) ‖ rs(4, big-endian) ‖ idlen(1) ‖ keyid(ephemeral pub, 65) ‖ ciphertext.
  const head = new Uint8Array(16 + 4 + 1 + asPub.length);
  head.set(salt, 0);
  head[16] = (RECORD_SIZE >>> 24) & 0xff;
  head[17] = (RECORD_SIZE >>> 16) & 0xff;
  head[18] = (RECORD_SIZE >>> 8) & 0xff;
  head[19] = RECORD_SIZE & 0xff;
  head[20] = asPub.length;
  head.set(asPub, 21);
  return concatBytes(head, ct);
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Encrypt `payload` for one subscription and POST it to the push service.
 * Returns whether the service accepted it. Bookkeeping is handled here: a
 * 404/410 deletes the row (browser dropped the subscription), success stamps
 * last_ok_ts and resets the failure counter, anything else increments it and
 * the row is pruned after MAX_FAILURES consecutive misses.
 */
export async function sendWebPush(env: Env, subscription: PushSubscriptionRow, payload: PushPayload): Promise<boolean> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  await ensureSchema(env);
  try {
    const body = await encryptPayload(subscription.p256dh, subscription.auth, utf8(JSON.stringify(payload)));
    const resp = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        TTL: "300",
        Urgency: "high",
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        Authorization: await vapidAuthHeader(env, new URL(subscription.endpoint).origin),
      },
      body,
    });
    if (resp.ok) {
      await env.DB.prepare(`UPDATE push_subscriptions SET last_ok_ts = ?2, failures = 0 WHERE endpoint = ?1`)
        .bind(subscription.endpoint, Math.floor(Date.now() / 1000))
        .run();
      return true;
    }
    if (resp.status === 404 || resp.status === 410) {
      // The push service says this subscription no longer exists — drop it now.
      await deletePushSubscription(env, subscription.endpoint);
      return false;
    }
    await recordPushFailure(env, subscription.endpoint);
    return false;
  } catch {
    // Encrypt/network failure — same consecutive-failure accounting as a 5xx.
    await recordPushFailure(env, subscription.endpoint).catch(() => {});
    return false;
  }
}

async function recordPushFailure(env: Env, endpoint: string): Promise<void> {
  await env.DB.prepare(`UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?1`).bind(endpoint).run();
  await env.DB.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?1 AND failures >= ?2`)
    .bind(endpoint, MAX_FAILURES)
    .run();
}
