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
 * Gated by MCP_AUTH_TOKEN (Authorization header, or ?token= for the /data
 * endpoints so header-less consumers like OBS browser sources work):
 *   POST /mcp                     — MCP streamable HTTP endpoint
 *   GET  /data/latest?vin=        — latest state JSON (Grafana/HA/OBS)
 *   GET  /data/series?vin=&field=&hours=
 *   GET  /data/charge-sessions?vin=
 *   GET  /auth/login?key=…        — start Tesla owner OAuth grant
 *   POST /setup/register-partner  — one-time partner endpoint registration
 *   GET  /setup/partner-public-key
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
  isMcpAuthorized,
  oauthProtectedResourceMetadata,
  oauthServerMetadata,
  timingSafeEqual,
  unauthorized,
} from "./auth";
import { handleIngest } from "./ingest";
import { handleMcp } from "./mcp";
import { loadCommandKey } from "./protocol";
import { runCronTick } from "./rules";
import { getLatest, querySeries } from "./store";
import {
  getBatteryDegradation,
  getChargeCurve,
  getChargeSessions,
  getDrive,
  getDrives,
  getLocationStats,
  getStateTimeline,
  getTrackingSummary,
  getVampireDrain,
  listLocations,
} from "./tracking";
import { Env } from "./types";

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

/** Bearer header or ?token= query param (documented tradeoff for OBS/Grafana). */
function tokenAuthorized(request: Request, url: URL, expected: string): boolean {
  const header = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const candidate = header ?? url.searchParams.get("token") ?? "";
  return candidate.length > 0 && timingSafeEqual(candidate, expected);
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
 *   /data/states?vin=&hours=
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
  if (p === "/data/drive") {
    const id = requireId("id");
    if (id === null) return json({ error: "id query param required" }, 400);
    return json(await getDrive(env, id));
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
    case "/data/charge-sessions":
      return json(await getChargeSessions(env, vin, numParam("limit", 50)));
    case "/data/degradation":
      return json(await getBatteryDegradation(env, vin));
    case "/data/vampire":
      return json(await getVampireDrain(env, vin, numParam("days", 30)));
    case "/data/states":
      return json(await getStateTimeline(env, vin, numParam("hours", 168)));
    default:
      return json({ error: "not found" }, 404);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
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

      if (path === "/" || path === "") {
        return new Response(
          "Tesla CF MCP Worker — Tesla Fleet API MCP server.\n" +
            "MCP endpoint: POST /mcp (Bearer auth). See README for setup.\n",
          { headers: { "content-type": "text/plain" } },
        );
      }

      // --- telemetry sink (separate token so bridges don't hold MCP access)
      if (path === "/ingest/telemetry" && request.method === "POST") {
        if (!tokenAuthorized(request, url, env.INGEST_TOKEN ?? env.MCP_AUTH_TOKEN)) {
          return json({ error: "unauthorized" }, 401);
        }
        return handleIngest(request, env);
      }

      // --- read-only data endpoints (header or ?token=) ------------------
      if (path.startsWith("/data/")) {
        if (!tokenAuthorized(request, url, env.MCP_AUTH_TOKEN)) return json({ error: "unauthorized" }, 401);
        return handleData(url, env);
      }

      // --- gated --------------------------------------------------------
      if (!(await isMcpAuthorized(request, env))) return unauthorized(env);

      if (path === "/mcp") return handleMcp(request, env);
      if (path === "/setup/register-partner" && request.method === "POST") {
        return handleRegisterPartner(env);
      }
      if (path === "/setup/partner-public-key") return handlePartnerPublicKey(env);

      return new Response("Not found", { status: 404 });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runCronTick(env).catch((e) => console.error("cron tick failed:", e instanceof Error ? e.message : e)),
    );
  },
} satisfies ExportedHandler<Env>;
