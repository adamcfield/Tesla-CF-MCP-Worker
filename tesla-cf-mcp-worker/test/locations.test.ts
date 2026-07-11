/**
 * Locations: named geofences can optionally be tagged with which household
 * driver(s) they belong to (e.g. "Home" tagged to everyone, "Work" tagged to
 * just one driver). Untagged (the default, and every pre-existing row before
 * this feature) means shared/no restriction — never null-vs-undefined
 * confusion leaking into the API surface, always a clean string[].
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ensureSchema, resetSchemaCacheForTests } from "../src/store";
import { setLocation, listLocations, getLocationStats } from "../src/tracking";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

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
    MCP_AUTH_TOKEN: "tok",
  } as Env;
}

describe("locations — driver tags", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
    // listLocations lazily reverse-geocodes address-less places — keep tests
    // hermetic (404 → negative-cached, address stays null).
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("creates a location with no driver tags (untagged/shared) by default", async () => {
    const { id } = await setLocation(env, { name: "Home", lat: 32.1, lon: 34.8 });
    const locs = await listLocations(env);
    expect(locs.find((l) => l.id === id)?.drivers).toEqual([]);
  });

  it("tags a location to multiple drivers at creation", async () => {
    const { id } = await setLocation(env, { name: "Home", lat: 32.1, lon: 34.8, drivers: ["Adam", "Sara"] });
    const locs = await listLocations(env);
    expect(locs.find((l) => l.id === id)?.drivers).toEqual(["Adam", "Sara"]);
  });

  it("tags a location to a single driver", async () => {
    const { id } = await setLocation(env, { name: "Work", lat: 32.05, lon: 34.75, drivers: ["Sara"] });
    const stats = (await getLocationStats(env, id)) as { location: { drivers: string[] } };
    expect(stats.location.drivers).toEqual(["Sara"]);
  });

  it("updating a location WITHOUT passing drivers leaves existing tags untouched", async () => {
    const { id } = await setLocation(env, { name: "Work", lat: 32.05, lon: 34.75, drivers: ["Sara"] });
    await setLocation(env, { id, name: "Work (renamed)", lat: 32.05, lon: 34.75 });
    const locs = await listLocations(env);
    const loc = locs.find((l) => l.id === id)!;
    expect(loc.name).toBe("Work (renamed)");
    expect(loc.drivers).toEqual(["Sara"]);
  });

  it("updating a location WITH an empty drivers array explicitly clears tags", async () => {
    const { id } = await setLocation(env, { name: "Work", lat: 32.05, lon: 34.75, drivers: ["Sara"] });
    await setLocation(env, { id, name: "Work", lat: 32.05, lon: 34.75, drivers: [] });
    const locs = await listLocations(env);
    expect(locs.find((l) => l.id === id)?.drivers).toEqual([]);
  });

  it("blank/whitespace-only driver names are dropped", async () => {
    const { id } = await setLocation(env, { name: "Home", lat: 32.1, lon: 34.8, drivers: ["Adam", "  ", ""] });
    const locs = await listLocations(env);
    expect(locs.find((l) => l.id === id)?.drivers).toEqual(["Adam"]);
  });
});
