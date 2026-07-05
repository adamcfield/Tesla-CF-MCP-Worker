import { describe, it, expect } from "vitest";
import {
  PbWriter,
  pbDecode,
  CarServer,
  vcsecRKEAction,
  RKEAction,
  decodeRoutableMessage,
  loadCommandKey,
} from "../src/protocol";

describe("PbWriter varint", () => {
  it("round-trips a small uint32 field", () => {
    const buf = new PbWriter().uint32(1, 300).finish();
    const [f] = pbDecode(buf);
    expect(f.field).toBe(1);
    expect(f.value).toBe(300);
  });

  it("encodes a uint64 schedule id above 2^32 without truncation", () => {
    // Regression: bitwise `>>> 0` reduced values mod 2^32. 5_000_000_000
    // would have become 705_032_704 and targeted the wrong schedule.
    const id = 5_000_000_000;
    const buf = CarServer.removeChargeSchedule(id);
    // carAction wraps: field 2 (action) -> field 98 (removeChargeSchedule) -> field 1 (id)
    const top = pbDecode(buf).find((f) => f.field === 2)!;
    const action = pbDecode(top.data!).find((f) => f.field === 98)!;
    const idField = pbDecode(action.data!).find((f) => f.field === 1)!;
    expect(idField.value).toBe(id);
  });

  it("throws on a value beyond MAX_SAFE_INTEGER rather than silently corrupting", () => {
    expect(() => new PbWriter().uint32(1, Number.MAX_SAFE_INTEGER + 2).finish()).toThrow();
  });

  it("throws on a negative varint", () => {
    expect(() => new PbWriter().uint32(1, -1).finish()).toThrow();
  });

  it("omits a zero uint32 (proto3 default) but keeps it with uint32Always", () => {
    expect(new PbWriter().uint32(1, 0).finish().length).toBe(0);
    expect(new PbWriter().uint32Always(1, 0).finish().length).toBeGreaterThan(0);
  });
});

describe("pbDecode", () => {
  it("throws on a truncated varint instead of returning garbage", () => {
    expect(() => pbDecode(new Uint8Array([0x08, 0x80]))).toThrow(/truncated/);
  });

  it("decodes length-delimited and fixed32 fields", () => {
    const inner = new TextEncoder().encode("hi");
    const buf = new PbWriter().bytes(2, inner).fixed32(3, 0x01020304).finish();
    const fields = pbDecode(buf);
    expect(fields.find((f) => f.field === 2)!.data).toEqual(inner);
    expect(fields.find((f) => f.field === 3)!.value).toBe(0x01020304);
  });
});

describe("VCSEC / CarServer payloads", () => {
  it("forces presence of the UNLOCK action (enum 0)", () => {
    // UNLOCK is enum 0; proto3 would drop it, leaving the oneof empty.
    const buf = vcsecRKEAction(RKEAction.UNLOCK);
    expect(buf.length).toBeGreaterThan(0);
    expect(pbDecode(buf).find((f) => f.field === 2)!.value).toBe(0);
  });

  it("encodes a charge-limit percentage", () => {
    const buf = CarServer.chargingSetLimit(80);
    const action = pbDecode(buf).find((f) => f.field === 2)!;
    const setLimit = pbDecode(action.data!).find((f) => f.field === 5)!;
    expect(pbDecode(setLimit.data!).find((f) => f.field === 1)!.value).toBe(80);
  });
});

describe("decodeRoutableMessage", () => {
  it("extracts operationStatus and fault from a status submessage", () => {
    const status = new PbWriter().uint32Always(1, 1).uint32Always(2, 6).finish(); // WAIT, fault 6
    const msg = new PbWriter().bytes(12, status).finish();
    const decoded = decodeRoutableMessage(msg);
    expect(decoded.operationStatus).toBe(1);
    expect(decoded.fault).toBe(6);
  });

  it("defaults to OK/no-fault on an empty message", () => {
    const decoded = decodeRoutableMessage(new Uint8Array());
    expect(decoded.operationStatus).toBe(0);
    expect(decoded.fault).toBe(0);
  });
});

describe("loadCommandKey", () => {
  const PKCS8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgQdDFqMWH5J2vPQ+a
ZmpFoWFCyYUo9KhdvJ7vsgFlNnWhRANCAAT+9f5vHuhVoF0tffZf8FuQz1gbDTHe
WZGsXU1FPS0fXIWelbnFE0iesx6nJcWBWeb8HCINPmw9TtuXmcArMt6J
-----END PRIVATE KEY-----`;

  // loadCommandKey caches the first key module-globally (the worker only ever
  // has one), so the reject case must run before any successful import.
  it("rejects a non-PEM secret with a clear error (before any key is cached)", async () => {
    await expect(loadCommandKey("not a pem")).rejects.toThrow(/PEM EC private key/);
  });

  it("imports a PKCS#8 EC key and derives a 65-byte uncompressed public point", async () => {
    const key = await loadCommandKey(PKCS8);
    expect(key.publicKeyBytes.length).toBe(65);
    expect(key.publicKeyBytes[0]).toBe(0x04);
    expect(key.publicKeyPem).toContain("BEGIN PUBLIC KEY");
  });
});
