/**
 * tesla-cf-mcp-worker — entrypoint/router.
 *
 * Public (no auth):
 *   GET  /.well-known/appspecific/com.tesla.3p.public-key.pem  (Tesla key hosting)
 *   GET  /.well-known/oauth-authorization-server               (MCP OAuth discovery)
 *   GET  /.well-known/oauth-protected-resource
 *   *    /oauth/{register,authorize,token}                     (claude.ai OAuth shim)
 *   GET  /auth/callback                                        (Tesla owner OAuth redirect)
 *
 * Gated by INGEST_TOKEN (falls back to MCP_AUTH_TOKEN):
 *   POST /ingest/telemetry        — telemetry sink (fleet-telemetry bridge, webhooks)
 *
 * Token-gated, TWO SCOPES resolved server-side (auth.ts requestScope):
 *   read  — per-device tokens minted at /auth/device-token: all /data/*
 *           routes + exports + /geocode + read-only MCP tools ONLY.
 *   full  — MCP_AUTH_TOKEN / OAuth-shim tokens: everything (commands,
 *           /poll/now, /setup/*, device-token management).
 * Bearer header, or ?token= for header-less consumers (OBS/Grafana/links).
 *
 *   POST /mcp                     — MCP streamable HTTP endpoint (scope-aware)
 *   GET  /data/*                  — read APIs (see handleData)
 *   GET  /data/export/{drives.csv,charges.csv,drive.gpx}
 *   GET  /geocode?q=              — GovMap→Nominatim forward geocode
 *   POST /auth/device-token?label=&vin=   (full) — mint revocable read token
 *   GET  /auth/device-token / POST /auth/revoke-device-token?id=  (full)
 *   GET  /auth/login?key=…        — start Tesla owner OAuth grant
 *   POST /setup/*                 (full) — partner registration, backfills
 *
 * Cron (wrangler.toml [triggers]): automation engine tick — see rules.ts.
 */

import {
  handleAuthCallback,
  handleAuthLogin,
  handleOauthAuthorize,
  handleOauthRegister,
  handleOauthToken,
  handlePartnerPublicKey,
  handleRegisterPartner,
  listDeviceTokens,
  mintDeviceToken,
  oauthProtectedResourceMetadata,
  oauthServerMetadata,
  ownerGrantPresent,
  requestScope,
  revokeDeviceToken,
  timingSafeEqual,
  unauthorized,
} from "./auth";
import { askTessa } from "./ai";
import { getBudgetStatus, getBudgetCallLog } from "./budget";
import { verifyDriveCertificate } from "./certificate";
import { exportChargesCsv, exportDriveGpx, exportDrivesCsv } from "./export";
import { getBatteryForecast, predictRange } from "./forecast";
import { findSimilarDrives } from "./twin";
import { handleGeocode, handleGovTile, probeGovmap } from "./govmap";
import { reverseGeocode } from "./geocode";
import { getTelemetryFieldStatus, handleIngest } from "./ingest";
import { handleMcp, SERVER_VERSION } from "./mcp";
import { pollOnce } from "./poll";
import { loadCommandKey } from "./protocol";
import { runCronTick } from "./rules";
import { ensureSchedulerArmed, PollScheduler } from "./scheduler";
import { getAppState, getLatest, listAlerts, putAppState, querySeries } from "./store";
import {
  backfillChargeAddresses,
  backfillChargeHistory,
  backfillDriveAddresses,
  backfillSyntheticDrives,
  getBatteryDegradation,
  getBatteryTimeline,
  getChargeCurve,
  getChargeSessions,
  getChargeTaperCurve,
  getClimateHabits,
  getSentryLog,
  getDrive,
  getDriveCertificate,
  getDriverScores,
  getDrivers,
  getDrives,
  getEfficiencyByTemp,
  backfillLocationMatches,
  getLocationHistory,
  getLocationStats,
  getMediaStats,
  getMediaStatsByDriver,
  getMonthlyReport,
  getSafetyFeatureStats,
  getStateTimeline,
  getSuggestedLocations,
  getTimelineChart,
  getTirePressures,
  getTrackingSummary,
  getVampireDrain,
  listLocations,
  setDriveDriver,
  setLocation,
} from "./tracking";
import { Env } from "./types";

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

