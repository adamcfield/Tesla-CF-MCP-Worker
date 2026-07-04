/**
 * Tesla Vehicle Command Protocol — wire-level building blocks.
 *
 * Implements the HMAC-personalized signing scheme used by the Fleet API
 * `signed_command` endpoint (the replacement for the deprecated plain REST
 * /command/* endpoints). Field numbers and the metadata TLV layout follow
 * teslamotors/vehicle-command protobufs (universal_message.proto,
 * signatures.proto, vcsec.proto, car_server.proto).
 *
 * Only the handful of messages this Worker sends/receives are encoded, with a
 * hand-rolled protobuf codec, so the Worker ships with zero runtime deps.
 */

// ---------------------------------------------------------------------------
// Minimal protobuf codec
// ---------------------------------------------------------------------------

export class PbWriter {
  private buf: number[] = [];

  private varint(v: number): void {
    // JS numbers are safe here: all our varints fit in 32 bits.
    let n = v >>> 0;
    while (n > 0x7f) {
      this.buf.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    this.buf.push(n);
  }

  private tag(field: number, wire: number): void {
    this.varint((field << 3) | wire);
  }

  uint32(field: number, v: number): this {
    if (v !== 0) {
      this.tag(field, 0);
      this.varint(v);
    }
    return this;
  }

  /** Encodes an enum/bool/uint field even when zero (for forced presence). */
  uint32Always(field: number, v: number): this {
    this.tag(field, 0);
    this.varint(v);
    return this;
  }

  bool(field: number, v: boolean): this {
    return this.uint32(field, v ? 1 : 0);
  }

  fixed32(field: number, v: number): this {
    this.tag(field, 5);
    this.buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }

  float(field: number, v: number): this {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v, true);
    this.tag(field, 5);
    this.buf.push(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    return this;
  }

  bytes(field: number, v: Uint8Array): this {
    this.tag(field, 2);
    this.varint(v.length);
    for (const b of v) this.buf.push(b);
    return this;
  }

  string(field: number, v: string): this {
    return this.bytes(field, new TextEncoder().encode(v));
  }

  /** Embeds a submessage; always emitted, even when empty (oneof presence). */
  message(field: number, m: PbWriter): this {
    return this.bytes(field, m.finish());
  }

  finish(): Uint8Array {
    return new Uint8Array(this.buf);
  }
}

export interface PbField {
  field: number;
  wire: number;
  /** varint value (wire 0) or fixed32 value (wire 5) */
  value: number;
  /** length-delimited payload (wire 2) */
  data?: Uint8Array;
}

export function pbDecode(buf: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  const varint = (): number => {
    let shift = 0;
    let val = 0;
    for (;;) {
      const b = buf[i++];
      if (b === undefined) throw new Error("protobuf: truncated varint");
      val += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return val;
      shift += 7;
      if (shift > 63) throw new Error("protobuf: varint too long");
    }
  };
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) {
      out.push({ field, wire, value: varint() });
    } else if (wire === 2) {
      const len = varint();
      out.push({ field, wire, value: len, data: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 5) {
      const dv = new DataView(buf.buffer, buf.byteOffset + i, 4);
      out.push({ field, wire, value: dv.getUint32(0, true) });
      i += 4;
    } else if (wire === 1) {
      out.push({ field, wire, value: 0, data: buf.subarray(i, i + 8) });
      i += 8;
    } else {
      throw new Error(`protobuf: unsupported wire type ${wire}`);
    }
  }
  return out;
}

const first = (fields: PbField[], n: number): PbField | undefined =>
  fields.find((f) => f.field === n);

// ---------------------------------------------------------------------------
// Enums / constants (from Tesla protos)
// ---------------------------------------------------------------------------

export const Domain = {
  VEHICLE_SECURITY: 2,
  INFOTAINMENT: 3,
} as const;
export type DomainValue = (typeof Domain)[keyof typeof Domain];

const SIGNATURE_TYPE_HMAC_PERSONALIZED = 8;

const Tag = {
  SIGNATURE_TYPE: 0,
  DOMAIN: 1,
  PERSONALIZATION: 2,
  EPOCH: 3,
  EXPIRES_AT: 4,
  COUNTER: 5,
  END: 255,
} as const;

export const OPERATION_STATUS = { OK: 0, WAIT: 1, ERROR: 2 } as const;

/** UniversalMessage.MessageFault_E — name lookup for error reporting. */
export const MESSAGE_FAULTS: Record<number, string> = {
  0: "none",
  1: "vehicle is busy",
  2: "command timed out inside the vehicle",
  3: "unknown key id (virtual key not paired with this vehicle)",
  4: "key is inactive/disabled on this vehicle",
  5: "invalid signature",
  6: "invalid token or counter (stale session)",
  7: "key lacks sufficient privileges for this command",
  8: "invalid domain",
  9: "invalid command",
  10: "vehicle could not decode the message",
  11: "internal vehicle error",
  12: "message VIN does not match this vehicle",
  13: "bad command parameter",
  14: "vehicle keychain is full",
  15: "incorrect epoch (stale session)",
  16: "incorrect initialization-vector length",
  17: "command expired before reaching the vehicle",
  18: "vehicle is not provisioned with a VIN",
  19: "could not hash command metadata",
  20: "command time-to-live too long",
  21: "remote access disabled (vehicle setting)",
  22: "remote service access disabled (vehicle setting)",
  23: "command requires account credentials",
  24: "request too large",
  25: "response too large",
  26: "repeated routing-counter",
  27: "invalid key handle",
  28: "vehicle requires response encryption",
};

/** Faults that mean the signing session is stale and a retry after re-handshake may succeed. */
export const RETRYABLE_FAULTS = new Set([6, 15]);
/** Faults that mean the virtual key is not usable on the vehicle. */
export const KEY_FAULTS = new Set([3, 4, 7]);

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

const b64ToBytes = (b64: string): Uint8Array =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const b64urlToBytes = (s: string): Uint8Array =>
  b64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));

