import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  isMcpAuthorized,
  timingSafeEqual,
  handleOauthAuthorize,
  handleOauthToken,
  getOwnerToken,
  ownerGrantPresent,
} from "../src/auth";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

function makeEnv(kv = new FakeKV()): Env {
  return {
    TESLA_KV: kv as unknown as KVNamespace,
    DB: {} as D1Database,
    TESLA_REGION: "eu",
    PUBLIC_ORIGIN: "https://test.example.com",
    TESLA_CLIENT_ID: "cid",
    TESLA_CLIENT_SECRET: "csecret",
    TESLA_PRIVATE_KEY: "pk",
    MCP_AUTH_TOKEN: "the-static-token",
  } as Env;
}

const bearer = (t: string) => new Request("https://x/mcp", { headers: { authorization: `Bearer ${t}` } });

describe("timingSafeEqual", () => {
  it("matches equal strings and rejects unequal / different-length", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("isMcpAuthorized token-type separation", () => {
  let kv: FakeKV;
  let env: Env;
  beforeEach(() => { kv = new FakeKV(); env = makeEnv(kv); });

  it("accepts the static MCP_AUTH_TOKEN", async () => {
    expect(await isMcpAuthorized(bearer("the-static-token"), env)).toBe(true);
  });

  it("accepts a shim access token but REJECTS a shim refresh token", async () => {
    // Regression: both were stored under mcp_oauth_token: and accepted on key
    // existence, so a refresh token worked as a full /mcp bearer.
    await kv.put("mcp_oauth_token:access-abc", "access");
    await kv.put("mcp_oauth_token:refresh-xyz", "refresh");
    expect(await isMcpAuthorized(bearer("access-abc"), env)).toBe(true);
    expect(await isMcpAuthorized(bearer("refresh-xyz"), env)).toBe(false);
  });

  it("rejects an unknown / missing bearer", async () => {
    expect(await isMcpAuthorized(bearer("nope"), env)).toBe(false);
    expect(await isMcpAuthorized(new Request("https://x/mcp"), env)).toBe(false);
  });
});

describe("OAuth shim PKCE enforcement", () => {
  it("rejects an authorize request with no code_challenge (OAuth 2.1)", async () => {
    const env = makeEnv();
    const url = "https://test.example.com/oauth/authorize?redirect_uri=" +
      encodeURIComponent("https://claude.ai/cb") + "&state=s";
    const resp = await handleOauthAuthorize(new Request(url, { method: "GET" }), env);
    expect(resp.status).toBe(400);
    expect(await resp.text()).toMatch(/code_challenge required/);
  });

  it("rejects a non-S256 challenge method", async () => {
    const env = makeEnv();
    const url = "https://test.example.com/oauth/authorize?redirect_uri=" +
      encodeURIComponent("https://claude.ai/cb") + "&code_challenge=abc&code_challenge_method=plain";
    const resp = await handleOauthAuthorize(new Request(url, { method: "GET" }), env);
    expect(resp.status).toBe(400);
  });

  it("token endpoint rejects a code with a wrong PKCE verifier", async () => {
    const kv = new FakeKV();
    const env = makeEnv(kv);
    await kv.put("mcp_oauth_code:CODE1", JSON.stringify({ redirectUri: "https://claude.ai/cb", codeChallenge: "not-the-hash" }));
    const body = new URLSearchParams({ grant_type: "authorization_code", code: "CODE1", redirect_uri: "https://claude.ai/cb", code_verifier: "some-verifier" });
    const resp = await handleOauthToken(new Request("https://x/oauth/token", { method: "POST", body }), env);
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toBe("invalid_grant");
  });
});

describe("getOwnerToken single-flight + rotation", () => {
  let kv: FakeKV;
  let env: Env;
  beforeEach(() => {
    kv = new FakeKV();
    env = makeEnv(kv);
  });
  afterEach(() => vi.restoreAllMocks());

  it("coalesces concurrent refreshes into one upstream call", async () => {
    await kv.put("tesla:refresh_token", "R0");
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ access_token: "A1", refresh_token: "R1", expires_in: 3600, token_type: "Bearer" }), { status: 200 });
    }));
    const [a, b, c] = await Promise.all([getOwnerToken(env), getOwnerToken(env), getOwnerToken(env)]);
    expect([a, b, c]).toEqual(["A1", "A1", "A1"]);
    expect(calls).toBe(1); // single-flight: not three refreshes
    expect(await kv.get("tesla:refresh_token")).toBe("R1"); // rotated token persisted
  });

  it("stores the rotated refresh token before the access token (survives a failed second put)", async () => {
    await kv.put("tesla:refresh_token", "R0");
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "A1", refresh_token: "R1", expires_in: 3600, token_type: "Bearer" }), { status: 200 })));
    await getOwnerToken(env);
    expect(await kv.get("tesla:refresh_token")).toBe("R1");
    expect(await ownerGrantPresent(env)).toBe(true);
  });
});