/**
 * CORS for browser-based clients (the tesla-dashboard, MCP inspector, etc.).
 * A wildcard origin is safe here: auth is a bearer token the caller must
 * already hold, never a cookie, so cross-origin requests carry no ambient
 * credentials to steal. The preflight MUST be answered before the auth gate —
 * browsers send OPTIONS without the Authorization header, so a gated
 * preflight 401s and the real request is never sent.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "access-control-max-age": "86400",
};

function withCors(resp: Response): Response {
  const out = new Response(resp.body, resp);
  for (const [k, v] of Object.entries(CORS_HEADERS)) out.headers.set(k, v);
  return out;
}

/**
 * GET /health — liveness + dependency checks, for uptime monitors and the
 * GitHub Actions tick. Unauthenticated callers get a minimal ok/version body;
 * a valid token adds operational detail (grant presence, per-VIN data age).
 * Returns 503 when a hard dependency (KV/D1) is down so plain HTTP monitors
 * alert without parsing the body.
 */
async function handleHealth(request: Request, url: URL, env: Env): Promise<Response> {
  const body: Record<string, unknown> = {
    ok: true,
    version: SERVER_VERSION,
    ts: Math.floor(Date.now() / 1000),
  };
  try {
    await env.TESLA_KV.get("health:probe");
    body.kv = "ok";
  } catch {
    body.kv = "error";
    body.ok = false;
  }
  try {
    await env.DB.prepare("SELECT 1").first();
    body.d1 = "ok";
  } catch {
    body.d1 = "error";
    body.ok = false;
  }

  if ((await requestScope(request, url, env)) !== null) {
    body.owner_grant = (await ownerGrantPresent(env).catch(() => false)) ? "present" : "missing";
    body.budget = await getBudgetStatus(env).catch(() => "unavailable");
    const now = Math.floor(Date.now() / 1000);
    // Cheap, always-on: per-vehicle liveness (indexed MAX(ts) + one app_state
    // read) — this is what the 15-min watchdog polls, so it must stay light.
    try {
      const rs = await env.DB.prepare(
        `SELECT vin, MAX(ts) AS last_ts FROM positions GROUP BY vin`,
      ).all<{ vin: string; last_ts: number }>();
      body.vehicles = await Promise.all(
        (rs.results ?? []).map(async (r) => {
          // poll_ok_ts is stamped on EVERY pollOnce (even free cycles): its age
          // is the pipeline-liveness signal the tick watchdog alerts on —
          // independent of whether the car is asleep.
          const pollOk = Number((await getAppState(env, `poll_ok_ts:${r.vin}`).catch(() => "0")) ?? "0");
          return {
            vin_suffix: r.vin.slice(-6),
            last_sample_age_s: now - r.last_ts,
            poll_age_s: pollOk > 0 ? now - pollOk : null,
          };
        }),
      );
    } catch {
      body.vehicles = "unavailable";
    }
    // Expensive diagnostics ONLY on explicit ?diag=1 — full-table COUNT(*)
    // scans and an external GovMap probe are too costly to run on every
    // 15-min watchdog call (COUNT(*) can't use an index; at scale it would
    // eat the D1 free-tier daily rows-read budget).
    if (url.searchParams.get("diag") === "1") {
      try {
        const counts: Record<string, number> = {};
        for (const table of ["positions", "telemetry_events", "drives", "charge_sessions", "charges"]) {
          const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
          counts[table] = row?.n ?? 0;
        }
        body.d1_rows = counts;
      } catch {
        body.d1_rows = "unavailable";
      }
      body.govmap = await probeGovmap().catch(() => "unavailable");
    }
  }
  return json(body, body.ok ? 200 : 503);
}