export const bytesToB64 = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};

function pemBody(pem: string, label: string): Uint8Array | null {
  const m = pem.match(new RegExp(`-----BEGIN ${label}-----([^-]+)-----END ${label}-----`));
  return m && m[1] ? b64ToBytes(m[1].replace(/\s+/g, "")) : null;
}

/** Wraps a SEC1 EC private key DER into PKCS#8 (prime256v1) for WebCrypto import. */
function sec1ToPkcs8(sec1: Uint8Array): Uint8Array {
  const derLen = (n: number): number[] =>
    n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  const algo = [
    0x30, 0x13, // SEQUENCE (AlgorithmIdentifier)
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID ecPublicKey
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // OID prime256v1
  ];
  const octet = [0x04, ...derLen(sec1.length), ...sec1];
  const inner = [0x02, 0x01, 0x00, ...algo, ...octet];
  return new Uint8Array([0x30, ...derLen(inner.length), ...inner]);
}

export interface CommandKey {
  privateKey: CryptoKey;
  /** 65-byte uncompressed P-256 point (0x04 || X || Y). */
  publicKeyBytes: Uint8Array;
  /** PEM (SPKI) form, served at /.well-known/appspecific/com.tesla.3p.public-key.pem */
  publicKeyPem: string;
}

let cachedKey: CommandKey | null = null;

/** Imports TESLA_PRIVATE_KEY (SEC1 or PKCS#8 PEM) and derives the public key. */
export async function loadCommandKey(pem: string): Promise<CommandKey> {
  if (cachedKey) return cachedKey;
  const sec1 = pemBody(pem, "EC PRIVATE KEY");
  const pkcs8 = pemBody(pem, "PRIVATE KEY") ?? (sec1 ? sec1ToPkcs8(sec1) : null);
  if (!pkcs8) {
    throw new Error(
      "TESLA_PRIVATE_KEY is not a PEM EC private key (expected 'EC PRIVATE KEY' or 'PRIVATE KEY' block)",
    );
  }
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8.buffer as ArrayBuffer,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  if (!jwk.x || !jwk.y) throw new Error("could not derive public key from TESLA_PRIVATE_KEY");
  const x = b64urlToBytes(jwk.x);
  const y = b64urlToBytes(jwk.y);
  const publicKeyBytes = new Uint8Array(65);
  publicKeyBytes[0] = 0x04;
  publicKeyBytes.set(x, 1 + (32 - x.length));
  publicKeyBytes.set(y, 33 + (32 - y.length));

  // SPKI DER for an uncompressed P-256 point is a fixed 26-byte prefix + point.
  const spkiPrefix = new Uint8Array([
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
  ]);
  const spki = new Uint8Array(spkiPrefix.length + 65);
  spki.set(spkiPrefix);
  spki.set(publicKeyBytes, spkiPrefix.length);
  const b64 = bytesToB64(spki).replace(/(.{64})/g, "$1\n").trimEnd();
  const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;

  cachedKey = { privateKey, publicKeyBytes, publicKeyPem };
  return cachedKey;
}

