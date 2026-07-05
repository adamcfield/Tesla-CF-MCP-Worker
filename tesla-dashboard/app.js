import { auth, data, mcp, verifyToken, ApiError } from "./api.js";
import { svgLineChart, svgBarChart, svgDonut, svgSplitBar } from "./charts.js";
import { destroyMaps, renderPointMap, renderRouteMap, renderLifetimeMap } from "./map.js";

const root = document.getElementById("app");
let shellBound = false; // guards one-time attach of the root click handler + sync timer

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const fmt0 = (n) => (n == null || Number.isNaN(n) ? "—" : Math.round(n).toLocaleString());
const fmt1 = (n) => (n == null || Number.isNaN(n) ? "—" : (Math.round(n * 10) / 10).toLocaleString());
const fmt2 = (n) => (n == null || Number.isNaN(n) ? "—" : (Math.round(n * 100) / 100).toFixed(2));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

const CURRENCY_SYMBOL = { ILS: "₪", USD: "$", EUR: "€", GBP: "£", AUD: "A$", CAD: "C$" };
function money(amount, currency, decimals = 2) {
  if (amount == null || Number.isNaN(amount)) return "—";
  const sym = CURRENCY_SYMBOL[currency] ?? (currency ? currency + " " : "€");
  return sym + (decimals === 0 ? fmt0(amount) : fmt2(amount));
}
/** Charge-session location: a geofence name if matched, else the Supercharger site label. */
function chargeLocName(c, locations) {
  if (c.location_id != null) {
    const l = locations.find((x) => x.id === c.location_id);
    if (l) return l.name;
  }
  return c.site_name || "Unknown location";
}
/** Most common currency across sessions, for the aggregate stat cards. */
function dominantCurrency(sessions) {
  const counts = {};
  for (const c of sessions) if (c.currency) counts[c.currency] = (counts[c.currency] || 0) + 1;
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
}

