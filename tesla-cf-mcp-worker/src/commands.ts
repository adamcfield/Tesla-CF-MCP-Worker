/**
 * Signed vehicle commands over the Fleet API `signed_command` endpoint,
 * using the Vehicle Command Protocol (see protocol.ts). Sessions are cached
 * in-memory per isolate; a stale counter/epoch triggers one re-handshake.
 */

import { getOwnerToken } from "./auth";
import {
  CarServer,
  ClosureMove,
  CommandKey,
  Domain,
  DomainValue,
  KEY_FAULTS,
  MESSAGE_FAULTS,
  OPERATION_STATUS,
  RETRYABLE_FAULTS,
  RKEAction,
  Session,
  buildSession,
  bytesToB64,
  decodeCarServerResponse,
  decodeRoutableMessage,
  decodeVcsecResponse,
  encodeSessionInfoRequest,
  encodeSignedCommand,
  loadCommandKey,
  vcsecClosureMove,
  vcsecRKEAction,
} from "./protocol";
import { Env, TeslaError, fleetBase } from "./types";

const b64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Message shown when the virtual key isn't paired with the vehicle. */
function pairingHint(env: Env): string {
  const domain = new URL(env.PUBLIC_ORIGIN).hostname;
  return (
    "The Worker's virtual key is not paired with this vehicle. Pair it once from a phone with " +
    `the Tesla app installed by opening https://tesla.com/_ak/${domain} (or scan that URL as a QR code), ` +
    "then approve the key in the Tesla app while near the vehicle."
  );
}

// In-memory per-isolate session cache. Counters are monotonic per session, so
// this must never be shared through KV (eventual consistency would replay
// counters and the vehicle would reject them).
const sessions = new Map<string, Session>();

interface CommandContext {
  env: Env;
  key: CommandKey;
  vin: string;
  routingAddress: Uint8Array;
}

async function sendRoutable(ctx: CommandContext, msg: Uint8Array): Promise<Uint8Array> {
  const token = await getOwnerToken(ctx.env);
  const resp = await fetch(`${fleetBase(ctx.env)}/api/1/vehicles/${ctx.vin}/signed_command`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ routable_message: bytesToB64(msg) }),
  });
  const body = (await resp.json().catch(() => null)) as { response?: string; error?: string } | null;
  if (!resp.ok || !body?.response) {
    const detail = body?.error ?? JSON.stringify(body);
    if (resp.status === 408) {
      throw new TeslaError(
        "Vehicle is asleep or unreachable. Call wake_vehicle first, then retry the command.",
        408,
        detail,
      );
    }
    if (resp.status === 422) {
      throw new TeslaError(
        `Vehicle rejected the command envelope (422). ${pairingHint(ctx.env)}`,
        422,
        detail,
      );
    }
    throw new TeslaError(`signed_command failed (${resp.status})`, resp.status, detail);
  }
  return b64ToBytes(body.response);
}

async function handshake(ctx: CommandContext, domain: DomainValue): Promise<Session> {
  const req = encodeSessionInfoRequest(domain, ctx.key.publicKeyBytes, ctx.routingAddress);
  const decoded = decodeRoutableMessage(await sendRoutable(ctx, req));
  if (!decoded.sessionInfo) {
    const fault = MESSAGE_FAULTS[decoded.fault] ?? `fault ${decoded.fault}`;
    throw new TeslaError(`Vehicle did not return session info (${fault})`);
  }
  if (decoded.sessionInfo.status === 1) {
    throw new TeslaError(pairingHint(ctx.env), 403);
  }
  const session = await buildSession(ctx.key, decoded.sessionInfo);
  sessions.set(`${ctx.vin}:${domain}`, session);
  return session;
}

interface CommandResult {
  result: boolean;
  reason: string;
}

