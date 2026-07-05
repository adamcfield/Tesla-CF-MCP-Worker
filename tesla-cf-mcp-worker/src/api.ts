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

/** A normalized past charging session from Tesla's dx/charging/history. */
export interface ChargingHistorySession {
  external_id: number;
  vin: string;
  site_name: string | null;
  start_ts: number | null;
  end_ts: number | null;
  energy_kwh: number | null;
  cost: number | null;
  currency: string | null;
}

const toUnix = (iso: unknown): number | null => {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
};

/**
 * Tesla Fleet API historical charging sessions (Supercharger / Tesla-billed
 * DC only — home AC charging is not in Tesla's billing records, and no SoC or
 * range is included). Energy and cost come from the fee line items. Paginates
 * to pull the full history. Documented as fleet/business accounts, but works
 * for entitled personal accounts too; returns [] if unentitled/empty.
 */
export async function getChargingHistory(env: Env, vin: string): Promise<ChargingHistorySession[]> {
  const token = await getOwnerToken(env);
  const out: ChargingHistorySession[] = [];
  const pageSize = 50;
  for (let pageNo = 1; pageNo <= 40; pageNo++) {
    const qs = new URLSearchParams({ vin, pageSize: String(pageSize), pageNo: String(pageNo) });
    const resp = await fetch(`${fleetBase(env)}/api/1/dx/charging/history?${qs}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      if (pageNo === 1) throw new TeslaError(`charging history failed (${resp.status})`, resp.status, await resp.text());
      break;
    }
    const body = (await resp.json()) as { data?: unknown[]; totalResults?: number };
    const rows = Array.isArray(body.data) ? body.data : [];
    for (const r of rows) {
      const s = r as Record<string, any>;
      const fees = Array.isArray(s.fees) ? s.fees : [];
      const kwhFees = fees.filter((f: any) => String(f.uom ?? "").toLowerCase() === "kwh");
      const energy = kwhFees.reduce((sum: number, f: any) => sum + (Number(f.usageBase) || 0), 0);
      const cost = fees.reduce((sum: number, f: any) => sum + (Number(f.totalDue) || 0), 0);
      out.push({
        external_id: Number(s.sessionId),
        vin: String(s.vin ?? vin),
        site_name: typeof s.siteLocationName === "string" ? s.siteLocationName : null,
        start_ts: toUnix(s.chargeStartDateTime),
        end_ts: toUnix(s.chargeStopDateTime),
        energy_kwh: kwhFees.length ? Math.round(energy * 1000) / 1000 : null,
        cost: Math.round(cost * 100) / 100,
        currency: fees[0]?.currencyCode ?? null,
      });
    }
    if (rows.length < pageSize) break;
  }
  return out;
}

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
