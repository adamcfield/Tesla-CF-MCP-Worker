/**
 * Regression tests for the Tesla 403 EXCEEDED_LIMIT budget backstop
 * (detectExceededLimit → forceBudgetCeiling): every fetch path that talks to
 * the Fleet API must pin the spend ledger at the hard ceiling when Tesla
 * reports the billing limit was exceeded — and must AWAIT that pin before
 * throwing, since in Workers a detached promise can be cancelled once the
 * response is sent.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { wakeVehicle } from "../src/api";
import { lockDoors } from "../src/commands";
import { getTelemetryConfig } from "../src/telemetry";
import { getBudgetStatus, HARD_CEILING } from "../src/budget";
import { resetSchemaCacheForTests } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import { TeslaError, type Env } from "../src/types";

const VIN = "TESTVINLIMIT00001";

// Same throwaway P-256 key as protocol.test.ts — needed by the signed-command
// path (loadCommandKey caches it module-globally, which is fine per test file).
const PKCS8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgQdDFqMWH5J2vPQ+a
ZmpFoWFCyYUo9KhdvJ7vsgFlNnWhRANCAAT+9f5vHuhVoF0tffZf8FuQz1gbDTHe
WZGsXU1FPS0fXIWelbnFE0iesx6nJcWBWeb8HCINPmw9TtuXmcArMt6J
-----END PRIVATE KEY-----`;

const EXCEEDED_BODY = JSON.stringify({
  response: null,
  error: "Account or partner has exceeded its billing limit (EXCEEDED_LIMIT)",
});

function makeEnv(): Env {
  resetSchemaCacheForTests();
  const kv = new FakeKV();
  // Seed the rotated refresh token so getOwnerToken goes through the stubbed
  // token endpoint instead of failing on "no refresh token".
  void kv.put("tesla:refresh_token", "R0");
  return {
    TESLA_KV: kv as unknown as KVNamespace,
    DB: new FakeD1() as unknown as D1Database,
    TESLA_REGION: "eu",
    PUBLIC_ORIGIN: "https://test.example.com",
    TESLA_CLIENT_ID: "cid",
    TESLA_CLIENT_SECRET: "csecret",
    TESLA_PRIVATE_KEY: PKCS8,
    MCP_AUTH_TOKEN: "tok",
  } as Env;
}

/** Stubs global fetch: token refresh always succeeds, everything else goes to `handler`. */
function stubTesla(handler: (url: string) => Response | undefined): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.includes("/oauth2/v3/token")) {
        return new Response(
          JSON.stringify({ access_token: "A", refresh_token: "R1", expires_in: 3600, token_type: "Bearer" }),
          { status: 200 },
        );
      }
      const resp = handler(u);
      if (!resp) throw new Error(`unexpected fetch in test: ${u}`);
      return resp;
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("403 EXCEEDED_LIMIT pins the spend ledger on every Fleet API fetch path", () => {
  it("fleetPost (wake_up): pins BEFORE the error propagates — awaited, not detached", async () => {
    const env = makeEnv();
    stubTesla((u) =>
      u.includes("/wake_up") ? new Response(EXCEEDED_BODY, { status: 403 }) : undefined,
    );

    // Hold the ceiling-pin upsert (the only statement here using
    // MAX(micro, …)) until released: if the 403 path awaited the pin, the
    // wake promise cannot settle while the gate is closed. A detached
    // detectExceededLimit (the old bug) would let the throw win the race.
    let releasePin!: () => void;
    const pinGate = new Promise<void>((r) => (releasePin = r));
    const db = env.DB as unknown as FakeD1;
    const origPrepare = db.prepare.bind(db);
    const gated = (stmt: ReturnType<FakeD1["prepare"]>): ReturnType<FakeD1["prepare"]> =>
      ({
        bind: (...args: unknown[]) => gated(stmt.bind(...args)),
        run: async () => {
          await pinGate;
          return stmt.run();
        },
        first: (col?: string) => stmt.first(col),
        all: () => stmt.all(),
      }) as unknown as ReturnType<FakeD1["prepare"]>;
    (db as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const stmt = origPrepare(sql);
      return /MAX\(micro/.test(sql) ? gated(stmt) : stmt;
    };

    let settled = false;
    const wake = wakeVehicle(env, VIN).then(
      () => {
        settled = true;
        return null;
      },
      (e: unknown) => {
        settled = true;
        return e;
      },
    );
    await new Promise((r) => setTimeout(r, 25));
    expect(settled).toBe(false); // still awaiting forceBudgetCeiling
    releasePin();
    const err = (await wake) as TeslaError;
    expect(err).toBeInstanceOf(TeslaError);
    expect(err.status).toBe(403);

    const s = await getBudgetStatus(env);
    expect(s.spent_micro).toBe(HARD_CEILING);
    expect(s.poll_allowed).toBe(false);
    expect(s.commands_allowed).toBe(false);
  });

  it("sendRoutable (signed_command): a billing-limit 403 on a command closes every gate", async () => {
    const env = makeEnv();
    stubTesla((u) =>
      u.includes("/signed_command") ? new Response(EXCEEDED_BODY, { status: 403 }) : undefined,
    );

    await expect(lockDoors(env, VIN)).rejects.toThrow(/signed_command failed \(403\)/);

    const s = await getBudgetStatus(env);
    expect(s.spent_micro).toBe(HARD_CEILING);
    expect(s.poll_allowed).toBe(false);
    expect(s.commands_allowed).toBe(false);
  });

  it("fleetRequest (fleet_telemetry_config): a billing-limit 403 on a config read closes every gate", async () => {
    const env = makeEnv();
    stubTesla((u) =>
      u.includes("/fleet_telemetry_config") ? new Response(EXCEEDED_BODY, { status: 403 }) : undefined,
    );

    await expect(getTelemetryConfig(env, VIN)).rejects.toThrow(/GET .* failed \(403\)/);

    const s = await getBudgetStatus(env);
    expect(s.spent_micro).toBe(HARD_CEILING);
    expect(s.poll_allowed).toBe(false);
    expect(s.commands_allowed).toBe(false);
  });

  it("an ordinary 403 (no billing-limit marker) leaves the ledger untouched", async () => {
    const env = makeEnv();
    stubTesla((u) =>
      u.includes("/fleet_telemetry_config")
        ? new Response(JSON.stringify({ error: "unauthorized: missing scope" }), { status: 403 })
        : undefined,
    );

    await expect(getTelemetryConfig(env, VIN)).rejects.toThrow(/failed \(403\)/);

    const s = await getBudgetStatus(env);
    expect(s.spent_micro).toBe(0);
    expect(s.poll_allowed).toBe(true);
    expect(s.commands_allowed).toBe(true);
  });
});
