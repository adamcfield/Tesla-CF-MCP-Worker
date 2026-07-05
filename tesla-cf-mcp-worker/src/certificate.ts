/**
 * Tamper-evident drive risk certificates.
 *
 * A behaviour score is only "insurance-grade" if the data behind it can't have
 * been quietly edited after the fact. This canonicalises a drive's metrics into
 * a stable JSON string and HMAC-SHA256-signs it with a server-only secret
 * (CERT_SECRET, falling back to MCP_AUTH_TOKEN). Anyone can later re-request the
 * certificate and verify the signature; nobody without the secret can forge one
 * or alter a metric without the signature no longer matching. This is the
 * custody-chain primitive the whole telematics story rests on.
 *
 * The signature covers the DERIVED metrics + a content hash of the raw GPS
 * path, so a doctored route or a fabricated harsh-event count both break it.
 */

import { Env } from "./types";

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  const secret = env.CERT_SECRET || env.MCP_AUTH_TOKEN;
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

/** SHA-256 of the raw path, so route tampering invalidates the certificate. */
async function pathHash(path: Array<Record<string, unknown>>): Promise<string> {
  const canonical = path
    .map((p) => `${p.ts},${p.lat},${p.lon},${p.speed ?? ""}`)
    .join(";");
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(canonical)));
}

export interface DriveCertificate {
  drive_id: number;
  issued_ts: number;
  algorithm: "HMAC-SHA256";
  canonical: Record<string, unknown>;
  signature_hex: string;
  verify_url: string;
}

/**
 * Builds and signs a certificate for one drive. `drive` is the drives row,
 * `path` its positions. `issuedTs` is passed in (Workers forbid Date.now in
 * some contexts, and a caller-supplied stamp keeps signing deterministic in
 * tests).
 */
export async function signDriveCertificate(
  env: Env,
  drive: Record<string, unknown>,
  path: Array<Record<string, unknown>>,
  issuedTs: number,
): Promise<DriveCertificate> {
  const canonical: Record<string, unknown> = {
    v: 1,
    vin_suffix: String(drive.vin ?? "").slice(-6),
    drive_id: Number(drive.id),
    start_ts: drive.start_ts ?? null,
    end_ts: drive.end_ts ?? null,
    distance_km: drive.distance_km ?? null,
    duration_min: drive.duration_min ?? null,
    driver: drive.driver ?? null,
    avg_speed: drive.avg_speed ?? null,
    max_speed: drive.max_speed ?? null,
    max_decel_ms2: drive.max_decel_ms2 ?? null,
    max_accel_ms2: drive.max_accel_ms2 ?? null,
    max_jerk_ms3: drive.max_jerk_ms3 ?? null,
    harsh_accel_count: drive.harsh_accel_count ?? null,
    harsh_brake_count: drive.harsh_brake_count ?? null,
    harsh_turn_count: drive.harsh_turn_count ?? null,
    over_limit_frac: drive.over_limit_frac ?? null,
    over_limit_severity: drive.over_limit_severity ?? null,
    night_frac: drive.night_frac ?? null,
    behavior_score: drive.behavior_score ?? null,
    score_low: drive.score_low ?? null,
    score_high: drive.score_high ?? null,
    sample_count: drive.sample_count ?? null,
    path_sha256: await pathHash(path),
    issued_ts: issuedTs,
  };
  // Deterministic serialisation: keys are already in a fixed insertion order.
  const message = JSON.stringify(canonical);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), enc.encode(message));
  return {
    drive_id: Number(drive.id),
    issued_ts: issuedTs,
    algorithm: "HMAC-SHA256",
    canonical,
    signature_hex: toHex(sig),
    verify_url: `${env.PUBLIC_ORIGIN}/data/verify-certificate`,
  };
}

/**
 * Verifies a certificate body ({canonical, signature_hex}) against the current
 * secret. Returns whether the signature is valid — i.e. the canonical metrics
 * are exactly what the server signed and nothing was altered.
 */
export async function verifyDriveCertificate(
  env: Env,
  body: { canonical?: unknown; signature_hex?: unknown },
): Promise<{ valid: boolean; reason?: string }> {
  if (!body || typeof body.canonical !== "object" || typeof body.signature_hex !== "string") {
    return { valid: false, reason: "missing canonical or signature_hex" };
  }
  const sigBytes = body.signature_hex.match(/../g)?.map((h) => parseInt(h, 16));
  if (!sigBytes) return { valid: false, reason: "signature not hex" };
  const message = JSON.stringify(body.canonical);
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(env),
    new Uint8Array(sigBytes),
    enc.encode(message),
  );
  return { valid };
}
