/**
 * getMediaStats: turns MediaNowPlaying* telemetry (stored generically in
 * telemetry_events) into "most played" leaderboards. A play is counted on
 * each VALUE CHANGE, not per sample — repeated identical readings while a
 * track is still playing must not inflate the count.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ensureSchema, resetSchemaCacheForTests, recordEvents } from "../src/store";
import { getMediaStats, getMediaStatsByDriver, mediaTrackChanges } from "../src/tracking";
import { FakeD1 } from "./helpers/d1";
import { FakeKV } from "./helpers/kv";
import type { Env } from "../src/types";

const VIN = "TESTVINMEDIA00001";
const NOW = Math.floor(Date.now() / 1000);

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

describe("getMediaStats", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("reports has_data:false with no media telemetry recorded", async () => {
    const res = (await getMediaStats(env, VIN, 90)) as { has_data: boolean; note?: string };
    expect(res.has_data).toBe(false);
    expect(res.note).toMatch(/configure_telemetry/);
  });

  it("counts a play once per value change, not once per repeated sample", async () => {
    // Same track sampled 5 times over 3 minutes (e.g. one ingest every ~40s
    // while it's still playing) must count as ONE play, not five.
    const t0 = NOW - 3600;
    await recordEvents(env, VIN, [
      { field: "media_title", value: "Sicko Mode", ts: t0 },
      { field: "media_title", value: "Sicko Mode", ts: t0 + 40 },
      { field: "media_title", value: "Sicko Mode", ts: t0 + 80 },
      { field: "media_title", value: "Sicko Mode", ts: t0 + 120 },
      { field: "media_title", value: "Sicko Mode", ts: t0 + 160 },
    ]);
    const res = (await getMediaStats(env, VIN, 90)) as { has_data: boolean; total_plays: number; top_tracks: { title: string; plays: number }[] };
    expect(res.has_data).toBe(true);
    expect(res.total_plays).toBe(1);
    expect(res.top_tracks[0]).toMatchObject({ title: "Sicko Mode", plays: 1 });
  });

  it("ranks tracks by play count and estimates listening minutes from the span between changes", async () => {
    const t0 = NOW - 7200;
    await recordEvents(env, VIN, [
      // "Song A" plays 3 times (commute pattern) vs "Song B" only twice, each
      // span a clean 4 minutes — an unambiguous ranking by play count.
      { field: "media_title", value: "Song A", ts: t0 },
      { field: "media_title", value: "Song B", ts: t0 + 240 },
      { field: "media_title", value: "Song A", ts: t0 + 480 },
      { field: "media_title", value: "Song B", ts: t0 + 720 },
      { field: "media_title", value: "Song A", ts: t0 + 960 },
      { field: "media_title", value: "Song A", ts: t0 + 1200 }, // no-op: same value, not a new play
    ]);
    const res = (await getMediaStats(env, VIN, 90)) as { top_tracks: { title: string; plays: number; minutes: number }[]; total_plays: number };
    expect(res.total_plays).toBe(5);
    expect(res.top_tracks[0]).toMatchObject({ title: "Song A", plays: 3 });
    // The first two "Song A" spans are exactly 240s each = 4 min; the third is
    // open-ended (nothing plays after it in this fixture) and capped at 10 min.
    expect(res.top_tracks.find((t) => t.title === "Song A")!.minutes).toBe(18);
  });

  it("builds separate leaderboards for artists, sources and stations", async () => {
    const t0 = NOW - 3600;
    await recordEvents(env, VIN, [
      { field: "media_title", value: "Track 1", ts: t0 },
      { field: "media_artist", value: "Artist X", ts: t0 },
      { field: "media_source", value: "Spotify", ts: t0 },
      { field: "media_title", value: "Track 2", ts: t0 + 200 },
      // Same artist/source as before (only the title changed) — one
      // continuous artist/source "play" spanning both tracks, not two.
      { field: "media_artist", value: "Artist X", ts: t0 + 200 },
      { field: "media_source", value: "Spotify", ts: t0 + 200 },
      // A genuinely new artist later — this IS a second, distinct play.
      { field: "media_artist", value: "Artist Y", ts: t0 + 400 },
    ]);
    const res = (await getMediaStats(env, VIN, 90)) as {
      top_artists: { artist: string; plays: number }[];
      top_sources: { source: string; plays: number }[];
    };
    expect(res.top_artists.find((a) => a.artist === "Artist X")).toMatchObject({ artist: "Artist X", plays: 1 });
    expect(res.top_artists.find((a) => a.artist === "Artist Y")).toMatchObject({ artist: "Artist Y", plays: 1 });
    expect(res.top_sources[0]).toMatchObject({ source: "Spotify", plays: 1 });
  });

  it("only counts plays within the requested day window", async () => {
    const oldTs = NOW - 200 * 86400; // outside a 90-day window
    const recentTs = NOW - 10 * 86400;
    await recordEvents(env, VIN, [
      { field: "media_title", value: "Ancient Hit", ts: oldTs },
      { field: "media_title", value: "Recent Hit", ts: recentTs },
    ]);
    const res = (await getMediaStats(env, VIN, 90)) as { top_tracks: { title: string }[] };
    expect(res.top_tracks.map((t) => t.title)).toContain("Recent Hit");
    expect(res.top_tracks.map((t) => t.title)).not.toContain("Ancient Hit");
  });

  it("ignores empty/blank values (no track playing)", async () => {
    const t0 = NOW - 3600;
    await recordEvents(env, VIN, [
      { field: "media_title", value: "", ts: t0 },
      { field: "media_title", value: "Real Track", ts: t0 + 60 },
    ]);
    const res = (await getMediaStats(env, VIN, 90)) as { top_tracks: { title: string }[] };
    expect(res.top_tracks.map((t) => t.title)).toEqual(["Real Track"]);
  });

  it("a playback-stopped sample ('') ends the span -- the last track of a session must not absorb the silence gap", async () => {
    // Regression (observed live 2026-07-19): empties were filtered out BEFORE
    // span computation, so every session's final track ran until the NEXT
    // session's first track -- hours later, capped at exactly 600s -- and the
    // whole leaderboard read as uniform 5-10 minute plays.
    const t0 = NOW - 7200;
    await recordEvents(env, VIN, [
      { field: "media_title", value: "Short Song", ts: t0 },
      { field: "media_title", value: "", ts: t0 + 180 }, // stopped after 3 min
      { field: "media_title", value: "Next Session Track", ts: t0 + 3600 }, // an hour later
    ]);
    const res = (await getMediaStats(env, VIN, 90)) as { top_tracks: { title: string; minutes: number }[] };
    expect(res.top_tracks.find((t) => t.title === "Short Song")!.minutes).toBe(3); // NOT 10
  });

  it("track -> stop -> same track again counts as two plays, not one", async () => {
    // With empties filtered out, LAG saw "Encore" -> "Encore" and collapsed a
    // genuine replay into one play.
    const t0 = NOW - 3600;
    await recordEvents(env, VIN, [
      { field: "media_title", value: "Encore", ts: t0 },
      { field: "media_title", value: "", ts: t0 + 200 },
      { field: "media_title", value: "Encore", ts: t0 + 900 },
    ]);
    const res = (await getMediaStats(env, VIN, 90)) as { top_tracks: { title: string; plays: number }[] };
    expect(res.top_tracks.find((t) => t.title === "Encore")!.plays).toBe(2);
  });
});

describe("mediaTrackChanges — drive-page markers", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("returns ordered track changes within a window, with best-effort artist attached", async () => {
    const t0 = NOW - 1800;
    await recordEvents(env, VIN, [
      { field: "media_title", value: "Track 1", ts: t0 },
      { field: "media_artist", value: "Artist 1", ts: t0 },
      { field: "media_title", value: "Track 2", ts: t0 + 300 },
      { field: "media_artist", value: "Artist 2", ts: t0 + 300 },
    ]);
    const rows = await mediaTrackChanges(env, VIN, t0 - 60, t0 + 600);
    expect(rows).toEqual([
      { ts: t0, title: "Track 1", artist: "Artist 1" },
      { ts: t0 + 300, title: "Track 2", artist: "Artist 2" },
    ]);
  });

  it("excludes track changes outside the window (e.g. before/after the drive)", async () => {
    const t0 = NOW - 1800;
    await recordEvents(env, VIN, [
      { field: "media_title", value: "Before the drive", ts: t0 - 500 },
      { field: "media_title", value: "During the drive", ts: t0 + 100 },
      { field: "media_title", value: "After the drive", ts: t0 + 2000 },
    ]);
    const rows = await mediaTrackChanges(env, VIN, t0, t0 + 600);
    expect(rows.map((r) => r.title)).toEqual(["During the drive"]);
  });

  it("returns an empty array when nothing was playing", async () => {
    const rows = await mediaTrackChanges(env, VIN, NOW - 1800, NOW);
    expect(rows).toEqual([]);
  });
});

async function insertDrive(env: Env, startTs: number, endTs: number, driver: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO drives (vin, start_ts, end_ts, status, distance_km, driver) VALUES (?1, ?2, ?3, 'complete', 10, ?4)`,
  ).bind(VIN, startTs, endTs, driver).run();
}

describe("getMediaStatsByDriver — who listens to what", () => {
  let env: Env;
  beforeEach(async () => {
    env = makeEnv();
    await ensureSchema(env);
  });

  it("reports has_data:false with no media telemetry recorded", async () => {
    const res = (await getMediaStatsByDriver(env, VIN, 90)) as { has_data: boolean };
    expect(res.has_data).toBe(false);
  });

  it("attributes plays to whichever driver's drive they fall inside, and 'Unassigned' otherwise", async () => {
    const t0 = NOW - 10000;
    await insertDrive(env, t0, t0 + 600, "Adam");
    await insertDrive(env, t0 + 1000, t0 + 1600, "Sara");
    await recordEvents(env, VIN, [
      { field: "media_title", value: "Adam's Song", ts: t0 + 100 }, // inside Adam's drive
      { field: "media_title", value: "Sara's Song", ts: t0 + 1100 }, // inside Sara's drive
      { field: "media_title", value: "Nobody's Song", ts: t0 + 5000 }, // outside any drive
    ]);

    const res = (await getMediaStatsByDriver(env, VIN, 90)) as {
      has_data: boolean;
      drivers: { driver: string; total_plays: number; top_tracks: { title: string; plays: number }[] }[];
    };
    expect(res.has_data).toBe(true);
    const byName = Object.fromEntries(res.drivers.map((d) => [d.driver, d]));
    expect(byName.Adam.top_tracks).toEqual([{ title: "Adam's Song", plays: 1 }]);
    expect(byName.Sara.top_tracks).toEqual([{ title: "Sara's Song", plays: 1 }]);
    expect(byName.Unassigned.top_tracks).toEqual([{ title: "Nobody's Song", plays: 1 }]);
  });
});
