/**
 * /data/automations — rule CRUD for the dashboard's Automations screen.
 *
 * This route is deliberately stricter than every other /data route, which a
 * read-scope device token can reach. Two reasons, both pinned below:
 *
 *   - An automation is code that runs against the car. geofence.on_enter and
 *     alert.actions execute commands, so whoever can write a rule can actuate
 *     the vehicle. A read-scope token that could write rules would walk
 *     straight past the read/full split.
 *   - A rule's notify[] URLs are credentials in practice — ntfy/Pushover/Home
 *     Assistant endpoints usually carry their token in the URL — so even
 *     LISTING rules is full-scope.
 *
 * Command payloads are refused outright rather than stripped, so a caller is
 * never left believing it saved a rule that acts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import { mintDeviceToken } from "../src/auth";
import { getAutomations } from "../src/rules";
import { resetSchemaCacheForTests } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINAUTOAPI001";

function makeEnv(): Env {
  resetSchemaCacheForTests();
  return {
    TESLA_KV: new FakeKV() as unknown as KVNamespace,
    DB: new FakeD1() as unknown as D1Database,
    TESLA_REGION: "eu",
    PUBLIC_ORIGIN: "https://test.example.com",
    TESLA_CLIENT_ID: "cid",
    TESLA_CLIENT_SECRET: "csecret",
    TESLA_PRIVATE_KEY: "pk",
    MCP_AUTH_TOKEN: "master-token",
  } as Env;
}

const ctx = (): ExecutionContext =>
  ({
    waitUntil: (p: Promise<unknown>) => { void Promise.resolve(p).catch(() => {}); },
    passThroughOnException: () => {},
    props: {},
  }) as unknown as ExecutionContext;

function req(method: string, query = "", body?: unknown, token = "master-token"): Request {
  return new Request(`https://test.example.com/data/automations${query}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("/data/automations", () => {
  let env: Env;
  beforeEach(() => {
    env = makeEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));
  });

  it("round-trips a notification rule through POST → GET → DELETE", async () => {
    const rule = { id: "r1", type: "alert", vin: VIN, when: "drive_started", enabled: true };
    const created = await worker.fetch(req("POST", "", rule), env, ctx());
    expect(created.status).toBe(200);

    const listed = await worker.fetch(req("GET"), env, ctx());
    expect(listed.status).toBe(200);
    const rows = (await listed.json()) as Array<{ id: string; when: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].when).toBe("drive_started");

    const deleted = await worker.fetch(req("DELETE", "?id=r1"), env, ctx());
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(await getAutomations(env)).toHaveLength(0);
  });

  it("refuses a read-scope device token on every verb", async () => {
    // The escalation this route exists to prevent: a shared dashboard link
    // must not be able to author something that drives the car.
    const device = await mintDeviceToken(env, "phone");
    for (const [method, query, body] of [
      ["GET", "", undefined],
      ["POST", "", { type: "alert", vin: VIN, when: "drive_started" }],
      ["DELETE", "?id=r1", undefined],
    ] as const) {
      const resp = await worker.fetch(req(method, query, body, device.token), env, ctx());
      expect(resp.status).toBe(403);
    }
  });

  it("rejects command payloads instead of silently stripping them", async () => {
    for (const key of ["actions", "on_enter", "on_exit"]) {
      const resp = await worker.fetch(
        req("POST", "", { type: "geofence", vin: VIN, lat: 32, lon: 34, [key]: [{ command: "unlock" }] }),
        env,
        ctx(),
      );
      expect(resp.status).toBe(400);
      expect(JSON.stringify(await resp.json())).toContain(key);
    }
    // Nothing was persisted by the refused writes.
    expect(await getAutomations(env)).toHaveLength(0);
  });

  it("accepts a rule carrying an empty command array (nothing to actuate)", async () => {
    const resp = await worker.fetch(
      req("POST", "", { id: "g1", type: "geofence", vin: VIN, lat: 32, lon: 34, on_enter: [] }),
      env,
      ctx(),
    );
    expect(resp.status).toBe(200);
    expect(await getAutomations(env)).toHaveLength(1);
  });

  it("validates the body and the delete id", async () => {
    expect((await worker.fetch(req("POST", "", { vin: VIN }), env, ctx())).status).toBe(400);
    expect((await worker.fetch(req("POST", "", { type: "alert" }), env, ctx())).status).toBe(400);
    expect((await worker.fetch(req("DELETE"), env, ctx())).status).toBe(400);
  });

  it("rejects an unknown verb", async () => {
    expect((await worker.fetch(req("PUT", "", { type: "alert", vin: VIN }), env, ctx())).status).toBe(405);
  });
});
