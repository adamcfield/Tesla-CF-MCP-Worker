/**
 * Data layer for the Tesla dashboard. Talks to the already-deployed
 * tesla-cf-mcp-worker over two paths:
 *   - GET /data/*  (read-only REST, tracking.ts / store.ts)
 *   - POST /mcp    (JSON-RPC, but ONLY the two safe read-only tools below —
 *                   this file has no code path that can reach a command tool)
 *
 * This is a pure consumer of the existing API. It never writes to D1/KV and
 * never touches the worker's source.
 */

const DEFAULT_ORIGIN = "https://tesla-cf-mcp-worker.adamcfield.workers.dev";

/** Allows ?origin=https://your-worker.example.com for pointing at a different deployment. */
function workerOrigin() {
  const override = new URLSearchParams(location.search).get("origin");
  return (override || localStorage.getItem("tm_origin") || DEFAULT_ORIGIN).replace(/\/+$/, "");
}

const TOKEN_KEY = "tm_token";
const VIN_KEY = "tm_vin";

export const auth = {
  get token() {
    return localStorage.getItem(TOKEN_KEY) || "";
  },
  set token(value) {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  },
  get hasToken() {
    return auth.token.length > 0;
  },
  // The dashboard can't call the list_vehicles MCP tool from the browser (see
  // verifyToken below), so the VIN is entered once at the login gate instead
  // of auto-discovered.
  get vin() {
    return localStorage.getItem(VIN_KEY) || "";
  },
  set vin(value) {
    if (value) localStorage.setItem(VIN_KEY, value);
    else localStorage.removeItem(VIN_KEY);
  },
};

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function getJson(path, params = {}) {
  const url = new URL(workerOrigin() + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  url.searchParams.set("token", auth.token);
  const resp = await fetch(url.toString());
  if (resp.status === 401) throw new ApiError("Unauthorized — check your access token", 401);
  if (!resp.ok) throw new ApiError(`Request failed (${resp.status})`, resp.status);
  return resp.json();
}

/** Hard allowlist — this dashboard is read-only and must never call a command tool. */
const SAFE_TOOLS = new Set([
  "list_vehicles",
  "get_vehicle_data",
  "get_charge_state",
  "get_climate_state",
  "get_location",
  "get_latest_state",
  "get_telemetry_config",
]);

async function callTool(name, args = {}) {
  if (!SAFE_TOOLS.has(name)) throw new Error(`refusing to call non-read-only tool "${name}"`);
  const resp = await fetch(workerOrigin() + "/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${auth.token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (resp.status === 401) throw new ApiError("Unauthorized — check your access token", 401);
  const body = await resp.json();
  if (body.error) throw new ApiError(body.error.message || "MCP error", 500);
  const text = body.result?.content?.[0]?.text ?? "null";
  if (body.result?.isError) throw new ApiError(text, 502);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Confirms the token actually authorizes against the worker. Deliberately a
 * REST call, not an MCP tool call: the worker's /mcp endpoint doesn't send
 * CORS headers (and its OPTIONS preflight hits the same auth gate as a real
 * request, so the browser never even gets to send the real POST) — /data/*
 * already sends `access-control-allow-origin: *`, so it works cross-origin.
 *
 * Uses /data/latest specifically because it's the one route guaranteed to
 * exist regardless of which worker revision is deployed (older deployments
 * only had latest/series/charge-sessions; newer ones add summary/drives/
 * degradation/etc. — this dashboard is built against the newer contract, but
 * login shouldn't fail just because that hasn't shipped yet).
 */
export async function verifyToken(vinValue) {
  await getJson("/data/latest", { vin: vinValue });
}

export const mcp = {
  listVehicles: () => callTool("list_vehicles"),
  /** Always returns the full snapshot (charge/climate/drive/location/vehicle state+config) — the tool's endpoint list is fixed server-side. */
  getVehicleData: (vin) => callTool("get_vehicle_data", { vin }),
};

export const data = {
  latest: (vin) => getJson("/data/latest", { vin }),
  summary: (vin) => getJson("/data/summary", { vin }),
  series: (vin, field, hours) => getJson("/data/series", { vin, field, hours }),
  drives: (vin, limit) => getJson("/data/drives", { vin, limit }),
  drive: (id) => getJson("/data/drive", { id }),
  chargeSessions: (vin, limit) => getJson("/data/charge-sessions", { vin, limit }),
  chargeCurve: (sessionId) => getJson("/data/charge-curve", { session_id: sessionId }),
  degradation: (vin) => getJson("/data/degradation", { vin }),
  vampire: (vin, days) => getJson("/data/vampire", { vin, days }),
  states: (vin, hours) => getJson("/data/states", { vin, hours }),
  locations: () => getJson("/data/locations"),
  locationStats: (id) => getJson("/data/location-stats", { id }),
};

export { ApiError };