function fmtDay(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays > 1 && diffDays < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
function fmtDayFull(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  const weekday = d.toLocaleDateString(undefined, { weekday: "long" });
  const full = d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  if (diffDays === 0) return `Today · ${weekday}`;
  if (diffDays === 1) return `Yesterday · ${weekday}`;
  return full;
}
function fmtTime(ts) {
  return new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtDateTime(ts) {
  return ts == null ? "—" : `${fmtDay(ts)} · ${fmtTime(ts)}`;
}
function fmtDurationMin(min) {
  if (min == null || Number.isNaN(min)) return "—";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return m > 0 ? `${h} h ${String(m).padStart(2, "0")} m` : `${h} h`;
}
function fmtDurationSec(sec) {
  return fmtDurationMin(sec == null ? null : sec / 60);
}
function agoLabel(sinceMs) {
  const s = Math.max(0, Math.round((Date.now() - sinceMs) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}
function monthKey(ts) {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(ts) {
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const state = {
  screen: "ov",
  theme: localStorage.getItem("tm_theme") || "light",
  vehicle: null, // { vin, display_name, state }
  vehicleData: null, // last on-demand get_vehicle_data snapshot
  driveFilter: 1, // 0=7d, 1=30d, 2=all
  openDriveId: null,
  openChargeId: null,
  lastSync: null,
  cache: {}, // per-screen fetched payloads, cleared on manual refresh
};

const NAV = [
  { label: "", items: [["ov", "Overview"], ["tl", "Timeline"], ["st", "Statistics"]] },
  { label: "Driving", items: [["dr", "Drives"], ["dv", "Drivers"], ["map", "Lifetime map"]] },
  { label: "Charging", items: [["ch", "Charges"], ["cs", "Charging stats"]] },
  { label: "Battery", items: [["bh", "Battery health"], ["vd", "Vampire drain"]] },
];

const TITLES = {
  ov: ["Overview", ""],
  tl: ["Timeline", "drives, charges & sleep/wake"],
  st: ["Statistics", "last 12 months"],
  dr: ["Drives", ""],
  dv: ["Drivers", "behaviour & risk scoring"],
  map: ["Lifetime map", ""],
  ch: ["Charges", ""],
  cs: ["Charging stats", "lifetime"],
  bh: ["Battery health", ""],
  vd: ["Vampire drain", "standby losses"],
};

const EVENT_COLOR = { drive: "var(--accent)", charge: "var(--good)", sleep: "var(--faint)", update: "#8A63D2" };

// ---------------------------------------------------------------------------
// Boot / auth gate
// ---------------------------------------------------------------------------

async function boot() {
  if (!auth.hasToken || !auth.vin) return renderGate();
  try {
    await verifyToken(auth.vin);
    await renderApp();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      auth.token = "";
      return renderGate("That token was rejected — check it and try again.");
    }
    renderGate(`Could not reach the worker: ${e.message}`);
  }
}

function renderGate(error) {
  destroyMaps();
  root.innerHTML = `
    <div data-tm-root="1" data-theme="${state.theme}" class="tm-root-plain">
    <div class="tm-gate">
      <div class="tm-gate-card">
        <div class="tm-gate-title">Connect to your Tesla worker</div>
        <div class="tm-gate-sub">Paste the <code>MCP_AUTH_TOKEN</code> from your tesla-cf-mcp-worker deployment and your vehicle's VIN. Both are stored only in this browser and sent directly to your worker — never anywhere else.</div>
        <div class="tm-gate-field">
          <label for="tm-token-input">Access token</label>
          <input id="tm-token-input" class="tm-gate-input" type="password" autocomplete="off" placeholder="paste MCP_AUTH_TOKEN" value="${esc(auth.token)}">
        </div>
        <div class="tm-gate-field">
          <label for="tm-vin-input">Vehicle VIN</label>
          <input id="tm-vin-input" class="tm-gate-input" type="text" autocomplete="off" placeholder="e.g. 5YJ3..." value="${esc(auth.vin)}" style="text-transform:uppercase;">
        </div>
        ${error ? `<div class="tm-gate-err">${esc(error)}</div>` : ""}
        <button id="tm-token-submit" class="tm-gate-btn">Connect</button>
      </div>
    </div>
    </div>`;
  const tokenInput = document.getElementById("tm-token-input");
  const vinInput = document.getElementById("tm-vin-input");
  const btn = document.getElementById("tm-token-submit");
  const submit = async () => {
    const tokenValue = tokenInput.value.trim();
    const vinValue = vinInput.value.trim().toUpperCase();
    if (!tokenValue || !vinValue) return;
    btn.disabled = true;
    btn.textContent = "Connecting…";
    auth.token = tokenValue;
    auth.vin = vinValue;
    try {
      await verifyToken(vinValue);
      await renderApp();
    } catch (e) {
      auth.token = "";
      renderGate(e instanceof ApiError && e.status === 401 ? "That token was rejected — check it and try again." : `Could not reach the worker: ${e.message}`);
    }
  };
  btn.addEventListener("click", submit);
  for (const el of [tokenInput, vinInput]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  tokenInput.focus();
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

async function renderApp() {
  renderShell();
  await showScreen();
}

function renderShell() {
  destroyMaps();
  // Vehicle identity/state can't be fetched cross-origin (list_vehicles is an
  // MCP tool call — see verifyToken's comment in api.js), so it only becomes
  // known if "Load live data" has been used on the Overview screen.
  const vd = state.vehicleData;
  const online = vd?.vehicle_state != null; // a successful read implies the car answered
  const initial = "T";

  root.innerHTML = `
    <div data-tm-root="1" data-theme="${state.theme}">
      <aside class="tm-aside">
        <div class="tm-brand">
          <div class="tm-brand-badge">${esc(initial)}</div>
          <div style="min-width:0;">
            <div class="tm-brand-name tm-ellipsis">${esc(vd?.vehicle_config ? [vd.vehicle_config.car_type, vd.vehicle_config.trim_badging].filter(Boolean).join(" ") : "Vehicle")}</div>
            <div class="tm-brand-status">
              <span class="tm-dot ${online ? "tm-dot-live" : ""}" style="background:${online ? "var(--good)" : "var(--faint)"};"></span>
              ${online ? "Online" : "Unknown"}
            </div>
          </div>
        </div>
        ${NAV.map((g) => `
          <div class="tm-navgroup">
            ${g.label ? `<div class="tm-navlabel">${esc(g.label)}</div>` : ""}
            ${g.items.map(([key, label]) => `<button class="tm-navitem ${state.screen === key ? "active" : ""}" data-action="nav" data-screen="${key}">${esc(label)}</button>`).join("")}
          </div>`).join("")}
        <div class="tm-sidefoot">
          <div class="tm-segment">
            <button class="tm-segbtn ${state.theme === "light" ? "active" : ""}" data-action="theme" data-theme="light">Light</button>
            <button class="tm-segbtn ${state.theme === "dark" ? "active" : ""}" data-action="theme" data-theme="dark">Dark</button>
          </div>
          <div class="tm-sidemeta">
            VIN ${esc(auth.vin.slice(-6))}
            &nbsp;·&nbsp;<button data-action="logout" style="background:none;border:none;color:inherit;font:inherit;cursor:pointer;padding:0;text-decoration:underline;">disconnect</button>
          </div>
        </div>
      </aside>
      <div class="tm-nav-backdrop" data-action="nav-close"></div>
      <main class="tm-main">
        <header class="tm-header">
          <button class="tm-menu-btn" data-action="nav-toggle" aria-label="Menu">☰</button>
          <div class="tm-header-title">${TITLES[state.screen][0]}</div>
          <div class="tm-header-sub">${esc(TITLES[state.screen][1])}</div>
          <div class="tm-header-live" id="tm-sync-label">
            <span class="tm-dot tm-dot-live"></span>
            <span id="tm-sync-text">loading…</span>
            <button data-action="refresh" title="Refresh" style="margin-left:8px;background:none;border:none;color:var(--sub);cursor:pointer;font-size:13px;">&#8635;</button>
          </div>
        </header>
        <div class="tm-scroll"><div class="tm-page" id="tm-content"></div></div>
      </main>
    </div>`;

  // Bind once: renderShell re-runs on every navigation, but the click handler
  // and sync timer attach to `root` (not the replaced innerHTML), so re-binding
  // would stack duplicate handlers and timers.
  if (!shellBound) {
    root.addEventListener("click", onRootClick);
    setInterval(tickSyncLabel, 1000);
    shellBound = true;
  }
}

function tickSyncLabel() {
  const el = document.getElementById("tm-sync-text");
  if (el && state.lastSync) el.textContent = `synced ${agoLabel(state.lastSync)}`;
}

function setNavOpen(open) {
  document.querySelector("[data-tm-root]")?.classList.toggle("tm-nav-open", open);
}

function onRootClick(e) {
  const t = e.target.closest("[data-action]");
  if (!t) return;
  const action = t.dataset.action;
  if (action === "nav-toggle") {
    setNavOpen(!document.querySelector("[data-tm-root]")?.classList.contains("tm-nav-open"));
    return;
  } else if (action === "nav-close") {
    setNavOpen(false);
    return;
  }
  if (action === "nav") {
    state.screen = t.dataset.screen;
    state.openDriveId = null;
    state.openChargeId = null;
    renderShell();
    showScreen();
  } else if (action === "theme") {
    state.theme = t.dataset.theme;
    localStorage.setItem("tm_theme", state.theme);
    document.querySelector("[data-tm-root]")?.setAttribute("data-theme", state.theme);
    document.querySelectorAll(".tm-segbtn").forEach((b) => b.classList.toggle("active", b.dataset.theme === state.theme));
  } else if (action === "refresh") {
    state.cache = {};
    showScreen();
  } else if (action === "logout") {
    auth.token = "";
    auth.vin = "";
    state.vehicleData = null;
    renderGate();
  } else if (action === "drive-filter") {
    state.driveFilter = Number(t.dataset.filter);
    renderDrives();
  } else if (action === "open-drive") {
    state.openDriveId = Number(t.dataset.id);
    renderDriveDetail();
  } else if (action === "save-driver") {
    const input = document.getElementById("tm-driver-input");
    const name = input ? input.value.trim() : "";
    t.textContent = "Saving…";
    data.assignDriver(Number(t.dataset.id), name).then(() => {
      // Clear cached driver aggregates + drive lists so they reflect the change.
      delete state.cache.all_drives;
      t.textContent = "Saved ✓";
    }).catch(() => { t.textContent = "Failed"; });
  } else if (action === "back-drives") {
    state.openDriveId = null;
    renderDrives();
  } else if (action === "open-charge") {
    state.openChargeId = Number(t.dataset.id);
    renderChargeDetail();
  } else if (action === "back-charges") {
    state.openChargeId = null;
    renderCharges();
  } else if (action === "goto-bh") {
    state.screen = "bh";
    renderShell();
    showScreen();
  } else if (action === "load-live") {
    loadLiveVehicleData();
  }
}

function setContent(html) {
  const el = document.getElementById("tm-content");
  if (el) el.innerHTML = html;
}
function loadingHtml() {
  return `<div class="tm-empty"><div class="tm-spinner"></div><div>Loading…</div></div>`;
}
function emptyHtml(title, sub) {
  return `<div class="tm-card"><div class="tm-empty"><div class="tm-empty-title">${esc(title)}</div>${sub ? `<div>${esc(sub)}</div>` : ""}</div></div>`;
}
function errorHtml(message) {
  return `<div class="tm-card"><div class="tm-empty"><div class="tm-empty-title" style="color:var(--bad);">Couldn't load this</div><div>${esc(message)}</div></div></div>`;
}

async function showScreen() {
  setContent(loadingHtml());
  try {
    switch (state.screen) {
      case "ov": await renderOverview(); break;
      case "tl": await renderTimeline(); break;
      case "st": await renderStatistics(); break;
      case "dr": await renderDrives(); break;
      case "dv": await renderDrivers(); break;
      case "map": await renderLifetimeMapScreen(); break;
      case "ch": await renderCharges(); break;
      case "cs": await renderChargingStats(); break;
      case "bh": await renderBatteryHealth(); break;
      case "vd": await renderVampireDrain(); break;
    }
    state.lastSync = Date.now();
    tickSyncLabel();
  } catch (e) {
    setContent(errorHtml(e.message));
  }
}

function vin() {
  return auth.vin;
}

async function cached(key, loader) {
  if (state.cache[key]) return state.cache[key];
  const value = await loader();
  state.cache[key] = value;
  return value;
}

/**
 * One failed endpoint (e.g. a newer /data/* route that hasn't been deployed
 * yet) shouldn't blank a whole screen when other Promise.all'd calls on it
 * succeeded — catch here and fall back so the rest of the screen still renders.
 */
async function safe(promise, fallback) {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

async function loadLiveVehicleData() {
  setContent(loadingHtml());
  try {
    state.vehicleData = await mcp.getVehicleData(vin());
  } catch (e) {
    // A generic network-level failure here (not a 401) almost always means the
    // worker's /mcp endpoint doesn't send CORS headers yet — its OPTIONS
    // preflight hits the same auth gate as a real request and gets rejected
    // before any Access-Control-Allow-* header is considered, so the browser
    // blocks the real POST before it's ever sent. /data/* already sends
    // `access-control-allow-origin: *` and works fine cross-origin; /mcp
    // would need the same treatment for this on-demand read to work from a
    // browser. This isn't a token problem.
    const corsLikely = !(e instanceof ApiError && e.status === 401);
    setContent(errorHtml(corsLikely
      ? "Couldn't reach /mcp from the browser — this worker's /mcp endpoint doesn't yet send CORS headers, so on-demand live reads can't run from a web dashboard until that's added server-side. Everything else on this page (drives, charges, degradation, etc.) uses /data/* which already supports this."
      : e.message));
    return;
  }
  await renderOverview();
}

/** Tesla API spend card: month-to-date vs the free-tier poll cap, with a bar. */
function budgetCard(b) {
  if (!b || typeof b !== "object") return "";
  const pct = b.poll_budget_usd > 0 ? Math.min(100, (b.spent_usd / b.poll_budget_usd) * 100) : 0;
  const color = !b.poll_allowed ? "var(--warn)" : "var(--good)";
  const note = !b.poll_allowed ? "polling paused — resumes on the 1st" : "of free-tier cap · never charged";
  return `
    <div class="tm-card tm-card-pad-metric">
      <div class="tm-stat-label">Tesla API spend · ${esc(b.month || "")}</div>
      <div class="tm-stat-value">$${fmt2(b.spent_usd)} <span class="tm-stat-unit">/ $${fmt0(b.poll_budget_usd)}</span></div>
      <div style="height:5px;border-radius:999px;background:var(--chip);margin-top:8px;position:relative;overflow:hidden;">
        <div style="position:absolute;inset:0 auto 0 0;width:${pct.toFixed(1)}%;background:${color};border-radius:999px;"></div>
      </div>
      <div class="tm-stat-note">${esc(note)}</div>
    </div>`;
}

function readTyres(src) {
  // Live vehicle_data uses tpms_pressure_fl; the worker's latest-state store
  // uses the canonical short form tpms_fl. Accept both. Values are bar.
  const vals = ["fl", "fr", "rl", "rr"]
    .map((w) => src?.[`tpms_pressure_${w}`] ?? src?.[`tpms_${w}`])
    .filter((v) => typeof v === "number");
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

async function renderOverview() {
  if (!vin()) return setContent(emptyHtml("No vehicle connected", "Disconnect and reconnect with a VIN."));

  const [summary, latest, locations] = await Promise.all([
    safe(cached("summary", () => data.summary(vin())), null),
    safe(cached("latest", () => data.latest(vin())), null),
    safe(cached("locations", () => data.locations()), []),
  ]);

  const vd = state.vehicleData;
  const cs = vd?.charge_state, cl = vd?.climate_state, vs = vd?.vehicle_state, ds = vd?.drive_state, vc = vd?.vehicle_config;

  const soc = cs?.battery_level ?? latest?.soc ?? null;
  // Live vehicle_data ranges are miles; the worker's store is normalized km.
  // Some firmware omits est_battery_range entirely — fall back to rated range.
  const MI = 1.609344;
  const liveRange = [cs?.est_battery_range, cs?.battery_range].find((v) => typeof v === "number");
  const storedRange = [latest?.est_range, latest?.rated_range].find((v) => typeof v === "number");
  const range = liveRange != null ? liveRange * MI : storedRange ?? null;
  const chargeLimit = cs?.charge_limit_soc ?? null;
  const inside = cl?.inside_temp ?? latest?.inside_temp ?? null;
  const outside = cl?.outside_temp ?? latest?.outside_temp ?? null;
  const tyres = readTyres(vs) ?? readTyres(latest);
  const locked = vs?.locked ?? latest?.locked ?? null;
  // vs.odometer (live read) is miles; summary/latest are already-normalized km.
  const odometer = typeof vs?.odometer === "number" ? vs.odometer * MI : summary?.odometer_km ?? latest?.odometer ?? null;
  const swVersion = vs?.car_version ?? latest?.software_version ?? null;
  const lat = ds?.latitude ?? latest?.lat ?? null;
  const lon = ds?.longitude ?? latest?.lon ?? null;
  const modelSub = vc ? [vc.car_type, vc.trim_badging].filter(Boolean).join(" · ") : "";

  const hasLive = soc != null || range != null;
  // get_vehicle_data only succeeds for an online vehicle (it 408s otherwise, and
  // this worker never wakes on a read), so a loaded vd implies "online" at fetch time.
  const connState = vd ? "online" : latest?.updated_at ? "reporting" : "unknown";

  const socChart = await cached("ov_soc7", async () => {
    try {
      const pts = await data.series(vin(), "soc", 7 * 24);
      return pts.filter((p) => typeof p.value === "number").map((p) => [p.ts, p.value]);
    } catch { return []; }
  });

  const recentFeed = await cached("ov_recent", async () => {
    try {
      const feed = await buildEventFeed(locations, 10);
      return feed.slice(0, 5);
    } catch { return []; }
  });

  const nearestLoc = lat != null && lon != null ? nearestLocation(locations, lat, lon) : null;

  setContent(`
    <div class="tm-grid-2-wide">
      <div class="tm-card tm-card-pad-lg tm-flex-col">
        ${hasLive ? `
          <div class="tm-flex-row">
            <span class="tm-pill ${connState === "online" ? "tm-pill-good" : "tm-pill-chip"}">
              <span class="tm-dot" style="background:${connState === "online" ? "var(--good)" : "var(--faint)"};"></span>
              ${esc(connState)}
            </span>
            ${chargeLimit != null ? `<span style="margin-left:auto;font-size:11.5px;color:var(--faint);">Charge limit ${chargeLimit}%</span>` : ""}
          </div>
          <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:20px;">
            <div>
              <div class="tm-battery-num">${soc != null ? fmt0(soc) : "—"}<span class="tm-battery-pct">%</span></div>
              <div class="tm-stat-label" style="margin-top:8px;">Battery</div>
            </div>
            <div style="text-align:right;">
              <div class="tm-range-num">${range != null ? fmt0(range) : "—"}<span class="tm-stat-unit"> km</span></div>
              <div class="tm-stat-label" style="margin-top:6px;">Estimated range</div>
            </div>
          </div>
          ${soc != null ? `
          <div class="tm-progress">
            <div class="tm-progress-fill" style="width:${Math.max(0, Math.min(100, soc))}%;"></div>
            ${chargeLimit != null ? `<div class="tm-progress-mark" style="left:${chargeLimit}%;"></div>` : ""}
          </div>` : ""}
          <div class="tm-grid-metrics" style="grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:14px;">
            <div><div class="tm-readout-label">Inside</div><div class="tm-readout-value">${inside != null ? fmt1(inside) + " °C" : "—"}</div></div>
            <div><div class="tm-readout-label">Outside</div><div class="tm-readout-value">${outside != null ? fmt1(outside) + " °C" : "—"}</div></div>
            <div><div class="tm-readout-label">Tyres</div><div class="tm-readout-value">${tyres != null ? fmt1(tyres * 14.5038) + " PSI" : "—"}</div></div>
            <div><div class="tm-readout-label">Security</div><div class="tm-readout-value">${locked == null ? "—" : locked ? "Locked" : "Unlocked"}</div></div>
          </div>
        ` : `
          <div class="tm-empty" style="padding:12px 0 4px;">
            <div class="tm-empty-title">No live data loaded yet</div>
            <div>Telemetry isn't streaming in yet, so live battery/climate/lock state isn't cached. Load a one-time on-demand read from the car (this is a billed Tesla API call, and only runs when you click it).</div>
            <button class="tm-gate-btn" style="margin-top:8px;width:auto;padding:8px 16px;" data-action="load-live">Load live data</button>
          </div>
        `}
      </div>
      <div class="tm-card tm-map-card">
        <div id="tm-ov-map" class="tm-map-canvas"></div>
        ${lat != null && lon != null ? `
        <div class="tm-map-overlay">
          <div style="min-width:0;">
            <div class="tm-map-overlay-title">${esc(nearestLoc ? nearestLoc.name : "Current location")}</div>
            <div class="tm-map-overlay-meta">${fmt1(lat)}, ${fmt1(lon)}</div>
          </div>
        </div>` : `<div class="tm-empty" style="height:100%;">No location data yet</div>`}
      </div>
    </div>

    <div class="tm-grid-metrics">
      <div class="tm-card tm-card-pad-metric">
        <div class="tm-stat-label">Odometer</div>
        <div class="tm-stat-value">${odometer != null ? fmt0(odometer) : "—"} <span class="tm-stat-unit">km</span></div>
      </div>
      <div class="tm-card tm-card-pad-metric">
        <div class="tm-stat-label">Software</div>
        <div class="tm-stat-value">${esc(swVersion || "—")}</div>
      </div>
      <div class="tm-card tm-card-pad-metric tm-card-hover" data-action="goto-bh">
        <div class="tm-stat-label">Battery health</div>
        <div class="tm-stat-value">${summary?.pack_kwh ? "see detail" : "—"}</div>
      </div>
      <div class="tm-card tm-card-pad-metric">
        <div class="tm-stat-label">Avg efficiency</div>
        <div class="tm-stat-value">${summary?.avg_efficiency_wh_km != null ? fmt0(summary.avg_efficiency_wh_km) : "—"} <span class="tm-stat-unit">Wh/km</span></div>
      </div>
      ${budgetCard(summary?.api_budget)}
    </div>

    <div class="tm-grid-2">
      <div class="tm-card tm-card-pad">
        <div class="tm-flex-row" style="align-items:baseline;margin-bottom:18px;">
          <div style="font-size:14px;font-weight:600;">Charge level</div>
          <div style="font-size:12px;color:var(--faint);">last 7 days</div>
        </div>
        ${socChart.length > 1 ? svgLineChart({
          series: [{ points: socChart, area: true }],
          yTicks: [0, 25, 50, 75, 100].map((v) => ({ value: v, label: String(v) })),
          xTicks: buildDayTicks(socChart),
          yDomain: [0, 100],
        }) : `<div class="tm-empty">No SoC history yet</div>`}
      </div>
      <div class="tm-card tm-card-pad">
        <div style="font-size:14px;font-weight:600;margin-bottom:14px;">Recent activity</div>
        ${recentFeed.length ? recentFeed.map((e) => `
          <div class="tm-activity-row">
            <span class="tm-dot" style="background:${EVENT_COLOR[e.type]};"></span>
            <div style="min-width:0;">
              <div class="tm-activity-title">${esc(e.title)}</div>
              <div class="tm-activity-meta">${esc(e.meta)}</div>
            </div>
            <span class="tm-activity-time">${fmtTime(e.ts)}</span>
          </div>`).join("") : `<div class="tm-empty">Nothing recorded yet</div>`}
      </div>
    </div>
  `);

  if (lat != null && lon != null) {
    requestAnimationFrame(() => renderPointMap(document.getElementById("tm-ov-map"), lat, lon, esc(nearestLoc?.name || "Current location")));
  }
}

function buildDayTicks(points) {
  if (!points.length) return [];
  const first = points[0][0], last = points[points.length - 1][0];
  const spanH = (last - first) / 3600;
  // Under a day of data, weekday labels all collapse to the same day — label
  // by time-of-day instead so the axis is meaningful from the first sample on.
  const fmt = spanH < 30
    ? (ts) => new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })
    : (ts) => new Date(ts * 1000).toLocaleDateString(undefined, { weekday: "short" });
  const n = last > first ? 6 : 1;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const ts = first + ((last - first) * i) / (n || 1);
    out.push({ value: ts, label: fmt(ts) });
  }
  return out;
}

function nearestLocation(locations, lat, lon, maxM = 300) {
  if (!locations?.length) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const haversine = (lat1, lon1, lat2, lon2) => {
    const R = 6371000;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };
  let best = null;
  for (const l of locations) {
    const d = haversine(lat, lon, l.lat, l.lon);
    if (d <= (l.radius_m || maxM) && (!best || d < best.d)) best = { ...l, d };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Shared event feed (drives + charges + states) for Overview/Timeline
// ---------------------------------------------------------------------------

async function buildEventFeed(locations, driveLimit = 200) {
  const [drives, charges, states] = await Promise.all([
    safe(data.drives(vin(), driveLimit), []),
    safe(data.chargeSessions(vin(), driveLimit), []),
    safe(data.states(vin(), 24 * 21), []), // last 3 weeks
  ]);
  const locName = (id) => (id == null ? null : locations.find((l) => l.id === id)?.name);

  const events = [];
  for (const d of drives) {
    if (d.start_ts == null) continue;
    events.push({
      ts: d.start_ts,
      type: "drive",
      title: `${locName(d.start_location_id) || "Unknown"} → ${locName(d.end_location_id) || "Unknown"}`,
      meta: `${d.distance_km != null ? fmt1(d.distance_km) + " km" : "—"} · ${fmtDurationMin(d.duration_min)}${d.efficiency_wh_km != null ? " · " + fmt0(d.efficiency_wh_km) + " Wh/km" : ""}`,
      raw: d,
    });
  }
  for (const c of charges) {
    if (c.start_ts == null) continue;
    events.push({
      ts: c.start_ts,
      type: "charge",
      title: `Charged at ${chargeLocName(c, locations)}`,
      meta: `${c.energy_added_kwh != null ? "+" + fmt1(c.energy_added_kwh) + " kWh" : "—"}${c.start_soc != null && c.end_soc != null ? ` · ${c.start_soc} → ${c.end_soc}%` : ""}${c.cost != null ? ` · ${money(c.cost, c.currency)}` : ""}`,
      raw: c,
    });
  }
  for (const s of states) {
    if (s.start_ts == null) continue;
    if (s.state === "asleep" || s.state === "offline") {
      events.push({ ts: s.start_ts, type: "sleep", title: s.state === "asleep" ? "Asleep" : "Offline", meta: fmtDurationSec(s.duration_s) });
    } else if (s.state === "updating") {
      events.push({ ts: s.start_ts, type: "update", title: "Software update", meta: fmtDurationSec(s.duration_s) });
    }
  }
  events.sort((a, b) => b.ts - a.ts);
  return events;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

async function renderTimeline() {
  const locations = await safe(cached("locations", () => data.locations()), []);
  const feed = await cached("tl_feed", () => buildEventFeed(locations, 300));
  if (!feed.length) return setContent(emptyHtml("No activity recorded yet", "Once telemetry starts streaming (or you poll on demand), drives, charges and sleep/wake events will show up here."));

  const days = new Map();
  for (const e of feed) {
    const key = fmtDay(e.ts);
    const full = fmtDayFull(e.ts);
    if (!days.has(key)) days.set(key, { label: full, ev: [] });
    days.get(key).ev.push(e);
  }

  setContent(`
    <div style="max-width:760px;display:flex;flex-direction:column;gap:26px;">
      ${[...days.values()].map((day) => `
        <div>
          <div class="tm-timeline-day-label">${esc(day.label)}</div>
          <div class="tm-card" style="padding:6px 22px;">
            ${day.ev.map((e) => `
              <div class="tm-timeline-row">
                <span class="tm-timeline-time">${fmtTime(e.ts)}</span>
                <span class="tm-dot" style="background:${EVENT_COLOR[e.type]};"></span>
                <div style="min-width:0;">
                  <div class="tm-timeline-title">${esc(e.title)}</div>
                  <div class="tm-timeline-meta">${esc(e.meta)}</div>
                </div>
              </div>`).join("")}
          </div>
        </div>`).join("")}
      <div style="font-size:11.5px;color:var(--faint);">Showing the last ${feed.length} recorded events.</div>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

async function renderStatistics() {
  const [drives, charges] = await Promise.all([
    safe(cached("all_drives", () => data.drives(vin(), 2000)), []),
    safe(cached("all_charges", () => data.chargeSessions(vin(), 2000)), []),
  ]);

  const sinceTs = Math.floor(Date.now() / 1000) - 365 * 86400;
  const recentDrives = drives.filter((d) => d.start_ts >= sinceTs);
  const recentCharges = charges.filter((c) => c.start_ts >= sinceTs);

  const totalKm = recentDrives.reduce((s, d) => s + (d.distance_km || 0), 0);
  const totalKwhUsed = recentDrives.reduce((s, d) => s + (d.energy_used_kwh || 0), 0);
  const totalKwhCharged = recentCharges.reduce((s, c) => s + (c.energy_added_kwh || 0), 0);
  const totalCost = recentCharges.reduce((s, c) => s + (c.cost || 0), 0);
  const cur = dominantCurrency(recentCharges);
  const avgWh = totalKm > 1 ? (totalKwhUsed * 1000) / totalKm : null;

  const byMonth = new Map();
  for (const d of recentDrives) {
    const k = monthKey(d.start_ts);
    if (!byMonth.has(k)) byMonth.set(k, { m: monthLabel(d.start_ts), ts: d.start_ts, km: 0, kwh: 0, dr: 0, cost: 0 });
    const row = byMonth.get(k);
    row.km += d.distance_km || 0;
    row.kwh += d.energy_used_kwh || 0;
    row.dr += 1;
  }
  for (const c of recentCharges) {
    const k = monthKey(c.start_ts);
    if (!byMonth.has(k)) byMonth.set(k, { m: monthLabel(c.start_ts), ts: c.start_ts, km: 0, kwh: 0, dr: 0, cost: 0 });
    byMonth.get(k).cost += c.cost || 0;
  }
  const months = [...byMonth.values()].sort((a, b) => a.ts - b.ts);

  if (!drives.length && !charges.length) {
    return setContent(emptyHtml("No drives or charges recorded yet", "Statistics will populate once trips and charging sessions have been logged."));
  }

  setContent(`
    <div class="tm-grid-metrics">
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Distance · 12 mo</div><div class="tm-stat-value">${fmt0(totalKm)} <span class="tm-stat-unit">km</span></div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Energy charged</div><div class="tm-stat-value">${fmt0(totalKwhCharged)} <span class="tm-stat-unit">kWh</span></div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Avg efficiency</div><div class="tm-stat-value">${avgWh != null ? fmt0(avgWh) : "—"} <span class="tm-stat-unit">Wh/km</span></div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Charging cost</div><div class="tm-stat-value">${money(totalCost, cur, 0)}</div></div>
    </div>
    <div class="tm-card tm-card-pad">
      <div class="tm-flex-row" style="align-items:baseline;margin-bottom:18px;">
        <div style="font-size:14px;font-weight:600;">Distance driven</div>
        <div style="font-size:12px;color:var(--faint);">km per month</div>
      </div>
      ${months.length ? svgBarChart({ bars: months.map((m) => ({ label: m.m, value: m.km })) }) : `<div class="tm-empty">No monthly data yet</div>`}
    </div>
    <div class="tm-card tm-table-wrap">
      <div style="min-width:700px;">
        <div class="tm-table-head" style="grid-template-columns:100px 1fr 96px 100px 108px 88px;">
          <div>Month</div><div class="tm-right">Drives</div><div class="tm-right">Distance</div><div class="tm-right">Energy</div><div class="tm-right">Efficiency</div><div class="tm-right">Cost</div>
        </div>
        ${months.slice().reverse().map((m) => `
          <div class="tm-table-row no-click" style="grid-template-columns:100px 1fr 96px 100px 108px 88px;">
            <div style="font-size:13px;font-weight:500;">${esc(m.m)}</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${m.dr}</div>
            <div class="tm-right tm-mono">${fmt0(m.km)} km</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${fmt0(m.kwh)} kWh</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${m.km > 1 ? fmt0((m.kwh * 1000) / m.km) : "—"} Wh/km</div>
            <div class="tm-right tm-mono">${money(m.cost, cur, 0)}</div>
          </div>`).join("")}
      </div>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Drives
// ---------------------------------------------------------------------------

async function renderDrives() {
  if (state.openDriveId != null) return renderDriveDetail();
  const all = await cached("all_drives", () => data.drives(vin(), 2000));
  const locations = await safe(cached("locations", () => data.locations()), []);
  const locName = (id) => (id == null ? "Unknown" : locations.find((l) => l.id === id)?.name || "Unknown");

  const now = Math.floor(Date.now() / 1000);
  const windows = [now - 7 * 86400, now - 30 * 86400, 0];
  const counts = windows.map((since) => all.filter((d) => d.start_ts >= since).length);
  const filtered = all.filter((d) => d.start_ts >= windows[state.driveFilter]);

  setContent(`
    <div class="tm-flex-row" style="gap:8px;">
      ${["7 days", "30 days", "All"].map((label, i) => `
        <button class="tm-chip-btn ${state.driveFilter === i ? "active" : ""}" data-action="drive-filter" data-filter="${i}">${label}<span class="n">${counts[i]}</span></button>
      `).join("")}
    </div>
    ${filtered.length ? `
    <div class="tm-card tm-table-wrap">
      <div style="min-width:840px;">
        <div class="tm-table-head" style="grid-template-columns:150px 1fr 84px 84px 92px 108px 96px;">
          <div>When</div><div>Route</div><div class="tm-right">Distance</div><div class="tm-right">Duration</div><div class="tm-right">Avg speed</div><div class="tm-right">Consumption</div><div class="tm-right">Battery</div>
        </div>
        ${filtered.map((d) => `
          <div class="tm-table-row" data-action="open-drive" data-id="${d.id}" style="grid-template-columns:150px 1fr 84px 84px 92px 108px 96px;">
            <div style="font-size:12.5px;color:var(--sub);">${fmtDateTime(d.start_ts)}</div>
            <div class="tm-ellipsis" style="font-size:13.5px;font-weight:500;">${esc(locName(d.start_location_id))} <span style="color:var(--faint);">→</span> ${esc(locName(d.end_location_id))}</div>
            <div class="tm-right tm-mono">${d.distance_km != null ? fmt1(d.distance_km) : "—"} km</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${fmtDurationMin(d.duration_min)}</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${d.avg_speed != null ? fmt0(d.avg_speed) : "—"} km/h</div>
            <div class="tm-right tm-mono">${d.efficiency_wh_km != null ? fmt0(d.efficiency_wh_km) : "—"} Wh/km</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${d.start_soc != null && d.end_soc != null ? `${d.start_soc} → ${d.end_soc}` : "—"} %</div>
          </div>`).join("")}
        <div class="tm-foot-note">${filtered.length} drive${filtered.length === 1 ? "" : "s"} in range.</div>
      </div>
    </div>` : emptyHtml("No drives in this range", "Try a wider filter, or check back once more trips are logged.")}
  `);
}

async function renderDriveDetail() {
  const detail = await data.drive(state.openDriveId);
  if (detail.error) return setContent(errorHtml(detail.error));
  const { drive: d, path } = detail;
  const locations = await safe(cached("locations", () => data.locations()), []);
  const locName = (id) => (id == null ? "Unknown" : locations.find((l) => l.id === id)?.name || "Unknown");

  const speedPts = path.filter((p) => p.speed != null).map((p) => [(p.ts - d.start_ts) / 60, p.speed]);
  const elevPts = path.filter((p) => p.elevation != null).map((p) => [(p.ts - d.start_ts) / 60, p.elevation]);

  setContent(`
    <div class="tm-flex-row" style="gap:14px;flex-wrap:wrap;">
      <button class="tm-back-btn" data-action="back-drives">← Drives</button>
      <div style="font-size:15px;font-weight:600;">${esc(locName(d.start_location_id))} <span style="color:var(--faint);">→</span> ${esc(locName(d.end_location_id))}</div>
      <div style="font-size:12.5px;color:var(--faint);">${fmtDateTime(d.start_ts)}</div>
      <div class="tm-flex-row" style="margin-left:auto;gap:6px;">
        <span style="font-size:12px;color:var(--sub);">Driver:</span>
        <input id="tm-driver-input" class="tm-gate-input" style="width:140px;padding:5px 9px;font-family:var(--ui);" placeholder="unassigned" value="${esc(d.driver || "")}">
        <button class="tm-chip-btn" style="padding:5px 12px;" data-action="save-driver" data-id="${d.id}">Save</button>
      </div>
    </div>
    ${d.behavior_score != null || d.max_decel_ms2 != null ? `
    <div class="tm-grid-metrics">
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Safety score</div><div class="tm-stat-value" style="color:${scoreColor(d.behavior_score)};">${d.behavior_score != null ? d.behavior_score : "—"}</div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Peak braking</div><div class="tm-stat-value">${d.max_decel_ms2 != null ? fmt2(d.max_decel_ms2 / 9.81) : "—"} <span class="tm-stat-unit">g</span></div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Harsh brakes · accels</div><div class="tm-stat-value">${d.harsh_brake_count ?? 0} · ${d.harsh_accel_count ?? 0}</div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Speeding · night</div><div class="tm-stat-value">${d.over_limit_frac != null ? fmt0(d.over_limit_frac * 100) : "—"} · ${d.night_frac != null ? fmt0(d.night_frac * 100) : "—"} <span class="tm-stat-unit">%</span></div></div>
    </div>` : ""}
    <div class="tm-grid-2-wide">
      <div class="tm-card tm-map-card" style="min-height:300px;">
        <div id="tm-drive-map" class="tm-map-canvas"></div>
        ${path.length < 2 ? `<div class="tm-empty" style="height:100%;">No GPS path recorded for this drive</div>` : ""}
      </div>
      <div class="tm-grid-half" style="align-content:start;">
        <div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Distance</div><div style="font-size:19px;font-weight:600;margin-top:5px;" class="tm-mono">${d.distance_km != null ? fmt1(d.distance_km) : "—"} km</div></div>
        <div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Duration</div><div style="font-size:19px;font-weight:600;margin-top:5px;" class="tm-mono">${fmtDurationMin(d.duration_min)}</div></div>
        <div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Avg · top speed</div><div style="font-size:19px;font-weight:600;margin-top:5px;" class="tm-mono">${d.avg_speed != null ? fmt0(d.avg_speed) : "—"} · ${d.max_speed != null ? fmt0(d.max_speed) : "—"} <span style="font-size:12px;color:var(--sub);">km/h</span></div></div>
        <div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Consumption</div><div style="font-size:19px;font-weight:600;margin-top:5px;" class="tm-mono">${d.efficiency_wh_km != null ? fmt0(d.efficiency_wh_km) : "—"} <span style="font-size:12px;color:var(--sub);">Wh/km</span></div></div>
        <div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Energy used</div><div style="font-size:19px;font-weight:600;margin-top:5px;" class="tm-mono">${d.energy_used_kwh != null ? fmt2(d.energy_used_kwh) : "—"} kWh</div></div>
        <div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Battery</div><div style="font-size:19px;font-weight:600;margin-top:5px;" class="tm-mono">${d.start_soc != null && d.end_soc != null ? `${d.start_soc} → ${d.end_soc}` : "—"} %</div></div>
      </div>
    </div>
    <div class="tm-card tm-card-pad">
      <div class="tm-flex-row" style="align-items:baseline;gap:14px;margin-bottom:18px;">
        <div style="font-size:14px;font-weight:600;">Speed</div>
        <div class="tm-flex-row" style="font-size:11.5px;color:var(--sub);"><span style="width:14px;height:2px;background:var(--accent);border-radius:2px;"></span>km/h</div>
        <div class="tm-flex-row" style="font-size:11.5px;color:var(--sub);"><span style="width:14px;height:2px;background:var(--faint);border-radius:2px;"></span>elevation</div>
        <div style="margin-left:auto;font-size:11.5px;color:var(--faint);">${d.outside_temp_avg != null ? `outside ${fmt1(d.outside_temp_avg)} °C` : ""}</div>
      </div>
      ${speedPts.length > 1 ? svgLineChart({
        series: [
          { points: speedPts, area: true },
          ...(elevPts.length > 1 ? [{ points: elevPts, color: "var(--faint)", dashed: true, width: 1.5 }] : []),
        ],
        yTicks: [0, 25, 50, 75, 100].map((v) => ({ value: v, label: String(v) })),
        xTicks: [0, Math.round((d.duration_min || 0) / 2), Math.round(d.duration_min || 0)].map((v) => ({ value: v, label: `${v} min` })),
      }) : `<div class="tm-empty">No speed samples recorded for this drive</div>`}
    </div>
  `);

  if (path.length >= 2) {
    requestAnimationFrame(() => renderRouteMap(document.getElementById("tm-drive-map"), path));
  }
}

// ---------------------------------------------------------------------------
// Drivers — behaviour & risk scoring
// ---------------------------------------------------------------------------

function scoreColor(score) {
  if (score == null) return "var(--faint)";
  if (score >= 85) return "var(--good)";
  if (score >= 65) return "var(--warn)";
  return "var(--bad)";
}
const FIDELITY_LABEL = {
  good: "reliable",
  coarse: "coarse — harsh-event counts under-report",
  sparse: "sparse — harsh-event metrics not meaningful at this sampling",
};

async function renderDrivers() {
  const res = await data.driverScores(vin());
  const drivers = res?.drivers || [];
  if (!drivers.length) return setContent(emptyHtml("No drives recorded yet", "Once trips are logged you can assign each drive to a driver (on the Drives page) and their risk profile appears here."));

  const hasScores = drivers.some((d) => d.behavior_score != null);

  setContent(`
    <div class="tm-card tm-card-pad" style="background:color-mix(in oklab, var(--accent) 5%, var(--card));">
      <div style="font-size:13px;color:var(--sub);line-height:1.5;">
        <b>How this works.</b> Tesla exposes no way to know <i>who</i> is driving, so assign each trip to a driver on the
        <b>Drives</b> page — then their profile aggregates here. Speed, speeding %, night-driving and mileage are always
        reliable; <b>harsh braking / acceleration / g-force need ~1-second sampling</b> to be meaningful, so at the current
        logging cadence those show as low-fidelity. ${hasScores ? "" : "No behaviour scores yet — they populate as multi-sample drives accumulate."}
      </div>
    </div>
    <div class="tm-grid-3col">
      ${drivers.map((d) => `
        <div class="tm-card tm-card-pad">
          <div class="tm-flex-row" style="justify-content:space-between;align-items:flex-start;">
            <div>
              <div style="font-size:15px;font-weight:600;">${esc(d.driver)}</div>
              <div style="font-size:12px;color:var(--faint);margin-top:2px;">${d.drives} drive${d.drives === 1 ? "" : "s"} · ${fmt0(d.distance_km)} km</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:30px;font-weight:600;font-family:var(--mono);color:${scoreColor(d.behavior_score)};line-height:1;">${d.behavior_score != null ? d.behavior_score : "—"}</div>
              <div style="font-size:10.5px;color:var(--faint);">safety score</div>
            </div>
          </div>
          <div class="tm-grid-half" style="gap:12px;margin-top:16px;">
            ${driverStat("Avg speed", d.avg_speed_kmh, "km/h")}
            ${driverStat("Top speed", d.max_speed_kmh, "km/h")}
            ${driverStat("Speeding", d.over_limit_pct, "%")}
            ${driverStat("Night", d.night_pct, "%")}
            ${driverStat("Peak braking", d.max_decel_g, "g")}
            ${driverStat("Harsh brakes", d.harsh_brakes_per_100km, "/100km")}
          </div>
          <div class="tm-stat-note" style="margin-top:12px;">Harsh-event fidelity: ${esc(FIDELITY_LABEL[d.fidelity] || d.fidelity)}</div>
        </div>`).join("")}
    </div>
  `);
}

function driverStat(label, value, unit) {
  return `<div>
    <div class="tm-readout-label">${esc(label)}</div>
    <div class="tm-readout-value">${value != null ? fmt1(value) : "—"} <span style="font-size:11px;color:var(--sub);font-weight:400;">${esc(unit)}</span></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Lifetime map
// ---------------------------------------------------------------------------

async function renderLifetimeMapScreen() {
  const all = await cached("all_drives", () => data.drives(vin(), 2000));
  const longest = all.reduce((max, d) => (d.distance_km || 0) > (max?.distance_km || 0) ? d : max, null);
  const totalKm = all.reduce((s, d) => s + (d.distance_km || 0), 0);

  setContent(`
    <div class="tm-flex-row" style="gap:8px;flex-wrap:wrap;">
      <span class="tm-pill tm-pill-chip">${fmt0(totalKm)} km lifetime</span>
      <span class="tm-pill tm-pill-chip">${all.length} drives</span>
      ${longest ? `<span class="tm-pill tm-pill-chip">Longest drive ${fmt1(longest.distance_km)} km</span>` : ""}
    </div>
    <div class="tm-card" style="overflow:hidden;position:relative;height:560px;">
      <div id="tm-lifetime-map" class="tm-map-canvas"></div>
      ${all.length === 0 ? `<div class="tm-empty" style="height:100%;">No drives recorded yet</div>` : ""}
    </div>
  `);

  if (all.length > 0) {
    const withPaths = all.slice(0, 300);
    const paths = await Promise.all(withPaths.map(async (d) => {
      try {
        const detail = await data.drive(d.id);
        return (detail.path || []).filter((p) => p.lat != null && p.lon != null).map((p) => [p.lat, p.lon]);
      } catch { return []; }
    }));
    requestAnimationFrame(() => renderLifetimeMap(document.getElementById("tm-lifetime-map"), paths.filter((p) => p.length > 1)));
  }
}

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

async function renderCharges() {
  if (state.openChargeId != null) return renderChargeDetail();
  const charges = await cached("all_charges", () => data.chargeSessions(vin(), 2000));
  const locations = await safe(cached("locations", () => data.locations()), []);

  if (!charges.length) return setContent(emptyHtml("No charge sessions recorded yet", "Charging history will appear here once sessions have been logged."));

  setContent(`
    <div class="tm-card tm-table-wrap">
      <div style="min-width:840px;">
        <div class="tm-table-head" style="grid-template-columns:140px 1fr 56px 92px 96px 96px 88px 80px;">
          <div>When</div><div>Location</div><div>Type</div><div class="tm-right">Energy</div><div class="tm-right">Battery</div><div class="tm-right">Avg power</div><div class="tm-right">Duration</div><div class="tm-right">Cost</div>
        </div>
        ${charges.map((c) => `
          <div class="tm-table-row" data-action="open-charge" data-id="${c.id}" style="grid-template-columns:140px 1fr 56px 92px 96px 96px 88px 80px;">
            <div style="font-size:12.5px;color:var(--sub);">${fmtDateTime(c.start_ts)}</div>
            <div class="tm-ellipsis" style="font-size:13.5px;font-weight:500;">${esc(chargeLocName(c, locations))}</div>
            <div><span class="tm-badge ${c.charge_type === "DC" ? "tm-badge-dc" : "tm-badge-ac"}">${esc(c.charge_type || "AC")}</span></div>
            <div class="tm-right tm-mono">${c.energy_added_kwh != null ? "+" + fmt1(c.energy_added_kwh) : "—"} kWh</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${c.start_soc != null && c.end_soc != null ? `${c.start_soc} → ${c.end_soc}` : "—"} %</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${c.max_charger_power != null ? fmt0(c.max_charger_power) : "—"} kW</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${fmtDurationMin(c.duration_min)}</div>
            <div class="tm-right tm-mono">${money(c.cost, c.currency)}</div>
          </div>`).join("")}
        <div class="tm-foot-note">${charges.length} session${charges.length === 1 ? "" : "s"}.</div>
      </div>
    </div>
  `);
}

async function renderChargeDetail() {
  const detail = await data.chargeCurve(state.openChargeId);
  if (detail.error) return setContent(errorHtml(detail.error));
  const { session: c, curve } = detail;
  const locations = await safe(cached("locations", () => data.locations()), []);

  const t0 = c.start_ts;
  const powerPts = curve.filter((p) => p.charger_power != null).map((p) => [(p.ts - t0) / 60, p.charger_power]);
  const socPts = curve.filter((p) => p.soc != null).map((p) => [(p.ts - t0) / 60, p.soc]);
  const rate = c.energy_added_kwh && c.cost ? c.cost / c.energy_added_kwh : null;
  const backfilled = c.source === "backfill";

  setContent(`
    <div class="tm-flex-row" style="gap:14px;">
      <button class="tm-back-btn" data-action="back-charges">← Charges</button>
      <div style="font-size:15px;font-weight:600;">${esc(chargeLocName(c, locations))}</div>
      <span class="tm-badge ${c.charge_type === "DC" ? "tm-badge-dc" : "tm-badge-ac"}">${esc(c.charge_type || "AC")}</span>
      <div style="font-size:12.5px;color:var(--faint);">${fmtDateTime(c.start_ts)}</div>
    </div>
    <div class="tm-grid-metrics">
      <div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Energy added</div><div style="font-size:19px;font-weight:600;margin-top:5px;" class="tm-mono">${c.energy_added_kwh != null ? "+" + fmt1(c.energy_added_kwh) : "—"} kWh</div></div>
      <div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Battery</div><div style="font-size:19px;font-weight:600;margin-top:5px;" class="tm-mono">${c.start_soc != null && c.end_soc != null ? `${c.start_soc} → ${c.end_soc}` : "—"} %</div></div>
      <div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Peak power</div><div style="font-size:19px;font-weight:600;margin-top:5px;" class="tm-mono">${c.max_charger_power != null ? fmt0(c.max_charger_power) : "—"} <span style="font-size:12px;color:var(--sub);">kW</span></div></div>
      <div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Cost</div><div style="font-size:19px;font-weight:600;margin-top:5px;" class="tm-mono">${money(c.cost, c.currency)}${rate != null ? ` <span style="font-size:12px;color:var(--sub);">@ ${money(rate, c.currency)}/kWh</span>` : ""}</div></div>
    </div>
    ${backfilled ? `<div style="font-size:11.5px;color:var(--faint);">Imported from Tesla charging history — SoC and per-minute charge curve aren't available for backfilled Supercharger sessions.</div>` : ""}
    <div class="tm-card tm-card-pad">
      <div class="tm-flex-row" style="align-items:baseline;gap:14px;margin-bottom:18px;">
        <div style="font-size:14px;font-weight:600;">Charge curve</div>
        <div class="tm-flex-row" style="font-size:11.5px;color:var(--sub);"><span style="width:14px;height:2px;background:var(--accent);border-radius:2px;"></span>Power (kW)</div>
        <div class="tm-flex-row" style="font-size:11.5px;color:var(--sub);"><span style="width:14px;height:2px;background:var(--good);border-radius:2px;"></span>State of charge</div>
        <div style="margin-left:auto;font-size:11.5px;color:var(--faint);">${fmtDurationMin(c.duration_min)} total</div>
      </div>
      ${powerPts.length > 1 ? svgLineChart({
        series: [
          { points: powerPts, area: true },
          ...(socPts.length > 1 ? [{ points: socPts, color: "var(--good)", dashed: true, width: 1.5 }] : []),
        ],
        yTicks: (c.charge_type === "DC" ? [0, 40, 80, 120, 160] : [0, 3, 6, 9, 12]).map((v) => ({ value: v, label: String(v) })),
        xTicks: [0, Math.round((c.duration_min || 0) / 2), Math.round(c.duration_min || 0)].map((v) => ({ value: v, label: `${v} min` })),
      }) : `<div class="tm-empty">No power samples recorded for this session</div>`}
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Charging stats
// ---------------------------------------------------------------------------

async function renderChargingStats() {
  const charges = await cached("all_charges", () => data.chargeSessions(vin(), 2000));
  const locations = await safe(cached("locations", () => data.locations()), []);
  const complete = charges.filter((c) => c.status === "complete" || c.energy_added_kwh != null);

  if (!complete.length) return setContent(emptyHtml("No completed charge sessions yet", "Lifetime charging stats will appear here once sessions have been logged."));

  const cur = dominantCurrency(complete);
  const totalEnergy = complete.reduce((s, c) => s + (c.energy_added_kwh || 0), 0);
  const totalCost = complete.reduce((s, c) => s + (c.cost || 0), 0);
  const avgPrice = totalEnergy > 0 ? totalCost / totalEnergy : null;
  const totalKm = (await safe(cached("all_drives", () => data.drives(vin(), 2000)), [])).reduce((s, d) => s + (d.distance_km || 0), 0);
  const costPer100 = totalKm > 0 ? (totalCost / totalKm) * 100 : null;

  const byMonth = new Map();
  for (const c of complete) {
    const k = monthKey(c.start_ts);
    if (!byMonth.has(k)) byMonth.set(k, { m: monthLabel(c.start_ts), ts: c.start_ts, kwh: 0 });
    byMonth.get(k).kwh += c.energy_added_kwh || 0;
  }
  const months = [...byMonth.values()].sort((a, b) => a.ts - b.ts).slice(-12);

  const ac = complete.filter((c) => c.charge_type !== "DC");
  const dc = complete.filter((c) => c.charge_type === "DC");
  const acKwh = ac.reduce((s, c) => s + (c.energy_added_kwh || 0), 0);
  const dcKwh = dc.reduce((s, c) => s + (c.energy_added_kwh || 0), 0);

  const byLoc = new Map();
  for (const c of complete) {
    const name = chargeLocName(c, locations);
    if (!byLoc.has(name)) byLoc.set(name, { name, kwh: 0, n: 0 });
    const row = byLoc.get(name);
    row.kwh += c.energy_added_kwh || 0;
    row.n += 1;
  }
  const topLocs = [...byLoc.values()].sort((a, b) => b.kwh - a.kwh).slice(0, 6);
  const maxLocKwh = Math.max(1, ...topLocs.map((l) => l.kwh));

  setContent(`
    <div class="tm-grid-metrics">
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Total energy</div><div class="tm-stat-value">${fmt0(totalEnergy)} <span class="tm-stat-unit">kWh</span></div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Total cost</div><div class="tm-stat-value">${money(totalCost, cur, 0)}</div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Avg price</div><div class="tm-stat-value">${money(avgPrice, cur)} <span class="tm-stat-unit">/kWh</span></div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Cost per 100 km</div><div class="tm-stat-value">${money(costPer100, cur)}</div></div>
    </div>
    <div class="tm-grid-2">
      <div class="tm-card tm-card-pad">
        <div class="tm-flex-row" style="align-items:baseline;margin-bottom:18px;">
          <div style="font-size:14px;font-weight:600;">Energy charged</div>
          <div style="font-size:12px;color:var(--faint);">kWh per month</div>
        </div>
        ${months.length ? svgBarChart({ bars: months.map((m) => ({ label: m.m, value: m.kwh })) }) : `<div class="tm-empty">No monthly data yet</div>`}
      </div>
      <div class="tm-card tm-card-pad tm-flex-col">
        <div style="font-size:14px;font-weight:600;">AC vs DC</div>
        <div style="display:flex;height:12px;border-radius:999px;overflow:hidden;gap:2px;">
          ${svgSplitBar([{ value: acKwh, color: "var(--good)" }, { value: dcKwh, color: "var(--accent)" }])}
        </div>
        <div class="tm-flex-col" style="gap:10px;">
          <div class="tm-flex-row" style="font-size:13px;"><span style="width:8px;height:8px;border-radius:2px;background:var(--good);"></span>AC <span style="color:var(--faint);font-size:12px;">${ac.length} sessions</span><span style="margin-left:auto;font-family:var(--mono);font-size:12.5px;">${fmt0(acKwh)} kWh</span></div>
          <div class="tm-flex-row" style="font-size:13px;"><span style="width:8px;height:8px;border-radius:2px;background:var(--accent);"></span>DC <span style="color:var(--faint);font-size:12px;">${dc.length} sessions</span><span style="margin-left:auto;font-family:var(--mono);font-size:12.5px;">${fmt0(dcKwh)} kWh</span></div>
        </div>
        <div style="border-top:1px solid var(--line2);padding-top:16px;" class="tm-flex-col">
          <div style="display:flex;font-size:12.5px;color:var(--sub);"><span>Sessions</span><span style="margin-left:auto;font-family:var(--mono);">${complete.length}</span></div>
          <div style="display:flex;font-size:12.5px;color:var(--sub);"><span>Avg per session</span><span style="margin-left:auto;font-family:var(--mono);">${fmt1(totalEnergy / complete.length)} kWh</span></div>
        </div>
      </div>
    </div>
    <div class="tm-card tm-card-pad">
      <div style="font-size:14px;font-weight:600;margin-bottom:16px;">Top locations</div>
      <div class="tm-flex-col" style="gap:14px;">
        ${topLocs.map((l) => `
          <div style="display:grid;grid-template-columns:220px 1fr 110px 110px;gap:16px;align-items:center;">
            <div class="tm-ellipsis" style="font-size:13px;font-weight:500;">${esc(l.name)}</div>
            <div style="height:8px;border-radius:999px;background:var(--chip);position:relative;"><div style="position:absolute;inset:0 auto 0 0;width:${((l.kwh / maxLocKwh) * 100).toFixed(1)}%;border-radius:999px;background:var(--accent);opacity:0.85;"></div></div>
            <div class="tm-mono tm-right" style="font-size:12.5px;">${fmt0(l.kwh)} kWh</div>
            <div class="tm-right" style="font-size:12px;color:var(--faint);">${l.n} sessions</div>
          </div>`).join("")}
      </div>
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Battery health
// ---------------------------------------------------------------------------

async function renderBatteryHealth() {
  const deg = await cached("degradation", () => data.degradation(vin()));
  const summary = await cached("summary", () => data.summary(vin()));

  if (!deg.series?.length || deg.degradation_pct == null) {
    return setContent(emptyHtml("Not enough data yet", deg.note || "Battery health needs at least two charge sessions ending above 50% state of charge."));
  }

  const health = Math.max(0, 100 - deg.degradation_pct);
  const pts = deg.series.map((s) => [s.ts, s.projected_range_100_km]);
  const distSpan = summary?.odometer_km != null ? `over ${fmt0(summary.odometer_km)} km` : "";

  setContent(`
    <div class="tm-grid-3col">
      <div class="tm-card tm-card-pad-lg tm-flex-col" style="align-items:center;justify-content:center;">
        ${svgDonut({ pct: health, label: fmt1(health) + "%" })}
        <div style="font-size:12.5px;color:var(--sub);text-align:center;">−${fmt1(deg.degradation_pct)}% ${distSpan}</div>
      </div>
      <div class="tm-grid-half" style="align-content:stretch;">
        <div class="tm-card" style="padding:20px 22px;"><div class="tm-stat-label">Usable capacity</div><div class="tm-stat-value">${deg.pack_kwh != null ? fmt1(deg.pack_kwh) : "—"} <span class="tm-stat-unit">kWh</span></div></div>
        <div class="tm-card" style="padding:20px 22px;"><div class="tm-stat-label">Rated range @ 100%</div><div class="tm-stat-value">${fmt0(deg.latest_projected_range_100_km)} <span class="tm-stat-unit">km</span></div><div class="tm-stat-note">${fmt0(deg.first_projected_range_100_km)} km at first sample</div></div>
        <div class="tm-card" style="padding:20px 22px;"><div class="tm-stat-label">Samples</div><div class="tm-stat-value">${deg.samples}</div></div>
        <div class="tm-card" style="padding:20px 22px;"><div class="tm-stat-label">Avg efficiency</div><div class="tm-stat-value">${summary?.avg_efficiency_wh_km != null ? fmt0(summary.avg_efficiency_wh_km) : "—"} <span class="tm-stat-unit">Wh/km</span></div></div>
      </div>
    </div>
    <div class="tm-card tm-card-pad">
      <div class="tm-flex-row" style="align-items:baseline;margin-bottom:18px;">
        <div style="font-size:14px;font-weight:600;">Projected range @ 100%</div>
        <div style="font-size:12px;color:var(--faint);">km vs time, from completed charges</div>
      </div>
      ${pts.length > 1 ? svgLineChart({
        series: [{ points: pts, area: true }],
        yTicks: autoTicks(pts.map((p) => p[1]), 4),
        xTicks: [pts[0], pts[pts.length - 1]].map((p) => ({ value: p[0], label: new Date(p[0] * 1000).toLocaleDateString(undefined, { month: "short", year: "2-digit" }) })),
      }) : `<div class="tm-empty">Need more charge sessions to plot a trend</div>`}
    </div>
  `);
}

function autoTicks(values, n) {
  const min = Math.min(...values), max = Math.max(...values);
  const out = [];
  for (let i = 0; i <= n; i++) out.push({ value: min + ((max - min) * i) / n, label: fmt0(min + ((max - min) * i) / n) });
  return out;
}

// ---------------------------------------------------------------------------
// Vampire drain
// ---------------------------------------------------------------------------

async function renderVampireDrain() {
  const v = await cached("vampire", () => data.vampire(vin(), 30));
  if (!v.idle_spans) return setContent(emptyHtml("No idle periods recorded yet", "Vampire drain needs some parked time with telemetry samples before/after to measure loss."));

  const totalKwh = v.total_soc_lost_pct != null && (await cached("summary", () => data.summary(vin())))?.pack_kwh
    ? (v.total_soc_lost_pct / 100) * state.cache.summary.pack_kwh
    : null;

  setContent(`
    <div class="tm-grid-metrics">
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Avg drain · idle</div><div class="tm-stat-value">${v.avg_pct_per_day != null ? fmt2(v.avg_pct_per_day) : "—"} <span class="tm-stat-unit">%/day</span></div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Idle spans</div><div class="tm-stat-value">${v.idle_spans}</div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Lost · ${v.days} days</div><div class="tm-stat-value">${fmt1(v.total_soc_lost_pct)} <span class="tm-stat-unit">% SOC</span></div>${totalKwh != null ? `<div class="tm-stat-note">≈ ${fmt1(totalKwh)} kWh</div>` : ""}</div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Total idle time</div><div class="tm-stat-value">${fmt0(v.total_idle_hours)} <span class="tm-stat-unit">h</span></div></div>
    </div>
    <div class="tm-card tm-table-wrap">
      <div style="min-width:800px;">
        <div class="tm-table-head" style="grid-template-columns:140px 96px 84px 96px;">
          <div>Parked since</div><div class="tm-right">Standby</div><div class="tm-right">SoC lost</div><div class="tm-right">Rate</div>
        </div>
        ${v.spans.slice().reverse().map((s) => `
          <div class="tm-table-row no-click" style="grid-template-columns:140px 96px 84px 96px;">
            <div style="font-size:12.5px;color:var(--sub);">${fmtDateTime(s.start_ts)}</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${fmt1(s.hours)} h</div>
            <div class="tm-right tm-mono">−${fmt2(s.soc_lost)}%</div>
            <div class="tm-right tm-mono">${fmt3(s.pct_per_day)} %/day</div>
          </div>`).join("")}
      </div>
    </div>
  `);
}
function fmt3(n) { return n == null ? "—" : (Math.round(n * 1000) / 1000).toString(); }

// ---------------------------------------------------------------------------

boot();