async function runCommand(
  env: Env,
  vin: string,
  domain: DomainValue,
  payload: Uint8Array,
): Promise<CommandResult> {
  const key = await loadCommandKey(env.TESLA_PRIVATE_KEY);
  const ctx: CommandContext = {
    env,
    key,
    vin,
    routingAddress: crypto.getRandomValues(new Uint8Array(16)),
  };

  let session = sessions.get(`${vin}:${domain}`) ?? (await handshake(ctx, domain));

  for (let attempt = 0; attempt < 3; attempt++) {
    const signed = await encodeSignedCommand(key, session, vin, domain, payload, ctx.routingAddress);
    const decoded = decodeRoutableMessage(await sendRoutable(ctx, signed));

    // The vehicle may piggyback fresh session info (e.g. on counter errors).
    if (decoded.sessionInfo?.status === 1) throw new TeslaError(pairingHint(env), 403);

    if (decoded.fault !== 0) {
      if (KEY_FAULTS.has(decoded.fault)) {
        throw new TeslaError(`${MESSAGE_FAULTS[decoded.fault]}. ${pairingHint(env)}`, 403);
      }
      if (RETRYABLE_FAULTS.has(decoded.fault) && attempt < 2) {
        session = decoded.sessionInfo
          ? await buildSession(key, decoded.sessionInfo)
          : await handshake(ctx, domain);
        sessions.set(`${vin}:${domain}`, session);
        continue;
      }
      throw new TeslaError(`Vehicle rejected command: ${MESSAGE_FAULTS[decoded.fault] ?? decoded.fault}`);
    }

    if (decoded.operationStatus === OPERATION_STATUS.WAIT && attempt < 2) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    if (decoded.payload && decoded.payload.length > 0) {
      if (domain === Domain.VEHICLE_SECURITY) {
        const r = decodeVcsecResponse(decoded.payload);
        if (r.wait && attempt < 2) {
          await new Promise((res) => setTimeout(res, 2000));
          continue;
        }
        return { result: r.ok, reason: r.reason };
      }
      const r = decodeCarServerResponse(decoded.payload);
      return { result: r.ok, reason: r.reason };
    }
    return { result: true, reason: "" };
  }
  return { result: false, reason: "gave up after 3 attempts (vehicle busy)" };
}

const security = (env: Env, vin: string, payload: Uint8Array) =>
  runCommand(env, vin, Domain.VEHICLE_SECURITY, payload);
const infotainment = (env: Env, vin: string, payload: Uint8Array) =>
  runCommand(env, vin, Domain.INFOTAINMENT, payload);

// ---------------------------------------------------------------------------
// Public command surface (one function per MCP tool)
// ---------------------------------------------------------------------------

export const lockDoors = (env: Env, vin: string) =>
  security(env, vin, vcsecRKEAction(RKEAction.LOCK));

export const unlockDoors = (env: Env, vin: string) =>
  security(env, vin, vcsecRKEAction(RKEAction.UNLOCK));

export const actuateFrunk = (env: Env, vin: string) =>
  security(env, vin, vcsecClosureMove("frontTrunk", ClosureMove.MOVE));

export const actuateTrunk = (env: Env, vin: string) =>
  security(env, vin, vcsecClosureMove("rearTrunk", ClosureMove.MOVE));

export const openChargePort = (env: Env, vin: string) =>
  security(env, vin, vcsecClosureMove("chargePort", ClosureMove.OPEN));

export const closeChargePort = (env: Env, vin: string) =>
  security(env, vin, vcsecClosureMove("chargePort", ClosureMove.CLOSE));

export const setChargeLimit = (env: Env, vin: string, percent: number) =>
  infotainment(env, vin, CarServer.chargingSetLimit(percent));

export const startCharging = (env: Env, vin: string) =>
  infotainment(env, vin, CarServer.chargingStart());

export const stopCharging = (env: Env, vin: string) =>
  infotainment(env, vin, CarServer.chargingStop());

export const climateOn = (env: Env, vin: string) =>
  infotainment(env, vin, CarServer.hvacAuto(true));

export const climateOff = (env: Env, vin: string) =>
  infotainment(env, vin, CarServer.hvacAuto(false));

export const setTemperature = (env: Env, vin: string, driverC: number, passengerC?: number) =>
  infotainment(env, vin, CarServer.setTemperature(driverC, passengerC ?? driverC));

export const flashLights = (env: Env, vin: string) =>
  infotainment(env, vin, CarServer.flashLights());

export const honkHorn = (env: Env, vin: string) =>
  infotainment(env, vin, CarServer.honkHorn());

export const setSentryMode = (env: Env, vin: string, on: boolean) =>
  infotainment(env, vin, CarServer.setSentryMode(on));

export const setChargingAmps = (env: Env, vin: string, amps: number) =>
  infotainment(env, vin, CarServer.setChargingAmps(amps));

export const navigateToCoords = (env: Env, vin: string, lat: number, lon: number) =>
  infotainment(env, vin, CarServer.navigateToCoords(lat, lon));

export const addChargeSchedule = (
  env: Env,
  vin: string,
  s: Parameters<typeof CarServer.addChargeSchedule>[0],
) => infotainment(env, vin, CarServer.addChargeSchedule(s));

export const removeChargeSchedule = (env: Env, vin: string, id: number) =>
  infotainment(env, vin, CarServer.removeChargeSchedule(id));

export const addPreconditionSchedule = (
  env: Env,
  vin: string,
  s: Parameters<typeof CarServer.addPreconditionSchedule>[0],
) => infotainment(env, vin, CarServer.addPreconditionSchedule(s));

export const removePreconditionSchedule = (env: Env, vin: string, id: number) =>
  infotainment(env, vin, CarServer.removePreconditionSchedule(id));
