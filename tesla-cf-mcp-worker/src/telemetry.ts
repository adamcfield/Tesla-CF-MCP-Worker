/**
 * Fleet Telemetry configuration.
 *
 * Why this exists: polling vehicle_data costs ~$0.12/hr per vehicle, while a
 * telemetry stream costs ~$0.00667/hr — about 18x cheaper. Any recurring data
 * need (dashboards, automations, history) should use telemetry, not the
 * get_* MCP tools.
 *
 * v1 scope: this module only manages the fleet_telemetry_config lifecycle
 * (create/read/delete). Actually *receiving* the stream requires a Fleet
 * Telemetry target (Tesla pushes to your server over mTLS, or via Tesla's
 * hosted Kafka/webhook integrations) — that ingestion side is out of scope
 * here.
 *
 * TODO(v2):
 *  - stand up a telemetry receiver (fleet-telemetry server or hosted target)
 *    and add an MCP tool that reads the latest streamed state from KV, making
 *    most get_vehicle_data calls unnecessary
 *  - surface telemetry errors from /api/1/vehicles/{vin}/fleet_telemetry_errors
 */

import { getOwnerToken } from "./auth";
import { signTelemetryConfig } from "./fleetjws";
import { Env, TeslaError, fleetBase } from "./types";

async function fleetRequest<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  const token = await getOwnerToken(env);
  const resp = await fetch(`${fleetBase(env)}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new TeslaError(`Fleet API ${method} ${path} failed (${resp.status})`, resp.status, await resp.text());
  }
  return ((await resp.json()) as { response: T }).response;
}

export interface TelemetryFieldConfig {
  interval_seconds?: number;
  minimum_delta?: number;
  resend_interval_seconds?: number;
}

export interface TelemetryConfigInput {
  vins: string[];
  config: {
    hostname: string;
    port?: number;
    /** PEM CA chain of the receiving server (mTLS). */
    ca?: string;
    fields: Record<string, TelemetryFieldConfig>;
    alert_types?: string[];
  };
}

/**
 * Registers a telemetry stream for the given VINs. The vehicle must have the
 * virtual key paired (same pairing as signed commands).
 *
 * Modern firmware rejects an unsigned config ("must be called through the
 * Vehicle Command HTTP Proxy"), so we sign it in-worker as a Schnorr/P-256 JWT
 * (alg "Tesla.SS256") with the paired command key and POST {vins, token} to
 * the _jws endpoint — reproducing what tesla-http-proxy does. Check status with
 * getTelemetryConfig.
 */
export async function createTelemetryConfig(env: Env, input: TelemetryConfigInput): Promise<Record<string, unknown>> {
  const token = await signTelemetryConfig(env, input.config as unknown as Record<string, unknown>);
  return fleetRequest<Record<string, unknown>>(env, "POST", "/api/1/vehicles/fleet_telemetry_config_jws", {
    vins: input.vins,
    token,
  });
}

export const getTelemetryConfig = (env: Env, vin: string) =>
  fleetRequest<Record<string, unknown>>(env, "GET", `/api/1/vehicles/${vin}/fleet_telemetry_config`);

export const deleteTelemetryConfig = (env: Env, vin: string) =>
  fleetRequest<Record<string, unknown>>(env, "DELETE", `/api/1/vehicles/${vin}/fleet_telemetry_config`);
