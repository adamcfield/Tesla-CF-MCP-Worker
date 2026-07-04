/** Worker bindings and shared Tesla Fleet API types. */

export interface Env {
  TESLA_KV: KVNamespace;
  /** D1 database for telemetry history, charge sessions and the alert log. */
  DB: D1Database;

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

export function fleetBase(env: Env): string {
  return FLEET_BASES[env.TESLA_REGION] ?? FLEET_BASES.na!;
}

export function authBase(env: Env): string {
  return AUTH_BASES[env.TESLA_REGION] ?? AUTH_BASES.na!;
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