// ---------------------------------------------------------------------------
// Session (per vehicle + domain handshake state)
// ---------------------------------------------------------------------------

export interface SessionInfo {
  counter: number;
  publicKey: Uint8Array;
  epoch: Uint8Array;
  clockTime: number;
  status: number; // Signatures.Session_Info_Status — 1 = key not on whitelist
}

export function decodeSessionInfo(buf: Uint8Array): SessionInfo {
  const f = pbDecode(buf);
  return {
    counter: first(f, 1)?.value ?? 0,
    publicKey: first(f, 2)?.data ?? new Uint8Array(),
    epoch: first(f, 3)?.data ?? new Uint8Array(),
    clockTime: first(f, 4)?.value ?? 0,
    status: first(f, 5)?.value ?? 0,
  };
}

export interface Session {
  counter: number;
  epoch: Uint8Array;
  /** local unix seconds minus vehicle clock — used to express expiry in vehicle time */
  clockDelta: number;
  hmacKey: CryptoKey;
}

/**
 * Derives the per-vehicle command session from the vehicle's ephemeral public
 * key: K = SHA1(ECDH shared X)[0:16]; HMAC key = HMAC-SHA256(K, "authenticated command").
 */
export async function buildSession(key: CommandKey, info: SessionInfo): Promise<Session> {
  const vehicleKey = await crypto.subtle.importKey(
    "raw",
    info.publicKey.slice().buffer as ArrayBuffer,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  // workers-types names the EcdhKeyDeriveParams field `$public`; the runtime
  // accepts the standard `public`.
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: vehicleKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
    key.privateKey,
    256,
  );
  const k = (await crypto.subtle.digest("SHA-1", shared)).slice(0, 16);
  const kKey = await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sessionKeyBytes = await crypto.subtle.sign(
    "HMAC",
    kKey,
    new TextEncoder().encode("authenticated command"),
  );
  const hmacKey = await crypto.subtle.importKey(
    "raw",
    sessionKeyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return {
    counter: info.counter,
    epoch: info.epoch,
    clockDelta: Math.floor(Date.now() / 1000) - info.clockTime,
    hmacKey,
  };
}

// ---------------------------------------------------------------------------
// RoutableMessage encode/decode
// ---------------------------------------------------------------------------

function destinationDomain(domain: number): PbWriter {
  return new PbWriter().uint32Always(1, domain);
}

function destinationRouting(address: Uint8Array): PbWriter {
  return new PbWriter().bytes(2, address);
}

export function encodeSessionInfoRequest(
  domain: DomainValue,
  publicKey: Uint8Array,
  routingAddress: Uint8Array,
): Uint8Array {
  return new PbWriter()
    .message(6, destinationDomain(domain)) // to_destination
    .message(7, destinationRouting(routingAddress)) // from_destination
    .message(14, new PbWriter().bytes(1, publicKey)) // session_info_request.public_key
    .bytes(51, crypto.getRandomValues(new Uint8Array(16))) // uuid
    .finish();
}

const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

/**
 * Signs `payload` for `domain` and wraps it in a RoutableMessage. Mutates
 * session.counter. The metadata TLV layout must match the vehicle exactly:
 * signature type, domain, VIN, epoch, expiry, counter, terminator.
 */
export async function encodeSignedCommand(
  key: CommandKey,
  session: Session,
  vin: string,
  domain: DomainValue,
  payload: Uint8Array,
  routingAddress: Uint8Array,
): Promise<Uint8Array> {
  session.counter += 1;
  const counter = session.counter;
  const expiresAt = Math.floor(Date.now() / 1000) - session.clockDelta + 15;

  const vinBytes = new TextEncoder().encode(vin);
  const metadata = new Uint8Array([
    Tag.SIGNATURE_TYPE, 1, SIGNATURE_TYPE_HMAC_PERSONALIZED,
    Tag.DOMAIN, 1, domain,
    Tag.PERSONALIZATION, vinBytes.length, ...vinBytes,
    Tag.EPOCH, session.epoch.length, ...session.epoch,
    Tag.EXPIRES_AT, 4, ...be32(expiresAt),
    Tag.COUNTER, 4, ...be32(counter),
    Tag.END,
  ]);

  const toSign = new Uint8Array(metadata.length + payload.length);
  toSign.set(metadata);
  toSign.set(payload, metadata.length);
  const tag = new Uint8Array(await crypto.subtle.sign("HMAC", session.hmacKey, toSign));

  const hmacData = new PbWriter()
    .bytes(1, session.epoch)
    .uint32(2, counter)
    .fixed32(3, expiresAt)
    .bytes(4, tag);

  const signatureData = new PbWriter()
    .message(1, new PbWriter().bytes(1, key.publicKeyBytes)) // signer_identity.public_key
    .message(8, hmacData); // HMAC_Personalized_data

  return new PbWriter()
    .message(6, destinationDomain(domain))
    .message(7, destinationRouting(routingAddress))
    .bytes(10, payload) // protobuf_message_as_bytes
    .message(13, signatureData)
    .bytes(51, crypto.getRandomValues(new Uint8Array(16)))
    .finish();
}

export interface DecodedRoutableMessage {
  fromDomain?: number;
  payload?: Uint8Array; // protobuf_message_as_bytes
  sessionInfo?: SessionInfo;
  operationStatus: number;
  fault: number;
}

export function decodeRoutableMessage(buf: Uint8Array): DecodedRoutableMessage {
  const f = pbDecode(buf);
  const out: DecodedRoutableMessage = { operationStatus: 0, fault: 0 };
  const from = first(f, 7)?.data;
  if (from) out.fromDomain = first(pbDecode(from), 1)?.value;
  out.payload = first(f, 10)?.data;
  const si = first(f, 15)?.data;
  if (si) out.sessionInfo = decodeSessionInfo(si);
  const status = first(f, 12)?.data;
  if (status) {
    const s = pbDecode(status);
    out.operationStatus = first(s, 1)?.value ?? 0;
    out.fault = first(s, 2)?.value ?? 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Domain payloads — VCSEC (vehicle security controller)
// ---------------------------------------------------------------------------

export const RKEAction = {
  UNLOCK: 0,
  LOCK: 1,
  WAKE_VEHICLE: 30,
} as const;

export function vcsecRKEAction(action: number): Uint8Array {
  // VCSEC.UnsignedMessage.RKEAction = field 2 (enum). UNLOCK is enum 0, which
  // proto3 would normally drop — force presence so the oneof is populated.
  return new PbWriter().uint32Always(2, action).finish();
}

export const ClosureMove = { MOVE: 1, STOP: 2, OPEN: 3, CLOSE: 4 } as const;

/** VCSEC.UnsignedMessage.closureMoveRequest (field 4). */
export function vcsecClosureMove(closure: "frontTrunk" | "rearTrunk" | "chargePort", move: number): Uint8Array {
  const fieldNum = { rearTrunk: 5, frontTrunk: 6, chargePort: 7 }[closure];
  return new PbWriter().message(4, new PbWriter().uint32Always(fieldNum, move)).finish();
}

export interface VcsecResult {
  ok: boolean;
  wait: boolean;
  reason: string;
}

/** Decodes VCSEC.FromVCSECMessage. */
export function decodeVcsecResponse(buf: Uint8Array): VcsecResult {
  const f = pbDecode(buf);
  const nominalError = first(f, 46)?.data;
  if (nominalError) {
    const code = first(pbDecode(nominalError), 1)?.value ?? 0;
    return { ok: false, wait: false, reason: `vehicle reported error code ${code}` };
  }
  const commandStatus = first(f, 4)?.data;
  if (commandStatus) {
    const status = first(pbDecode(commandStatus), 1)?.value ?? 0;
    if (status === OPERATION_STATUS.OK) return { ok: true, wait: false, reason: "" };
    if (status === OPERATION_STATUS.WAIT) return { ok: false, wait: true, reason: "vehicle busy" };
    return { ok: false, wait: false, reason: "vehicle security controller rejected the command" };
  }
  // vehicleStatus or empty ack — treat as success.
  return { ok: true, wait: false, reason: "" };
}

// ---------------------------------------------------------------------------
// Domain payloads — Infotainment (CarServer.Action, field numbers from car_server.proto)
// ---------------------------------------------------------------------------

/** Wraps a VehicleAction submessage writer into CarServer.Action bytes. */
function carAction(field: number, action: PbWriter): Uint8Array {
  return new PbWriter().message(2, new PbWriter().message(field, action)).finish();
}

export const CarServer = {
  chargingSetLimit(percent: number): Uint8Array {
    return carAction(5, new PbWriter().uint32(1, percent));
  },
  chargingStart(): Uint8Array {
    return carAction(6, new PbWriter().message(2, new PbWriter())); // start = Void
  },
  chargingStop(): Uint8Array {
    return carAction(6, new PbWriter().message(5, new PbWriter())); // stop = Void
  },
  hvacAuto(on: boolean): Uint8Array {
    return carAction(10, new PbWriter().bool(1, on));
  },
  setTemperature(driverC: number, passengerC: number): Uint8Array {
    return carAction(14, new PbWriter().float(6, driverC).float(7, passengerC));
  },
  flashLights(): Uint8Array {
    return carAction(26, new PbWriter());
  },
  honkHorn(): Uint8Array {
    return carAction(27, new PbWriter());
  },
  /** ChargeSchedule (common.proto) sent as addChargeScheduleAction. */
  addChargeSchedule(s: {
    id?: number;
    name?: string;
    daysOfWeek: number;
    enabled: boolean;
    startTime?: number;
    endTime?: number;
    oneTime?: boolean;
    latitude: number;
    longitude: number;
  }): Uint8Array {
    const w = new PbWriter();
    if (s.id !== undefined) w.uint32(1, s.id);
    if (s.name) w.string(2, s.name);
    w.uint32(3, s.daysOfWeek);
    w.bool(4, s.startTime !== undefined);
    if (s.startTime !== undefined) w.uint32(5, s.startTime);
    w.bool(6, s.endTime !== undefined);
    if (s.endTime !== undefined) w.uint32(7, s.endTime);
    if (s.oneTime) w.bool(8, true);
    w.bool(9, s.enabled);
    w.float(10, s.latitude).float(11, s.longitude);
    return carAction(97, w);
  },
  removeChargeSchedule(id: number): Uint8Array {
    return carAction(98, new PbWriter().uint32(1, id));
  },
  /** PreconditionSchedule (common.proto) sent as addPreconditionScheduleAction. */
  addPreconditionSchedule(s: {
    id?: number;
    name?: string;
    daysOfWeek: number;
    enabled: boolean;
    preconditionTime: number;
    oneTime?: boolean;
    latitude: number;
    longitude: number;
  }): Uint8Array {
    const w = new PbWriter();
    if (s.id !== undefined) w.uint32(1, s.id);
    if (s.name) w.string(2, s.name);
    w.uint32(3, s.daysOfWeek);
    w.uint32(4, s.preconditionTime);
    if (s.oneTime) w.bool(5, true);
    w.bool(6, s.enabled);
    w.float(7, s.latitude).float(8, s.longitude);
    return carAction(99, w);
  },
  removePreconditionSchedule(id: number): Uint8Array {
    return carAction(100, new PbWriter().uint32(1, id));
  },
};

export interface CarServerResult {
  ok: boolean;
  reason: string;
}

/** Decodes CarServer.Response → actionStatus. */
export function decodeCarServerResponse(buf: Uint8Array): CarServerResult {
  const f = pbDecode(buf);
  const actionStatus = first(f, 1)?.data;
  if (!actionStatus) return { ok: true, reason: "" };
  const s = pbDecode(actionStatus);
  const result = first(s, 1)?.value ?? 0;
  let reason = "";
  const rr = first(s, 2)?.data;
  if (rr) {
    const plain = first(pbDecode(rr), 1)?.data;
    if (plain) reason = new TextDecoder().decode(plain);
  }
  return { ok: result === OPERATION_STATUS.OK, reason };
}
