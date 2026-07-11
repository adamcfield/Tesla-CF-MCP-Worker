/**
 * Places upgrades: per-place usage stats + editable/lazily-geocoded addresses
 * on the list, and the full at-this-place event history (arrivals, departures,
 * charges) that powers the place detail page.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ensureSchema, resetSchemaCacheForTests } from "../src/store";
import { setLocation, listLocations, getLocationHistory } from "../src/tracking";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINPLACES0001";

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

let env: Env;
beforeEach(async () => {
  env = makeEnv();
  await ensureSchema(env);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
});
afterEach(() => vi.unstubAllGlobals());

async function seedActivity(locId: number): Promise<void> {
  // Two arrivals (one with a driver), one departure, one completed charge.
  await env.DB.prepare(
    `INSERT INTO drives (vin, start_ts, end_ts, status, end_location_id, distance_km, driver, start_address)
     VALUES (?1, 100, 200, 'complete', ?2, 12.5, 'Adam', 'Herzliya Marina')`,
  ).bind(VIN, locId).run();
  await env.DB.prepare(
    `INSERT INTO drives (vin, start_ts, end_ts, status, end_location_id, distance_km)
     VALUES (?1, 300, 400, 'complete', ?2, 3.2)`,
  ).bind(VIN, locId).run();
  await env.DB.prepare(
    `INSERT INTO drives (vin, start_ts, end_ts, status, start_location_id, distance_km, end_address)
     VALUES (?1, 500, 600, 'complete', ?2, 8.0, 'IKEA Netanya')`,
  ).bind(VIN, locId).run();
  await env.DB.prepare(
    `INSERT INTO charge_sessions (vin, start_ts, end_ts, status, location_id, energy_added_kwh, start_soc, end_soc, cost)
     VALUES (?1, 350, 380, 'complete', ?2, 12.7, 62, 80, 6.4)`,
  ).bind(VIN, locId).run();
  // Noise that must NOT count: an active (unfinished) drive to this place.
  await env.DB.prepare(
    `INSERT INTO drives (vin, start_ts, status, end_location_id) VALUES (?1, 700, 'active', ?2)`,
  ).bind(VIN, locId).run();
}

describe("places list stats + address", () => {
  it("returns visits/departures/charge totals and last-visit per place", async () => {
    const { id } = await setLocation(env, { name: "Home", lat: 32.1, lon: 34.8, address: "Namir Rd 12, Tel Aviv" });
    await seedActivity(id);
    const loc = (await listLocations(env)).find((l) => l.id === id) as Record<string, unknown>;
    expect(loc.address).toBe("Namir Rd 12, Tel Aviv");
    expect(loc.visits).toBe(2);
    expect(loc.departures).toBe(1);
    expect(loc.charge_count).toBe(1);
    expect(loc.charge_kwh).toBe(12.7);
    expect(loc.last_visit_ts).toBe(400);
  });

  it("address survives an update that omits it, and clears on empty string", async () => {
    const { id } = await setLocation(env, { name: "Home", lat: 32.1, lon: 34.8, address: "Namir Rd 12" });
    await setLocation(env, { id, name: "Home Sweet Home", lat: 32.1, lon: 34.8 });
    let loc = (await listLocations(env)).find((l) => l.id === id) as Record<string, unknown>;
    expect(loc.name).toBe("Home Sweet Home");
    expect(loc.address).toBe("Namir Rd 12");
    await setLocation(env, { id, name: "Home Sweet Home", lat: 32.1, lon: 34.8, address: "" });
    loc = (await listLocations(env)).find((l) => l.id === id) as Record<string, unknown>;
    expect(loc.address ?? null).toBeNull(); // cleared; geocode stub 404s so it stays empty
  });

  it("lazily fills a missing address from the geocoder and persists it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ address: { road: "Namir Rd", city: "Tel Aviv" }, display_name: "Namir Rd, Tel Aviv, Israel" }), { status: 200 }),
    ));
    const { id } = await setLocation(env, { name: "Home", lat: 32.1, lon: 34.8 });
    const first = (await listLocations(env)).find((l) => l.id === id) as Record<string, unknown>;
    expect(typeof first.address).toBe("string");
    expect((first.address as string).length).toBeGreaterThan(0);
    // Persisted: a second list call reads it from the row, not the geocoder.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no second lookup"); }));
    const second = (await listLocations(env)).find((l) => l.id === id) as Record<string, unknown>;
    expect(second.address).toBe(first.address);
  });
});

describe("place event history", () => {
  it("merges arrivals, departures and charges newest-first with click-through ids", async () => {
    const { id } = await setLocation(env, { name: "Home", lat: 32.1, lon: 34.8, address: "x" });
    await seedActivity(id);
    const h = (await getLocationHistory(env, id)) as { location: { name: string }; events: Array<Record<string, unknown>> };
    expect(h.location.name).toBe("Home");
    expect(h.events.map((e) => e.kind)).toEqual(["departure", "arrival", "charge", "arrival"]);
    const charge = h.events.find((e) => e.kind === "charge")!;
    expect(charge.energy_added_kwh).toBe(12.7);
    expect(charge.start_soc).toBe(62);
    const arrival = h.events[3];
    expect(arrival.other_address).toBe("Herzliya Marina"); // came FROM there
    expect(arrival.driver).toBe("Adam");
    expect(typeof arrival.id).toBe("number"); // click-through to the drive
  });

  it("404s cleanly for an unknown place", async () => {
    const h = (await getLocationHistory(env, 9999)) as { error?: string };
    expect(h.error).toBe("location not found");
  });
});
