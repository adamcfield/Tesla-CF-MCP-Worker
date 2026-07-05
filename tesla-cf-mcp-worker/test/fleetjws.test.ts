/**
 * Validates the Schnorr/P-256 signer in src/fleetjws.ts against Tesla's own
 * verification equation (internal/schnorr/schnorr.go `Verify`): a signature
 * (Vx‖Vy‖r) is valid iff V == c·A + r·G. We implement that check here with
 * independent BigInt affine EC math, so a passing test means Tesla's servers
 * will accept the signature — no live Tesla round-trip needed to gain confidence.
 */
import { describe, it, expect } from "vitest";
import { schnorrSignP256 } from "../src/fleetjws";

// P-256 domain parameters.
const P = BigInt("0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff");
const A_CURVE = P - 3n;
const Gx = BigInt("0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296");
const Gy = BigInt("0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5");

type Pt = { x: bigint; y: bigint } | null;
const mod = (a: bigint): bigint => ((a % P) + P) % P;
function inv(a: bigint): bigint {
  // Fermat: a^(p-2) mod p
  let r = 1n, b = mod(a), e = P - 2n;
  while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
  return r;
}
function dbl(pt: Pt): Pt {
  if (!pt || pt.y === 0n) return null;
  const l = mod((3n * pt.x * pt.x + A_CURVE) * inv(2n * pt.y));
  const x = mod(l * l - 2n * pt.x);
  return { x, y: mod(l * (pt.x - x) - pt.y) };
}
function add(p1: Pt, p2: Pt): Pt {
  if (!p1) return p2;
  if (!p2) return p1;
  if (p1.x === p2.x) return mod(p1.y + p2.y) === 0n ? null : dbl(p1);
  const l = mod((p2.y - p1.y) * inv(p2.x - p1.x));
  const x = mod(l * l - p1.x - p2.x);
  return { x, y: mod(l * (p1.x - x) - p1.y) };
}
function mul(k: bigint, pt: Pt): Pt {
  let r: Pt = null, b = pt;
  while (k > 0n) { if (k & 1n) r = add(r, b); b = dbl(b); k >>= 1n; }
  return r;
}
const G: Pt = { x: Gx, y: Gy };
const toBig = (b: Uint8Array): bigint => b.reduce((a, v) => (a << 8n) | BigInt(v), 0n);
async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", b));
}
function lv(...parts: Uint8Array[]): Uint8Array {
  const out: number[] = [];
  for (const p of parts) { out.push((p.length >>> 24) & 255, (p.length >>> 16) & 255, (p.length >>> 8) & 255, p.length & 255, ...p); }
  return new Uint8Array(out);
}
const G65 = new Uint8Array([0x04, ...hex(Gx), ...hex(Gy)]);
function hex(x: bigint): number[] {
  const b = new Array(32).fill(0);
  for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}

/** Tesla's Verify: parse (Vx,Vy,r), recompute c, assert V == c·A + r·G. */
async function verify(aPub: Uint8Array, message: Uint8Array, sig: Uint8Array): Promise<boolean> {
  const Vx = toBig(sig.subarray(0, 32));
  const Vy = toBig(sig.subarray(32, 64));
  const r = toBig(sig.subarray(64, 96));
  const cInput = lv(G65, new Uint8Array([0x04, ...sig.subarray(0, 64)]), aPub, message);
  const c = toBig(await sha256(cInput));
  const A: Pt = { x: toBig(aPub.subarray(1, 33)), y: toBig(aPub.subarray(33, 65)) };
  const check = add(mul(c, A), mul(r, G)); // c·A + r·G
  return !!check && check.x === Vx && check.y === Vy;
}

async function freshKey(): Promise<{ a: bigint; pub: Uint8Array }> {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  const d = Uint8Array.from(atob(jwk.d!.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(jwk.d!.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
  const x = Uint8Array.from(atob(jwk.x!.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "=")), (c) => c.charCodeAt(0));
  const y = Uint8Array.from(atob(jwk.y!.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "=")), (c) => c.charCodeAt(0));
  const pub = new Uint8Array(65); pub[0] = 0x04; pub.set(x, 1 + (32 - x.length)); pub.set(y, 33 + (32 - y.length));
  return { a: toBig(d), pub };
}

describe("fleet JWS — Schnorr/P-256 signature", () => {
  it("produces signatures that satisfy Tesla's Verify equation", async () => {
    for (let i = 0; i < 5; i++) {
      const { a, pub } = await freshKey();
      const msg = new TextEncoder().encode(`eyJhbGciOiJUZXNsYS5TUzI1NiJ9.payload-${i}-${"x".repeat(i * 7)}`);
      const sig = await schnorrSignP256(a, pub, msg);
      expect(sig.length).toBe(96);
      expect(await verify(pub, msg, sig)).toBe(true);
    }
  });

  it("rejects a signature against a tampered message (sanity of the verifier)", async () => {
    const { a, pub } = await freshKey();
    const sig = await schnorrSignP256(a, pub, new TextEncoder().encode("original"));
    expect(await verify(pub, new TextEncoder().encode("tampered"), sig)).toBe(false);
  });
});
