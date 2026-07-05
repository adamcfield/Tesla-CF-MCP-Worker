/**
 * Tesla "fleet" JWT signer for POST /api/1/vehicles/fleet_telemetry_config_jws.
 *
 * Vehicles that require signed commands reject an unsigned fleet_telemetry_config.
 * Tesla's vehicle-command HTTP proxy instead signs the config as a JWT whose
 * signature is a Schnorr signature over NIST P-256 (RFC 8235), alg "Tesla.SS256",
 * using the SAME EC key already paired for signed commands, then POSTs
 * {vins, token} to the _jws endpoint. This reproduces that exactly, in-worker,
 * with no new dependencies — the only curve op needed is k·G, which WebCrypto
 * provides (import k as an ECDH key, read its public coordinates).
 *
 * Verified against teslamotors/vehicle-command@main:
 *   pkg/proxy/proxy.go        (handleFleetTelemetryConfig → SignMessageForFleet → _jws)
 *   pkg/sign/sign.go          (SignMessageForFleet → SignMessage aud "com.tesla.fleet.TelemetryClient")
 *   internal/authentication/jwt.go   (SignMessage: iss=b64(pub), aud, alg "Tesla.SS256")
 *   internal/schnorr/{sign,schnorr}.go (Sign, challenge, Verify)
 */

import { loadCommandKey } from "./protocol";
import { Env } from "./types";

// P-256 subgroup order n.
const N = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

// Uncompressed generator G = 0x04 || Gx || Gy (== elliptic.Marshal(P256, Gx, Gy)).
const G65 = hexToBytes(
  "04" +
    "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" +
    "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5",
);

function hexToBytes(h: string): Uint8Array {
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return b;
}
function bytesToBigInt(b: Uint8Array): bigint {
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v);
  return x;
}
function bigIntTo32(x: bigint): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
}
function b64urlBytes(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(s: string): string {
  return b64urlBytes(new TextEncoder().encode(s));
}
function b64stdBytes(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s); // standard base64 WITH padding — matches Go base64.StdEncoding
}
function b64urlToBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b.buffer as ArrayBuffer));
}
/** 4-byte big-endian length-prefixed concatenation (schnorr.writeLengthValue). */
function lvConcat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += 4 + p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out[o++] = (p.length >>> 24) & 0xff;
    out[o++] = (p.length >>> 16) & 0xff;
    out[o++] = (p.length >>> 8) & 0xff;
    out[o++] = p.length & 0xff;
    out.set(p, o);
    o += p.length;
  }
  return out;
}
/** Minimal PKCS#8 (prime256v1) wrapping a raw 32-byte private scalar, for WebCrypto import. */
function scalarToPkcs8(k: Uint8Array): Uint8Array {
  return new Uint8Array([
    0x30, 0x41, 0x02, 0x01, 0x00,
    0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
    0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20, ...k,
  ]);
}
/** V = k·G as a 65-byte uncompressed point, via WebCrypto (no manual EC math). */
async function scalarBaseMult(k: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    scalarToPkcs8(k).buffer as ArrayBuffer,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  const x = b64urlToBytes(jwk.x!);
  const y = b64urlToBytes(jwk.y!);
  const V = new Uint8Array(65);
  V[0] = 0x04;
  V.set(x, 1 + (32 - x.length));
  V.set(y, 33 + (32 - y.length));
  return V;
}

/**
 * Schnorr/P-256 sign `message` with private scalar `a` and its public point
 * `aPub` (65-byte uncompressed). Returns the 96-byte signature Vx‖Vy‖r.
 * Any nonce yields a valid signature (Verify only checks V == c·A + r·G), so we
 * use a fresh random nonce rather than the reference's RFC-6979 derivation.
 */
export async function schnorrSignP256(a: bigint, aPub: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  // Random nonce k in [1, n-1] (any nonce yields a valid signature).
  let k = 0n;
  const rnd = new Uint8Array(32);
  do {
    crypto.getRandomValues(rnd);
    k = bytesToBigInt(rnd) % N;
  } while (k === 0n);

  const V = await scalarBaseMult(bigIntTo32(k)); // 65-byte 0x04||Vx||Vy
  const c = bytesToBigInt(await sha256(lvConcat([G65, V, aPub, message])));
  const r = ((k - ((a * c) % N)) % N + N) % N;

  const sig = new Uint8Array(96);
  sig.set(V.subarray(1, 65), 0); // Vx‖Vy
  sig.set(bigIntTo32(r), 64); // r
  return sig;
}

/** The vehicle-command private scalar `a` (jwk.d) for the paired command key. */
async function commandScalar(env: Env): Promise<{ a: bigint; pub: Uint8Array }> {
  const key = await loadCommandKey(env.TESLA_PRIVATE_KEY);
  const jwk = (await crypto.subtle.exportKey("jwk", key.privateKey)) as JsonWebKey;
  if (!jwk.d) throw new Error("command key is not exportable (missing d)");
  return { a: bytesToBigInt(b64urlToBytes(jwk.d)), pub: key.publicKeyBytes };
}

/**
 * Builds the signed "TelemetryClient" JWT for `config` (the {hostname, port, ca,
 * fields, ...} object). Returns the compact JWS string to place in the
 * fleet_telemetry_config_jws request's `token` field.
 */
export async function signTelemetryConfig(env: Env, config: Record<string, unknown>): Promise<string> {
  const { a, pub } = await commandScalar(env);
  const header = { alg: "Tesla.SS256", typ: "JWT" };
  const claims = {
    ...config,
    iss: b64stdBytes(pub), // authentication.SignMessage: iss = base64(publicBytes)
    aud: "com.tesla.fleet.TelemetryClient",
  };
  const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(claims))}`;
  const sig = await schnorrSignP256(a, pub, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64urlBytes(sig)}`;
}
