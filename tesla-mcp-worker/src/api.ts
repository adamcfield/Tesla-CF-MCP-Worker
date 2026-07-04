/**
 * Fleet API REST reads.
 *
 * Cost note: every vehicle_data call is billed by Tesla (~$0.12/hr equivalent
 * for frequent polling). For anything recurring, prefer Fleet Telemetry
 * streaming (~18x cheaper) — see telemetry.ts. These endpoints exist for
 * on-demand MCP tool calls only; nothing in this Worker polls.
 */

import { getOwnerToken } from "./auth";
import { Env, TeslaError, VehicleSummary, fleetBase } from "./types";

async function fleetGet<T>(env: Env, path: string): Promise<T> {
  const token = await getOwnerToken(env);
  const resp = await fetch(`${fleetBase(env)}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const body = await resp.text();
    if (resp.status === 408) {
      throw new TeslaError(
        "Vehicle is unavailable (asleep or offline). Call wake_vehicle explicitly if you need live data — this server never wakes a vehicle automatically.",
        408,
        body,
      );
    }
    throw new TeslaError(`Fleet API GET ${path} failed (${resp.status})`, resp.status, body);
  }
  return ((await resp.json()) as { response: T }).response;
}

async function fleetPost<T>(env: Env, path: string, body?: unknown): Promise<T> {
  const token = await getOwnerToken(env);
  const resp = await fetch(`${fleetBase(env)}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new TeslaError(`Fleet API POST ${path} failed (${resp.status})`, resp.status, await resp.text());
  }
  return ((await resp.json()) as { response: T }).response;
}

export const listVehicles = (env: Env): Promise<VehicleSummary[]> =>
  fleetGet<VehicleSummary[]>(env, "/api/1/vehicles");

/**
 * Cheap connectivity check (does NOT count as a vehicle_data read and does
 * not wake the vehicle). Use before any data read.
 */
export const getVehicle = (env: Env, vin: string): Promise<VehicleSummary> =>
  fleetGet<VehicleSummary>(env, `/api/1/vehicles/${vin}`);

/**
 * Billed vehicle_data snapshot. `endpoints` limits the payload (and keeps
 * responses small); location_data must be requested explicitly.
 */
export async function getVehicleData(
  env: Env,
  vin: string,
  endpoints?: string[],
): Promise<Record<string, unknown>> {
  const state = await getVehicle(env, vin);
  if (state.state !== "online") {
    throw new TeslaError(
      `Vehicle ${vin} is ${state.state}. Live vehicle_data requires the vehicle to be online. ` +
        "Call wake_vehicle first if (and only if) fresh data is genuinely needed — waking costs " +
        "battery and API budget. For recurring reads, set up Fleet Telemetry streaming instead.",
      408,
    );
  }
  const qs = endpoints?.length ? `?endpoints=${encodeURIComponent(endpoints.join(";"))}` : "";
  return fleetGet<Record<string, unknown>>(env, `/api/1/vehicles/${vin}/vehicle_data${qs}`);
}

export const wakeVehicle = (env: Env, vin: string): Promise<VehicleSummary> =>
  fleetPost<VehicleSummary>(env, `/api/1/vehicles/${vin}/wake_up`);

export function nearbyChargingSites(
  env: Env,
  vin: string,
  opts: { count?: number; radius?: number; detail?: boolean } = {},
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams();
  if (opts.count !== undefined) qs.set("count", String(opts.count));
  if (opts.radius !== undefined) qs.set("radius", String(opts.radius));
  if (opts.detail !== undefined) qs.set("detail", String(opts.detail));
  const suffix = qs.size ? `?${qs}` : "";
  return fleetGet<Record<string, unknown>>(env, `/api/1/vehicles/${vin}/nearby_charging_sites${suffix}`);
}
