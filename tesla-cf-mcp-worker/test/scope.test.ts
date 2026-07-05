/**
 * Server-side token-scope enforcement: a READ token must never be able to
 * reach a command tool through /mcp, and device tokens must mint/authorize/
 * revoke correctly. This is the property that makes a leaked dashboard link
 * a privacy issue instead of a physical-access issue.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mintDeviceToken, revokeDeviceToken, tokenScope } from "../src/auth";
import { handleMcp } from "../src/mcp";
import { resetSchemaCacheForTests, tzOffsetMinutes } from "../src/store";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

function makeEnv(kv = new FakeKV()): Env {
  resetSchemaCacheForTests();
  return {
    TESLA_KV: kv as unknown as KVNamespace,
    DB: new FakeD1() as unknown as D1Database,
    TESLA_REGION: "eu",
    PUBLIC_ORIGIN: "https://test.example.com",
    TESLA_CLIENT_ID: "cid",
    TESLA_CLIENT_SECRET: "csecret",
    TESLA_PRIVATE_KEY: "pk",
    MCP_AUTH_TOKEN: "master-token",
  } as Env;
}

const rpc = (name: string, args: Record<string, unknown> = {}) =>
  new Request("https://test.example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });

const listReq = () =>
  new Request("https://test.example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

describe("device tokens", () => {
  let env: Env;
  beforeEach(() => {
    env = makeEnv();
  });

  it("mint → read scope; master → full; junk → null", async () => {
    const minted = await mintDeviceToken(env, "phone");
    expect(minted.token).toMatch(/^[0-9a-f]{64}$/);
    expect(await tokenScope(env, minted.token)).toBe("read");
    expect(await tokenScope(env, "master-token")).toBe("full");
    expect(await tokenScope(env, "not-a-token")).toBeNull();
  });

  it("revoke by id kills the token", async () => {
    const minted = await mintDeviceToken(env, "phone");
    expect(await revokeDeviceToken(env, minted.id)).toBe(1);
    expect(await tokenScope(env, minted.token)).toBeNull();
  });
});

describe("read-scope MCP enforcement", () => {
  let env: Env;
  beforeEach(() => {
    env = makeEnv();
  });

  it("blocks commands AND billed live reads for read scope, allows free reads", async () => {
    // Commands + wake + config writes, AND the money-costing live-read tools:
    // a leaked read token must not be able to command the car OR burn budget.
    for (const tool of [
      "unlock", "honk_horn", "actuate_frunk", "wake_vehicle", "set_automation", "configure_telemetry",
      "get_vehicle_data", "get_charge_state", "get_climate_state", "get_location",
    ]) {
      const resp = await handleMcp(rpc(tool, { vin: "V" }), env, "read");
      const body = (await resp.json()) as any;
      expect(body.result?.isError, tool).toBe(true);
      expect(body.result?.content?.[0]?.text, tool).toContain("READ-ONLY");
    }
    // A free/derived read goes through (fails later on business logic, NOT scope).
    const ok = await handleMcp(rpc("get_drives", { vin: "V" }), env, "read");
    const okBody = (await ok.json()) as any;
    expect(okBody.result?.content?.[0]?.text ?? "").not.toContain("READ-ONLY");
  });

  it("tools/list hides commands AND billed live reads from read scope", async () => {
    const readList = (await (await handleMcp(listReq(), env, "read")).json()) as any;
    const names = readList.result.tools.map((t: any) => t.name);
    expect(names).toContain("get_drives");
    expect(names).toContain("get_monthly_report");
    expect(names).not.toContain("unlock");
    expect(names).not.toContain("wake_vehicle");
    expect(names).not.toContain("get_vehicle_data"); // billed → excluded from read scope

    const fullList = (await (await handleMcp(listReq(), env, "full")).json()) as any;
    const fullNames = fullList.result.tools.map((t: any) => t.name);
    expect(fullNames).toContain("unlock");
    expect(fullNames).toContain("get_vehicle_data");
  });
});

describe("tzOffsetMinutes (DST-aware)", () => {
  it("resolves Israel standard vs daylight time", () => {
    const winter = Date.UTC(2026, 0, 15); // January → IST (+2)
    const summer = Date.UTC(2026, 6, 15); // July → IDT (+3)
    expect(tzOffsetMinutes("Asia/Jerusalem", winter)).toBe(120);
    expect(tzOffsetMinutes("Asia/Jerusalem", summer)).toBe(180);
    expect(tzOffsetMinutes("Etc/UTC", summer)).toBe(0);
    expect(tzOffsetMinutes("Not/AZone", summer)).toBeNull();
  });
});