/**
 * Read-only dashboard API. Every route reads the same D1 query layer as the MCP
 * tools (tracking.ts / store.ts) — no duplicated logic. All are free and never
 * wake the vehicle.
 *
 *   /data/latest?vin=            /data/summary?vin=
 *   /data/series?vin=&field=&hours=
 *   /data/drives?vin=&limit=     /data/drive?id=
 *   /data/charge-sessions?vin=&limit=   /data/charge-curve?session_id=
 *   /data/degradation?vin=       /data/vampire?vin=&days=
 *   /data/states?vin=&hours=     /data/battery-timeline?vin=&hours=
 *   /data/locations              /data/location-stats?id=
 */
async function handleData(url: URL, env: Env): Promise<Response> {
  const p = url.pathname;
  const q = url.searchParams;
  const numParam = (name: string, def: number): number => {
    const raw = q.get(name);
    if (raw === null || raw === "") return def;
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
  };
  // Required integer id — Number(null)/Number("") both coerce to 0, so guard the
  // raw string before parsing rather than trusting Number.isFinite alone.
  const requireId = (name: string): number | null => {
    const raw = q.get(name);
    if (raw === null || raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  // Routes keyed by id / session_id (no vin needed).
  if (p === "/data/locations") return json(await listLocations(env));
  if (p === "/data/budget-calls") return json(await getBudgetCallLog(env, numParam("days", 30)));
  if (p === "/data/alerts") {
    // Recent alert-log entries incl. sentinel anomaly + ai_brief firings. vin optional.
    return json(await listAlerts(env, q.get("vin") ?? undefined, numParam("limit", 50)));
  }
  if (p === "/data/drive") {
    const id = requireId("id");
    if (id === null) return json({ error: "id query param required" }, 400);
    return json(await getDrive(env, id));
  }
  if (p === "/data/drive-certificate") {
    const id = requireId("id");
    if (id === null) return json({ error: "id query param required" }, 400);
    return json(await getDriveCertificate(env, id, Math.floor(Date.now() / 1000)));
  }
  if (p === "/data/charge-curve") {
    const id = requireId("session_id");
    if (id === null) return json({ error: "session_id query param required" }, 400);
    return json(await getChargeCurve(env, id));
  }
  if (p === "/data/location-stats") {
    const id = requireId("id");
    if (id === null) return json({ error: "id query param required" }, 400);
    return json(await getLocationStats(env, id));
  }
  if (p === "/data/location-history") {
    const id = requireId("id");
    if (id === null) return json({ error: "id query param required" }, 400);
    const limit = Number(q.get("limit") ?? "200");
    return json(await getLocationHistory(env, id, Number.isFinite(limit) ? Math.min(limit, 500) : 200));
  }

  // Everything else is per-vehicle.
  const vin = q.get("vin");
  if (!vin) return json({ error: "vin query param required" }, 400);

  switch (p) {
    case "/data/latest":
      return json((await getLatest(env, vin)) ?? { vin, note: "no data ingested yet" });
    case "/data/summary":
      return json(await getTrackingSummary(env, vin));
    case "/data/series": {
      const field = q.get("field");
      if (!field) return json({ error: "field query param required" }, 400);
      return json(await querySeries(env, vin, field, numParam("hours", 24)));
    }
    case "/data/drives":
      return json(await getDrives(env, vin, numParam("limit", 50)));
    case "/data/driver-scores":
      return json(await getDriverScores(env, vin));
    case "/data/charge-sessions":
      return json(await getChargeSessions(env, vin, numParam("limit", 50)));
    case "/data/degradation":
      return json(await getBatteryDegradation(env, vin));
    case "/data/battery-timeline":
      return json(await getBatteryTimeline(env, vin, numParam("hours", 24)));
    case "/data/timeline-chart": {
      const fields = (q.get("fields") ?? "speed,soc,inside_temp,outside_temp")
        .split(",").map((s) => s.trim()).filter(Boolean);
      // Optional window anchor: unix seconds the window ENDS at (default now) —
      // lets the Chart explorer pan back through history stock-chart style.
      const endRaw = q.get("end");
      const end = endRaw != null && endRaw !== "" && Number.isFinite(Number(endRaw)) ? Number(endRaw) : undefined;
      return json(await getTimelineChart(env, vin, numParam("hours", 24), fields, end));
    }
    case "/data/telemetry-fields":
      return json(await getTelemetryFieldStatus(env, vin));
    case "/data/vampire":
      return json(await getVampireDrain(env, vin, numParam("days", 30)));
    case "/data/states":
      return json(await getStateTimeline(env, vin, numParam("hours", 168)));
    case "/data/efficiency-by-temp":
      return json(await getEfficiencyByTemp(env, vin));
    case "/data/tires":
      return json(await getTirePressures(env, vin, numParam("days", 30)));
    case "/data/monthly":
      return json(await getMonthlyReport(env, vin, numParam("months", 12)));
    case "/data/suggested-locations":
      return json(await getSuggestedLocations(env, vin));
    case "/data/media":
      return json(await getMediaStats(env, vin, numParam("days", 90)));
    case "/data/charge-taper":
      return json(await getChargeTaperCurve(env, vin));
    case "/data/safety-features":
      return json(await getSafetyFeatureStats(env, vin, numParam("days", 90)));
    case "/data/climate-habits":
      return json(await getClimateHabits(env, vin, numParam("days", 90)));
    case "/data/media-by-driver":
      return json(await getMediaStatsByDriver(env, vin, numParam("days", 90)));
    case "/data/sentry-log":
      return json(await getSentryLog(env, vin, numParam("days", 30)));
    case "/data/similar-drives": {
      const nOpt = (name: string): number | undefined => {
        const raw = q.get(name);
        if (raw === null || raw.trim() === "") return undefined;
        const n = Number(raw);
        return Number.isFinite(n) ? n : undefined;
      };
      return json(await findSimilarDrives(env, vin, {
        distance_km: nOpt("distance_km"), temp_c: nOpt("temp_c"),
        driver: q.get("driver") ?? undefined, night: q.get("night") === "1" ? true : q.get("night") === "0" ? false : undefined,
      }, nOpt("k") ?? 5));
    }
    case "/data/drivers":
      return json(await getDrivers(env, vin));
    case "/data/battery-forecast":
      return json(await getBatteryForecast(env, vin));
    case "/data/predict-range": {
      const nOpt = (name: string): number | undefined => {
        const raw = q.get(name);
        if (raw === null || raw.trim() === "") return undefined;
        const n = Number(raw);
        return Number.isFinite(n) ? n : undefined;
      };
      return json(await predictRange(env, vin, {
        distance_km: nOpt("distance_km"), temp_c: nOpt("temp_c"),
        driver: q.get("driver") ?? undefined, elevation_gain_m: nOpt("elevation_gain_m"),
      }));
    }
    default:
      return json({ error: "not found" }, 404);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // --- CORS preflight (must precede every auth gate) ------------------
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      // --- public -------------------------------------------------------
      if (path === "/.well-known/appspecific/com.tesla.3p.public-key.pem") {
        const key = await loadCommandKey(env.TESLA_PRIVATE_KEY);
        return new Response(key.publicKeyPem, {
          headers: { "content-type": "application/x-pem-file" },
        });
      }
      if (path === "/.well-known/oauth-authorization-server") return oauthServerMetadata(env);
      if (path === "/.well-known/oauth-protected-resource") return oauthProtectedResourceMetadata(env);
      if (path === "/oauth/register" && request.method === "POST") return handleOauthRegister(request);
      if (path === "/oauth/authorize") return handleOauthAuthorize(request, env);
      if (path === "/oauth/token" && request.method === "POST") return handleOauthToken(request, env);
      if (path === "/auth/callback") return handleAuthCallback(request, env);
      if (path === "/auth/login") return handleAuthLogin(request, env);
      if (path === "/health") return handleHealth(request, url, env);

      // --- GovMap basemap tile proxy (public: Leaflet can't send a bearer, and
      // these are public map tiles behind a Referer gate the worker satisfies).
      if (path.startsWith("/govtiles/")) {
        return handleGovTile(path.split("/").filter(Boolean));
      }
      // --- Certificate verification (PUBLIC: a third party — e.g. an insurer —
      // must be able to verify a drive certificate without holding a token; it
      // only returns valid:true/false and reveals nothing beyond what the
      // certificate holder already has).
      if (path === "/data/verify-certificate" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        return json(await verifyDriveCertificate(env, body as { canonical?: unknown; signature_hex?: unknown }));
      }

      if (path === "/" || path === "") {
        return new Response(
          "Tesla CF MCP Worker — Tesla Fleet API MCP server.\n" +
            "MCP endpoint: POST /mcp (Bearer auth). See README for setup.\n",
          { headers: { "content-type": "text/plain" } },
        );
      }

      // --- telemetry sink (separate token so bridges don't hold MCP access)
      if (path === "/ingest/telemetry" && request.method === "POST") {
        const header = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
        const candidate = header ?? url.searchParams.get("token") ?? "";
        const ingestOk =
          (env.INGEST_TOKEN && candidate.length > 0 && timingSafeEqual(candidate, env.INGEST_TOKEN)) ||
          (await requestScope(request, url, env)) === "full";
        if (!ingestOk) return json({ error: "unauthorized" }, 401);
        return handleIngest(request, env);
      }

      // Everything below requires a token. Resolve its scope ONCE.
      const scope = await requestScope(request, url, env);

      // --- Forward geocode (address → coords), GovMap with Nominatim fallback.
      // Token-gated (read suffices): an open proxy here could get the shared
      // Nominatim UA banned — which would silently break drive place names.
      if (path === "/geocode") {
        if (scope === null) return json({ error: "unauthorized" }, 401);
        const q = url.searchParams.get("q")?.trim().slice(0, 120);
        if (!q) return json({ error: "q query param required" }, 400);
        const results = await handleGeocode(env, q, url.searchParams.get("lang") ?? "he");
        return json({ query: q, results });
      }

      // --- Reverse geocode (coords → short place label), same Nominatim path
      // drive endpoints already use (110m-grid cached) — lets the dashboard show
      // a real address for the current location instead of raw lat/lon.
      if (path === "/data/reverse-geocode") {
        if (scope === null) return json({ error: "unauthorized" }, 401);
        const lat = Number(url.searchParams.get("lat"));
        const lon = Number(url.searchParams.get("lon"));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: "lat/lon query params required" }, 400);
        const label = await reverseGeocode(env, lat, lon);
        return json({ lat, lon, label });
      }

      // --- driver assignment (benign metadata write; read scope suffices —
      // it's the dashboard's one write and can't touch the vehicle)
      if (path === "/data/assign-driver" && request.method === "POST") {
        if (scope === null) return json({ error: "unauthorized" }, 401);
        const id = Number(url.searchParams.get("id"));
        if (!Number.isFinite(id)) return json({ error: "id query param required" }, 400);
        return json(await setDriveDriver(env, id, url.searchParams.get("driver")));
      }

      // --- name a place (benign metadata write, same trust boundary as
      // assign-driver above: read scope suffices, and it can't touch the
      // vehicle). Lets the dashboard turn a "suggested place" — a frequent
      // stop it already detected — into a saved geofence in one step, instead
      // of requiring a separate MCP tool call. Also doubles as the edit route
      // (pass id) for renaming/re-tagging an already-saved location.
      if (path === "/data/save-location" && request.method === "POST") {
        if (scope === null) return json({ error: "unauthorized" }, 401);
        const name = url.searchParams.get("name")?.trim().slice(0, 120);
        const lat = Number(url.searchParams.get("lat"));
        const lon = Number(url.searchParams.get("lon"));
        if (!name) return json({ error: "name query param required" }, 400);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: "lat/lon query params required" }, 400);
        const radiusParam = url.searchParams.get("radius_m");
        const radius_m = radiusParam != null && radiusParam !== "" ? Number(radiusParam) : undefined;
        const idParam = url.searchParams.get("id");
        const id = idParam != null && idParam !== "" ? Number(idParam) : undefined;
        // Absent entirely = "leave tags as-is" (setLocation's update path);
        // present-but-empty = "explicitly clear tags" — both distinct from a
        // comma-separated list of names.
        const driversParam = url.searchParams.get("drivers");
        const drivers = driversParam != null
          ? driversParam.split(",").map((d) => d.trim()).filter(Boolean)
          : undefined;
        // address: absent = keep as-is; present-but-empty = clear (it will be
        // lazily re-geocoded); otherwise set the user's text verbatim.
        const addressParam = url.searchParams.get("address");
        const address = addressParam != null ? addressParam.trim().slice(0, 200) : undefined;
        return json(await setLocation(env, {
          id: Number.isFinite(id as number) ? id : undefined,
          name, lat, lon,
          radius_m: Number.isFinite(radius_m as number) ? radius_m : undefined,
          drivers,
          address,
        }));
      }

      // --- data exports (CSV/GPX downloads; read scope) -------------------
      if (path.startsWith("/data/export/")) {
        if (scope === null) return json({ error: "unauthorized" }, 401);
        if (path === "/data/export/drives.csv") {
          const vin = url.searchParams.get("vin");
          if (!vin) return json({ error: "vin query param required" }, 400);
          return exportDrivesCsv(env, vin);
        }
        if (path === "/data/export/charges.csv") {
          const vin = url.searchParams.get("vin");
          if (!vin) return json({ error: "vin query param required" }, 400);
          return exportChargesCsv(env, vin);
        }
        if (path === "/data/export/drive.gpx") {
          const id = Number(url.searchParams.get("id"));
          if (!Number.isFinite(id) || id <= 0) return json({ error: "id query param required" }, 400);
          return exportDriveGpx(env, id);
        }
        return json({ error: "not found" }, 404);
      }

      // --- Ask-Tessa: natural-language Q&A over the car's data (read scope) --
      if (path === "/ai/ask" && request.method === "POST") {
        if (scope === null) return json({ error: "unauthorized" }, 401);
        const body = (await request.json().catch(() => ({}))) as { question?: string; vin?: string };
        const vin = body.vin ?? url.searchParams.get("vin");
        if (!vin) return json({ error: "vin required" }, 400);
        return json(await askTessa(env, String(body.question ?? ""), vin));
      }

      // --- read-only data endpoints (header or ?token=; read scope) ------
      if (path.startsWith("/data/")) {
        if (scope === null) return json({ error: "unauthorized" }, 401);
        return handleData(url, env);
      }

      // --- device-token management (FULL scope only) ----------------------
      // POST /auth/device-token?label=phone → mints a revocable READ token +
      // a ready-to-save dashboard link. GET lists; POST /auth/revoke-device-token?id=…
      if (path === "/auth/device-token" && request.method === "POST") {
        if (scope !== "full") return json({ error: "full-access token required" }, scope ? 403 : 401);
        const minted = await mintDeviceToken(env, url.searchParams.get("label") ?? "device");
        const vin = url.searchParams.get("vin");
        return json({
          ...minted,
          scope: "read",
          note: "Store this token now — only its hash is kept server-side. Revoke anytime with POST /auth/revoke-device-token?id=" + minted.id,
          dashboard_link: `https://tesla-dashboard-1ps.pages.dev/?token=${minted.token}${vin ? `&vin=${vin}` : ""}`,
        });
      }
      if (path === "/auth/device-token" && request.method === "GET") {
        if (scope !== "full") return json({ error: "full-access token required" }, scope ? 403 : 401);
        return json({ tokens: await listDeviceTokens(env) });
      }
      if (path === "/auth/revoke-device-token" && request.method === "POST") {
        if (scope !== "full") return json({ error: "full-access token required" }, scope ? 403 : 401);
        const id = url.searchParams.get("id") ?? "";
        const revoked = await revokeDeviceToken(env, id.toLowerCase());
        return json({ revoked });
      }

      // --- gated (MCP: read tokens see/call only read tools) --------------
      if (scope === null) {
        return path === "/mcp" ? withCors(unauthorized(env)) : unauthorized(env);
      }

      if (path === "/mcp") return withCors(await handleMcp(request, env, scope));

      // Everything past here mutates worker/Tesla state — full scope only.
      if (scope !== "full") return json({ error: "full-access token required" }, 403);

      if (path === "/poll/now") {
        const pollVin = url.searchParams.get("vin");
        if (!pollVin) return json({ error: "vin query param required" }, 400);
        return json(await pollOnce(env, pollVin));
      }
      if (path === "/scheduler/start") {
        // Arm the Durable Object poll scheduler (self-sustaining once started).
        if (!env.POLL_SCHEDULER) return json({ error: "scheduler DO not bound" }, 501);
        await ensureSchedulerArmed(env);
        return json({ ok: true, note: "poll scheduler armed — self-rearms every ~90s (10s while driving)" });
      }
      if (path === "/setup/register-partner" && request.method === "POST") {
        return handleRegisterPartner(env, url.searchParams.get("domain") ?? undefined);
      }
      if (path === "/setup/partner-public-key") return handlePartnerPublicKey(env);
      if (path === "/setup/backfill-locations" && request.method === "POST") {
        return json(await backfillLocationMatches(env, url.searchParams.get("force") === "1"));
      }
      if (path === "/setup/backfill-charges" && request.method === "POST") {
        const vin = url.searchParams.get("vin");
        if (!vin) return json({ error: "vin query param required" }, 400);
        return json(await backfillChargeHistory(env, vin));
      }
      if (path === "/setup/backfill-addresses" && request.method === "POST") {
        const vin = url.searchParams.get("vin");
        if (!vin) return json({ error: "vin query param required" }, 400);
        const drives = await backfillDriveAddresses(env, vin);
        const charges = await backfillChargeAddresses(env, vin);
        return json({ drives, charges });
      }
      if (path === "/setup/recover-drives" && request.method === "POST") {
        const vin = url.searchParams.get("vin");
        if (!vin) return json({ error: "vin query param required" }, 400);
        return json(await backfillSyntheticDrives(env, vin));
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // If POLL_VINS is set, each cron fire also polls those vehicles — a
    // Cloudflare-native, reliable alternative/complement to the GitHub poll
    // loop (Cloudflare cron fires on time; GitHub throttles the schedule). One
    // pollOnce per fire; free connectivity checks when parked, budget-governed
    // billed reads only when online. The car can still sleep. Never wakes it.
    const pollVins = (env.POLL_VINS ?? "").split(/[,\s]+/).map((v) => v.trim()).filter(Boolean);
    const jobs: Promise<unknown>[] = pollVins.map((vin) =>
      pollOnce(env, vin).catch((e) => console.error("cron poll failed:", e instanceof Error ? e.message : e)),
    );
    // Keep the DO poll scheduler armed (self-heals if it was ever lost).
    jobs.push(ensureSchedulerArmed(env).catch(() => {}));
    // Run the automation tick at most ~every 13 min even if the cron fires more
    // often for polling (so a */2 poll cron doesn't re-run the tick 7× as much).
    jobs.push(
      (async () => {
        const now = Math.floor(Date.now() / 1000);
        const last = Number((await getAppState(env, "last_cf_tick_ts").catch(() => "0")) ?? "0");
        if (now - last >= 13 * 60) {
          await putAppState(env, "last_cf_tick_ts", String(now)).catch(() => {});
          await runCronTick(env).catch((e) => console.error("cron tick failed:", e instanceof Error ? e.message : e));
        }
      })(),
    );
    ctx.waitUntil(Promise.allSettled(jobs).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;

// Durable Object class export (referenced by the wrangler.toml binding).
export { PollScheduler };
