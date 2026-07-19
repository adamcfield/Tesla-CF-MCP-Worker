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

/**
 * Worker origin for all requests. A different deployment is selected by
 * `?origin=` ONCE, at boot, through consumeUrlCredentials() (app.js) — which
 * persists it to tm_origin AND drops any stored token so it can't be shipped
 * to an attacker-supplied origin. This function deliberately does NOT read the
 * live query param: honoring a bare ?origin= here would re-open that
 * token-exfiltration hole on every fetch, bypassing the boot-time guard.
 */
export function workerOrigin() {
  return (localStorage.getItem("tm_origin") || DEFAULT_ORIGIN).replace(/\/+$/, "");
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
  const resp = await fetch(exportUrl(path, params));
  if (resp.status === 401) throw new ApiError("Unauthorized — check your access token", 401);
  if (!resp.ok) throw new ApiError(`Request failed (${resp.status})`, resp.status);
  return resp.json();
}

/**
 * Token-included worker URL, for plain <a> download links (CSV/GPX exports)
 * as well as getJson above. The token rides as ?token= — same documented
 * tradeoff as the OBS/Grafana query-param auth the worker already allows.
 */
export function exportUrl(path, params = {}) {
  const url = new URL(workerOrigin() + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  url.searchParams.set("token", auth.token);
  return url.toString();
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
  batteryTimeline: (vin, hours) => getJson("/data/battery-timeline", { vin, hours }),
  timelineChart: (vin, hours, fields, end) =>
    getJson("/data/timeline-chart", { vin, hours, fields: fields.join(","), ...(end != null ? { end } : {}) }),
  /** Live status per mapped Tesla telemetry field (canonical key, latest value, last-seen). New endpoint — may 404. */
  telemetryFields: (vin) => getJson("/data/telemetry-fields", { vin }),
  locations: () => getJson("/data/locations"),
  locationHistory: (id, limit = 200) => getJson("/data/location-history", { id, limit }),
  locationStats: (id) => getJson("/data/location-stats", { id }),
  /** Forward-geocode an address to candidate {label, lat, lon, source} hits (GovMap, falling back to Nominatim). */
  geocode: (q, lang) => getJson("/geocode", { q, lang }),
  /** Reverse-geocode a point to a short place label (Nominatim, 110m-grid cached server-side). New endpoint — may 404. */
  reverseGeocode: (lat, lon) => getJson("/data/reverse-geocode", { lat, lon }),
  driverScores: (vin) => getJson("/data/driver-scores", { vin }),
  efficiencyByTemp: (vin) => getJson("/data/efficiency-by-temp", { vin }),
  tires: (vin, days) => getJson("/data/tires", { vin, days }),
  monthly: (vin, months) => getJson("/data/monthly", { vin, months }),
  suggestedLocations: (vin) => getJson("/data/suggested-locations", { vin }),
  /** Household driver roster (Tesla-reported + already-tagged). New endpoint — may 404. */
  drivers: (vin) => getJson("/data/drivers", { vin }),
  /** Battery degradation forecast + warranty-cliff. New endpoint — may 404. */
  batteryForecast: (vin) => getJson("/data/battery-forecast", { vin }),
  /** Most-played tracks/artists/sources/stations from Fleet Telemetry media fields. New endpoint — may 404. */
  media: (vin, days) => getJson("/data/media", { vin, days }),
  /** Same, broken down per assigned driver. New endpoint — may 404. */
  mediaByDriver: (vin, days) => getJson("/data/media-by-driver", { vin, days }),
  /** Lifetime charging power-delivery curve, binned by 5% SoC. New endpoint — may 404. */
  chargeTaperCurve: (vin) => getJson("/data/charge-taper", { vin }),
  /** ADAS feature adoption (AEB disabled %, blind-spot chime count, etc). New endpoint — may 404. */
  safetyFeatures: (vin, days) => getJson("/data/safety-features", { vin, days }),
  /** Climate/comfort habits (seat heater/cooling per side, auto-climate %). New endpoint — may 404. */
  climateHabits: (vin, days) => getJson("/data/climate-habits", { vin, days }),
  /** Sentry Mode armed-hours + (when the account streams the full enum) trigger event log. New endpoint — may 404. */
  sentryLog: (vin, days) => getJson("/data/sentry-log", { vin, days }),
  /** Tesla Fleet API call log & cost breakdown by day/kind, account-wide (no vin). New endpoint — may 404. */
  budgetCallLog: (days) => getJson("/data/budget-calls", { days }),
  /** Recent alert-log entries (budget/watchdog/rule firings), newest first. Deliberately un-filtered by vin — budget alerts are account-wide and carry none. May 404 on an older worker. */
  alerts: (limit) => getJson("/data/alerts", { limit }),
  /**
   * Web Push VAPID public key for pushManager.subscribe() — {key} (null when
   * the worker has no VAPID secrets configured). New endpoint — may 404.
   */
  pushVapidKey: () => getJson("/data/push-vapid-key"),
  /**
   * Benign metadata write (token-gated POST) — register this browser's
   * PushSubscription (its .toJSON(): {endpoint, keys:{p256dh, auth}}) so the
   * worker's cron can push undelivered alerts to this device.
   */
  pushSubscribe: (sub) =>
    fetch(workerOrigin() + "/data/push-subscribe?" + new URLSearchParams({ token: auth.token }), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sub),
    }).then((r) => (r.ok ? r.json() : Promise.reject(new ApiError("subscribe failed", r.status)))),
  /** Benign metadata write (token-gated POST) — drop a push subscription by its endpoint URL. */
  pushUnsubscribe: (endpoint) =>
    fetch(workerOrigin() + "/data/push-unsubscribe?" + new URLSearchParams({ token: auth.token }), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    }).then((r) => (r.ok ? r.json() : Promise.reject(new ApiError("unsubscribe failed", r.status)))),
  /**
   * Range prediction. With no distance_km, returns {model, ready} so the screen
   * can show model quality + a form; with params, returns the prediction. New endpoint — may 404.
   */
  predictRange: ({ vin, distance_km, temp_c, driver, elevation_gain_m } = {}) =>
    getJson("/data/predict-range", { vin, distance_km, temp_c, driver, elevation_gain_m }),
  /** Tamper-evident signed risk certificate for a drive. New endpoint — may 404. */
  driveCertificate: (id) => getJson("/data/drive-certificate", { id }),
  /**
   * Ask-Tessa: natural-language Q&A over the car's data. POSTs to /ai/ask with
   * the token as a query param (matching the worker's documented query-param
   * auth). New endpoint — may 404/500/timeout; callers must degrade gracefully.
   */
  ask: (question, vin) =>
    fetch(workerOrigin() + "/ai/ask?" + new URLSearchParams({ token: auth.token }), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth.token}` },
      body: JSON.stringify({ question, vin }),
    }).then((r) => {
      if (r.status === 401) throw new ApiError("Unauthorized — check your access token", 401);
      if (!r.ok) throw new ApiError(`AI request failed (${r.status})`, r.status);
      return r.json();
    }),
  /** Benign metadata write (token-gated POST) — assign/clear a drive's driver. */
  assignDriver: (id, driver) =>
    fetch(workerOrigin() + "/data/assign-driver?" + new URLSearchParams({ id, driver: driver || "", token: auth.token }), { method: "POST" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new ApiError("assign failed", r.status)))),
  /**
   * Benign metadata write (token-gated POST) — save a named geofence (e.g. naming a
   * suggested place or one found by address), or edit one (pass id). `drivers`
   * (optional) tags which household driver(s) it belongs to; omit entirely to
   * leave existing tags untouched on an edit, pass [] to explicitly clear them.
   */
  saveLocation: ({ id, name, lat, lon, radius_m, drivers, address }) =>
    fetch(workerOrigin() + "/data/save-location?" + new URLSearchParams({
      name, lat: String(lat), lon: String(lon),
      ...(id != null ? { id: String(id) } : {}),
      ...(radius_m != null ? { radius_m: String(radius_m) } : {}),
      ...(drivers !== undefined ? { drivers: drivers.join(",") } : {}),
      ...(address !== undefined ? { address } : {}),
      token: auth.token,
    }), { method: "POST" })
      .then(async (r) => {
        if (r.ok) return r.json();
        // Surface the worker's own error message (e.g. "name query param
        // required") when there is one, instead of a bare status code —
        // that's the difference between a diagnosable failure and "Failed".
        const detail = await r.json().then((b) => b?.error).catch(() => null);
        throw new ApiError(detail || `save failed (${r.status})`, r.status);
      }),
};

export { ApiError };
