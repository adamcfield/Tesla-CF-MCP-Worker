/** Worker bindings and shared Tesla Fleet API types. */

/** Minimal Cloudflare Workers AI binding shape (avoids depending on the ambient Ai type). */
export interface WorkersAI {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface Env {
  TESLA_KV: KVNamespace;
  /** D1 database for telemetry history, charge sessions and the alert log. */
  DB: D1Database;
  /** Cloudflare Workers AI (Llama) — powers Ask-Tessa, briefings, coach notes. Optional. */
  AI?: WorkersAI;
  /** HMAC secret for signed drive risk certificates (falls back to MCP_AUTH_TOKEN). */
  CERT_SECRET?: string;

  // vars (wrangler.toml)
  TESLA_REGION: "na" | "eu" | "cn";
  PUBLIC_ORIGIN: string;

  // secrets (wrangler secret put …)
  TESLA_CLIENT_ID: string;
  TESLA_CLIENT_SECRET: string;
  /** PEM-encoded EC P-256 private key (SEC1 "EC PRIVATE KEY" or PKCS#8 "PRIVATE KEY"). */
  TESLA_PRIVATE_KEY: string;
  /** Optional seed refresh token; once used, the rotated token is kept in KV. */
  TESLA_REFRESH_TOKEN?: string;
  MCP_AUTH_TOKEN: string;
  /** Optional separate bearer for POST /ingest/telemetry (falls back to MCP_AUTH_TOKEN). */
  INGEST_TOKEN?: string;
  /** Optional shared secret sent as x-webhook-token on outbound alert webhooks. */
  WEBHOOK_SECRET?: string;
  /**
   * Optional raw-history retention in days (wrangler.toml [vars] or secret).
   * Prunes telemetry_events and non-drive positions older than this on each
   * automation tick. Default 400 days; set "0" to keep everything forever.
   */
  RETENTION_DAYS?: string;
  /**
   * Optional soft cap (USD) for AUTOMATED polling spend per month, default 9.
   * Clamped under the $9.70 hard ceiling that protects Tesla's $10 disable line.
   */
  BUDGET_POLL_USD?: string;
  /**
   * Optional IANA timezone for the vehicle/owner (default "Asia/Jerusalem").
   * Drives night-fraction scoring, monthly-report bucketing, and DST-aware
   * automation schedules — a fixed minute offset would drift on every clock
   * change.
   */
  DEFAULT_TZ?: string;
  /**
   * Optional quiet window for idle probes, UTC hours "start-end" (e.g. "21-3"
   * = 00:00–06:00 Israel time). Free connectivity checks continue; billed
   * idle probes pause. Unset = probe around the clock.
   */
  QUIET_HOURS_UTC?: string;
  /**
   * Optional Fleet API base override (e.g. https://api.myteslamate.com) so the
   * worker polls a cost-absorbing proxy instead of Tesla directly. Pair with
   * TESLA_AUTH_BASE and re-run the owner grant through the proxy. Empty = Tesla.
   */
  TESLA_API_BASE?: string;
  /** Optional OAuth base override to match TESLA_API_BASE (e.g. the proxy's auth host). */
  TESLA_AUTH_BASE?: string;
  /** GovMap (Israeli national map) API key — enables GovMap geocoding/tiles over OSM fallback. */
  GOVMAP_API_KEY?: string;
}

/** Regional Fleet API bases — https://developer.tesla.com/docs/fleet-api */
export const FLEET_BASES: Record<string, string> = {
  na: "https://fleet-api.prd.na.vn.cloud.tesla.com",
  eu: "https://fleet-api.prd.eu.vn.cloud.tesla.com",
  cn: "https://fleet-api.prd.cn.vn.cloud.tesla.cn",
};

export const AUTH_BASES: Record<string, string> = {
  na: "https://auth.tesla.com",
  eu: "https://auth.tesla.com",
  cn: "https://auth.tesla.cn",
};

// Optional overrides let the worker point at a proxy (e.g. MyTeslaMate's free
// api.myteslamate.com, which absorbs Tesla's per-call cost) instead of Tesla
// directly — a config flip, no code change. Empty = use Tesla's regional host.
export function fleetBase(env: Env): string {
  return env.TESLA_API_BASE?.replace(/\/+$/, "") || FLEET_BASES[env.TESLA_REGION] || FLEET_BASES.na!;
}

export function authBase(env: Env): string {
  return env.TESLA_AUTH_BASE?.replace(/\/+$/, "") || AUTH_BASES[env.TESLA_REGION] || AUTH_BASES.na!;
}

/** OAuth scopes requested from the vehicle owner. */
export const OWNER_SCOPES =
  "openid offline_access user_data vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds";

/** Scopes for the partner (client-credentials) token used for one-time setup. */
export const PARTNER_SCOPES =
  "openid vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds";

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

export interface VehicleSummary {
  id: number;
  vehicle_id: number;
  vin: string;
  display_name?: string;
  state: "online" | "asleep" | "offline" | string;
  in_service?: boolean;
  api_version?: number;
}

/** Error carrying a user-actionable message for MCP tool output. */
export class TeslaError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: unknown,
  ) {
    super(message);
  }
}
