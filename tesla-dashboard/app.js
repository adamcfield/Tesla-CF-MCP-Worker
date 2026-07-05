import { auth, data, mcp, verifyToken, exportUrl, ApiError } from "./api.js";
import { svgLineChart, svgBarChart, svgDonut, svgSplitBar } from "./charts.js";
import { destroyMaps, renderPointMap, renderRouteMap, renderLifetimeMap, attachReplay } from "./map.js";

const root = document.getElementById("app");
let shellBound = false; // guards one-time attach of the root click handler + sync timer

// PWA: cache-first app shell via sw.js. Progressive enhancement only — the
// try/catch (plus register()'s own rejection handler) means an environment
// without service workers, or plain localhost dev with a strict browser
// profile, never breaks the app.
try {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => { /* e.g. file://, private mode */ });
  }
} catch { /* service workers unavailable — fine */ }

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const fmt0 = (n) => (n == null || Number.isNaN(n) ? "—" : Math.round(n).toLocaleString());
const fmt1 = (n) => (n == null || Number.isNaN(n) ? "—" : (Math.round(n * 10) / 10).toLocaleString());
const fmt2 = (n) => (n == null || Number.isNaN(n) ? "—" : (Math.round(n * 100) / 100).toFixed(2));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** Copy text to the clipboard, flashing a "Copied ✓" confirmation on the button. */
function copyToClipboard(text, btn) {
  const flash = () => {
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = "Copied ✓";
    setTimeout(() => { btn.textContent = prev; }, 1400);
  };
  const fallback = () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      flash();
    } catch { if (btn) btn.textContent = "Copy failed"; }
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(flash).catch(fallback);
  } else {
    fallback();
  }
}

const CURRENCY_SYMBOL = { ILS: "₪", USD: "$", EUR: "€", GBP: "£", AUD: "A$", CAD: "C$" };
function money(amount, currency, decimals = 2) {
  if (amount == null || Number.isNaN(amount)) return "—";
  const sym = CURRENCY_SYMBOL[currency] ?? (currency ? currency + " " : "€");
  return sym + (decimals === 0 ? fmt0(amount) : fmt2(amount));
}
/** Drive endpoint label: a named geofence if the point matched one, else the reverse-geocoded place, else Unknown. */
function driveEndpoint(d, which, locations) {
  const id = d[which + "_location_id"];
  if (id != null) {
    const l = locations.find((x) => x.id === id);
    if (l) return l.name;
  }
  return d[which + "_address"] || "Unknown";
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
  driverFilter: "__all", // "__all" | "__none" (unassigned) | driver name
  openDriveId: null,
  openChargeId: null,
  openPlaceId: null,
  renderedScreen: null, // last screen whose content actually painted (skeleton vs refresh-in-place)
  syncing: false,
  lastSync: null,
  cache: {}, // per-screen fetched payloads, cleared on manual refresh
  askTranscript: [], // Ask-Tessa chat history — in-memory only, never persisted
  askPending: false, // true while an /ai/ask request is in flight
};

const NAV = [
  { label: "", items: [["ask", "✦ Ask Tessa"], ["ov", "Overview"], ["tl", "Timeline"], ["st", "Statistics"]] },
  { label: "Driving", items: [["dr", "Drives"], ["dv", "Drivers"], ["pl", "Places"], ["map", "Lifetime map"]] },
  { label: "Charging", items: [["ch", "Charges"], ["cs", "Charging stats"]] },
  { label: "Battery", items: [["bh", "Battery health"], ["pr", "Predictions"], ["vd", "Vampire drain"]] },
];

const TITLES = {
  ask: ["Ask Tessa", "natural-language answers about your car"],
  ov: ["Overview", ""],
  tl: ["Timeline", "drives, charges & sleep/wake"],
  st: ["Statistics", "last 12 months"],
  dr: ["Drives", ""],
  dv: ["Drivers", "behaviour & risk scoring"],
  pl: ["Places", "saved locations & suggestions"],
  map: ["Lifetime map", ""],
  ch: ["Charges", ""],
  cs: ["Charging stats", "lifetime"],
  bh: ["Battery health", ""],
  pr: ["Predictions", "battery forecast & range predictor"],
  vd: ["Vampire drain", "standby losses"],
};

const EVENT_COLOR = { drive: "var(--accent)", charge: "var(--good)", sleep: "var(--faint)", update: "#8A63D2" };

// ---------------------------------------------------------------------------
// Boot / auth gate
// ---------------------------------------------------------------------------

/**
 * One-tap login from a pre-filled link (?token=&vin=&origin=), for saving the
 * dashboard to a phone home screen. Credentials are copied into localStorage
 * and then stripped from the URL via replaceState, so the token doesn't linger
 * in the address bar, browser history, or any bookmark the URL gets saved into.
 * Use a per-device READ token (mint via the worker's /auth/device-token) — a
 * bearer secret; treat the link as private.
 *
 * SECURITY — token exfiltration guard: a crafted link that supplies ONLY an
 * `origin` (no token of its own) must never cause an already-stored token to
 * be shipped to that attacker origin (every fetch appends ?token=). So when an
 * origin arrives WITHOUT an accompanying token and it differs from the current
 * one, we clear the stored token and force re-login at the gate for the new
 * origin. A legitimate setup link always carries its own token, so it's
 * unaffected; a bare ?origin= link just drops you at the login screen.
 */
function consumeUrlCredentials() {
  // Accept params from the query string or the hash (hash keeps them out of
  // referer headers if the page ever links out).
  const fromQuery = new URLSearchParams(location.search);
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const pick = (k) => fromQuery.get(k) ?? fromHash.get(k);
  const token = pick("token");
  const vinParam = pick("vin");
  const origin = pick("origin");
  if (!token && !vinParam && !origin) return;
  if (origin) {
    const norm = origin.replace(/\/+$/, "");
    if (!token && norm !== (localStorage.getItem("tm_origin") || "")) {
      auth.token = ""; // never send an existing token to a URL-supplied new origin
    }
    localStorage.setItem("tm_origin", norm);
  }
  if (token) auth.token = token.trim();
  if (vinParam) auth.vin = vinParam.trim().toUpperCase();
  // Scrub the credentials out of the visible URL + history entry.
  try {
    history.replaceState(null, "", location.pathname);
  } catch { /* non-browser / sandbox */ }
}

async function boot() {
  consumeUrlCredentials();
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
  if (state.syncing) return; // "syncing…" holds until the load settles
  const el = document.getElementById("tm-sync-text");
  if (el && state.lastSync) el.textContent = `synced ${agoLabel(state.lastSync)}`;
}

function setSyncing(on) {
  state.syncing = on;
  const el = document.getElementById("tm-sync-text");
  if (el && on) el.textContent = "syncing…";
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
    state.openPlaceId = null;
    renderShell();
    showScreen();
  } else if (action === "theme") {
    state.theme = t.dataset.theme;
    localStorage.setItem("tm_theme", state.theme);
    document.querySelector("[data-tm-root]")?.setAttribute("data-theme", state.theme);
    document.querySelectorAll(".tm-segbtn").forEach((b) => b.classList.toggle("active", b.dataset.theme === state.theme));
    showScreen(); // maps must rebuild on the theme-matched basemap (data is cached, so this is instant)
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
  } else if (action === "driver-filter") {
    state.driverFilter = t.dataset.driver;
    renderDrives();
  } else if (action === "edit-driver") {
    if (!t.querySelector(".tm-driver-edit")) beginDriverEdit(t, Number(t.dataset.id));
  } else if (action === "open-place") {
    state.openPlaceId = Number(t.dataset.id);
    renderPlaceDetail();
  } else if (action === "back-places") {
    state.openPlaceId = null;
    renderPlaces();
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
  } else if (action === "ask-send") {
    askSubmit();
  } else if (action === "ask-suggest") {
    const q = t.dataset.q || "";
    const input = document.getElementById("tm-ask-input");
    if (input) input.value = q;
    askSubmit(q);
  } else if (action === "predict-run") {
    runRangePrediction();
  } else if (action === "view-cert") {
    loadDriveCertificate(Number(t.dataset.id));
  } else if (action === "copy-cert") {
    copyToClipboard(t.dataset.text || "", t);
  } else if (action === "print-report") {
    openPrintableReport(Number(t.dataset.id));
  }
}

function setContent(html) {
  // Any repaint replaces DOM that may hold live Leaflet instances (and replay
  // animation frames) — tear those down first so nothing leaks between renders.
  destroyMaps();
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

// ---------------------------------------------------------------------------
// Skeletons — first paint of a screen shows a shimmer approximating its layout;
// refreshes of an already-painted screen keep the old content visible until the
// fresh render replaces it (no blank flash).
// ---------------------------------------------------------------------------

function skel(style) {
  return `<div class="tm-skeleton" style="${style}"></div>`;
}
function skeletonHtml(screen) {
  const metric = `<div class="tm-card tm-card-pad-metric">${skel("height:12px;width:55%;")}${skel("height:22px;width:75%;margin-top:10px;")}</div>`;
  const metrics = `<div class="tm-grid-metrics">${metric.repeat(4)}</div>`;
  const chart = `<div class="tm-card tm-card-pad">${skel("height:12px;width:150px;margin-bottom:16px;")}${skel("height:180px;")}</div>`;
  const tableRows = (n) => Array.from({ length: n }, () =>
    `<div style="padding:15px 22px;border-bottom:1px solid var(--line2);">${skel("height:13px;")}</div>`).join("");
  const table = (n) => `<div class="tm-card">${tableRows(n)}</div>`;
  const mapCard = (h) => `<div class="tm-card tm-map-card" style="min-height:${h}px;">${skel("position:absolute;inset:0;border-radius:0;")}</div>`;
  const cards3 = `<div class="tm-grid-3col">${(`<div class="tm-card tm-card-pad">${skel("height:15px;width:45%;")}${skel("height:11px;width:65%;margin-top:10px;")}${skel("height:80px;margin-top:16px;")}</div>`).repeat(3)}</div>`;

  switch (screen) {
    case "ask":
      return `<div class="tm-card tm-card-pad">${skel("height:15px;width:45%;")}${skel("height:12px;width:70%;margin-top:12px;")}<div class="tm-flex-row" style="gap:8px;margin-top:18px;">${skel("height:30px;width:150px;border-radius:999px;").repeat(3)}</div></div>`;
    case "pr":
      return `<div class="tm-grid-2">${chart}${chart}</div>`;
    case "ov":
      return `<div class="tm-grid-2-wide"><div class="tm-card tm-card-pad-lg">${skel("height:20px;width:80px;")}${skel("height:54px;width:45%;margin-top:22px;")}${skel("height:10px;margin-top:22px;border-radius:999px;")}${skel("height:40px;margin-top:20px;")}</div>${mapCard(280)}</div>${metrics}<div class="tm-grid-2">${chart}${chart}</div>`;
    case "tl":
      return `<div style="max-width:760px;">${skel("height:12px;width:120px;margin-bottom:12px;")}${table(6)}</div>`;
    case "st":
      return `${metrics}${chart}${chart}${table(6)}`;
    case "dr":
    case "ch":
      return `<div class="tm-flex-row" style="gap:8px;">${skel("height:30px;width:86px;border-radius:999px;").repeat(3)}</div>${table(9)}`;
    case "dv":
    case "pl":
      return cards3;
    case "map":
      return `<div class="tm-flex-row" style="gap:8px;">${skel("height:24px;width:120px;border-radius:999px;").repeat(3)}</div>${mapCard(560)}`;
    case "bh":
      return `<div class="tm-grid-3col"><div class="tm-card tm-card-pad-lg" style="display:flex;align-items:center;justify-content:center;">${skel("height:132px;width:132px;border-radius:50%;")}</div>${metric.repeat(2)}</div>${chart}`;
    case "cs":
      return `${metrics}<div class="tm-grid-2">${chart}${chart}</div>`;
    case "vd":
      return `${metrics}${table(6)}`;
    default:
      return loadingHtml();
  }
}

async function showScreen() {
  // First visit to a screen paints a skeleton; re-running the same screen
  // (manual refresh, theme flip, driver save) keeps what's there until the
  // new markup lands.
  const contentEl = document.getElementById("tm-content");
  if (!contentEl || contentEl.childElementCount === 0 || state.renderedScreen !== state.screen) {
    setContent(skeletonHtml(state.screen));
  }
  setSyncing(true);
  try {
    switch (state.screen) {
      case "ask": await renderAskTessa(); break;
      case "ov": await renderOverview(); break;
      case "tl": await renderTimeline(); break;
      case "st": await renderStatistics(); break;
      case "dr": await renderDrives(); break;
      case "dv": await renderDrivers(); break;
      case "pl": await renderPlaces(); break;
      case "map": await renderLifetimeMapScreen(); break;
      case "ch": await renderCharges(); break;
      case "cs": await renderChargingStats(); break;
      case "bh": await renderBatteryHealth(); break;
      case "pr": await renderPredictions(); break;
      case "vd": await renderVampireDrain(); break;
    }
    state.renderedScreen = state.screen;
    state.lastSync = Date.now();
  } catch (e) {
    setContent(errorHtml(e.message));
  } finally {
    setSyncing(false);
    tickSyncLabel();
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

const WHEELS = [["fl", "FL"], ["fr", "FR"], ["rl", "RL"], ["rr", "RR"]];

/**
 * TPMS card: 4-corner pressure grid in bar. A wheel highlights amber when it
 * deviates >0.3 bar from the 4-wheel median, or is trending down faster than
 * 0.15 bar/week (slow puncture signature).
 */
function tpmsCard(t) {
  const latest = t?.latest ?? null;
  const trend = t?.trend_bar_per_week ?? null;
  const vals = latest ? WHEELS.map(([w]) => latest[w]).filter((v) => typeof v === "number") : [];
  let median = null;
  if (vals.length === 4) {
    const s = vals.slice().sort((a, b) => a - b);
    median = (s[1] + s[2]) / 2;
  }
  const flag = (w) => {
    const v = latest?.[w];
    if (typeof v !== "number") return false;
    if (median != null && Math.abs(v - median) > 0.3) return true;
    const tr = trend?.[w];
    return typeof tr === "number" && tr < -0.15;
  };
  const anyWarn = WHEELS.some(([w]) => flag(w));
  return `
    <div class="tm-card tm-card-pad-metric">
      <div class="tm-stat-label" style="display:flex;align-items:baseline;">Tyre pressure
        ${anyWarn ? `<span class="tm-pill tm-pill-warn" style="margin-left:auto;">check</span>` : `<span style="margin-left:auto;font-size:11px;color:var(--faint);">bar</span>`}
      </div>
      <div class="tm-tpms-grid">
        ${WHEELS.map(([w, label]) => `
          <div class="tm-tpms-cell ${flag(w) ? "warn" : ""}">
            <div class="tm-tpms-pos">${label}</div>
            <div class="tm-tpms-val">${typeof latest?.[w] === "number" ? fmt1(latest[w]) : "—"}</div>
          </div>`).join("")}
      </div>
      <div class="tm-stat-note">${latest?.ts != null ? `as of ${fmtDateTime(latest.ts)}` : "no TPMS samples yet"}</div>
    </div>`;
}

async function renderOverview() {
  if (!vin()) return setContent(emptyHtml("No vehicle connected", "Disconnect and reconnect with a VIN."));

  const [summary, latest, locations, tires] = await Promise.all([
    safe(cached("summary", () => data.summary(vin())), null),
    safe(cached("latest", () => data.latest(vin())), null),
    safe(cached("locations", () => data.locations()), []),
    safe(cached("tires", () => data.tires(vin(), 30)), null),
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
      ${tpmsCard(tires)}
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
      title: `${driveEndpoint(d, "start", locations)} → ${driveEndpoint(d, "end", locations)}`,
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

/** Scatter/line of avg Wh/km per 5 °C outside-temp bin, from /data/efficiency-by-temp. */
function efficiencyByTempCard(et) {
  const bins = (et?.bins || []).filter((b) => b.avg_wh_km != null);
  const totalDrives = bins.reduce((s, b) => s + (b.drives || 0), 0);
  const pts = bins.map((b) => [(b.t_min + b.t_max) / 2, b.avg_wh_km]);
  return `
    <div class="tm-card tm-card-pad">
      <div class="tm-flex-row" style="align-items:baseline;margin-bottom:18px;">
        <div style="font-size:14px;font-weight:600;">Efficiency vs temperature</div>
        <div style="font-size:12px;color:var(--faint);">avg Wh/km per 5 °C bin${totalDrives ? ` · ${totalDrives} drives` : ""}</div>
      </div>
      ${pts.length >= 2 ? svgLineChart({
        series: [{
          points: pts,
          markers: true,
          titles: bins.map((b) => `${fmt1(b.t_min)}–${fmt1(b.t_max)} °C · ${fmt0(b.avg_wh_km)} Wh/km · ${b.drives ?? "?"} drives · ${fmt0(b.distance_km)} km`),
        }],
        yTicks: autoTicks(pts.map((p) => p[1]), 4),
        xTicks: pts.map((p) => ({ value: p[0], label: `${fmt0(p[0])}°` })),
      }) : `<div class="tm-empty">Not enough temperature-tagged drives yet — this fills in as drives with outside-temperature samples accumulate.</div>`}
    </div>`;
}

/** Monthly report table from /data/monthly (most recent first). */
function monthlyReportTable(rows) {
  const cur = rows.find((m) => m.currency)?.currency || null;
  return `
    <div class="tm-card tm-table-wrap">
      <div style="min-width:900px;">
        <div style="padding:18px 22px 4px;font-size:14px;font-weight:600;">Monthly report</div>
        <div class="tm-table-head" style="grid-template-columns:92px 1fr 96px 88px 84px 104px 96px 88px 96px;">
          <div>Month</div><div class="tm-right">Drives</div><div class="tm-right">Distance</div><div class="tm-right">Energy</div><div class="tm-right">Wh/km</div><div class="tm-right">Charged</div><div class="tm-right">AC / DC</div><div class="tm-right">Cost</div><div class="tm-right">Cost/100km</div>
        </div>
        ${rows.map((m) => `
          <div class="tm-table-row no-click" style="grid-template-columns:92px 1fr 96px 88px 84px 104px 96px 88px 96px;">
            <div style="font-size:13px;font-weight:500;">${esc(m.month ?? "—")}</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${m.drives ?? "—"}</div>
            <div class="tm-right tm-mono">${fmt0(m.distance_km)} km</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${fmt0(m.drive_energy_kwh)} kWh</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${fmt0(m.avg_wh_km)}</div>
            <div class="tm-right tm-mono">${fmt0(m.charge_kwh)} kWh</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${fmt0(m.ac_kwh)} / ${fmt0(m.dc_kwh)}</div>
            <div class="tm-right tm-mono">${money(m.charge_cost, m.currency ?? cur, 0)}</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${money(m.cost_per_100km, m.currency ?? cur)}</div>
          </div>`).join("")}
        <div class="tm-foot-note">${rows.length} month${rows.length === 1 ? "" : "s"} · ${rows.reduce((s, m) => s + (m.charge_sessions || 0), 0)} charge sessions.</div>
      </div>
    </div>`;
}

async function renderStatistics() {
  const [drives, charges, effTemp, monthlyRes] = await Promise.all([
    safe(cached("all_drives", () => data.drives(vin(), 2000)), []),
    safe(cached("all_charges", () => data.chargeSessions(vin(), 2000)), []),
    safe(cached("eff_temp", () => data.efficiencyByTemp(vin())), null),
    safe(cached("monthly", () => data.monthly(vin(), 12)), null),
  ]);
  const monthlyRows = monthlyRes?.months || []; // most recent first (server contract)

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
      ${monthlyRows.length ? svgBarChart({ bars: monthlyRows.slice().reverse().map((m) => ({ label: monthShort(m.month), value: m.distance_km || 0 })) })
        : months.length ? svgBarChart({ bars: months.map((m) => ({ label: m.m, value: m.km })) })
        : `<div class="tm-empty">No monthly data yet</div>`}
    </div>
    ${efficiencyByTempCard(effTemp)}
    ${monthlyRows.length ? monthlyReportTable(monthlyRows) : `
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
    </div>`}
  `);
}

/** "2026-06" → "Jun 26" for chart axis labels. */
function monthShort(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || "");
  if (!m) return ym || "—";
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
}

// ---------------------------------------------------------------------------
// Drives
// ---------------------------------------------------------------------------

/** Distinct assigned driver names across the loaded drives (for chips + datalist). */
function knownDrivers(drives) {
  return [...new Set(drives.map((d) => d.driver).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

/** Driver cell body: assigned name, or the classifier's guess (muted, "?"-suffixed), or —. */
function driverCellHtml(d) {
  if (d.driver) return esc(d.driver);
  if (d.suggested_driver) return `<span class="tm-driver-suggested">${esc(d.suggested_driver)}?</span>`;
  return `<span style="color:var(--faint);">—</span>`;
}

/** Swap a driver cell for an inline input (datalist of known names); saves on Enter/blur. */
function beginDriverEdit(cell, id) {
  const drives = state.cache.all_drives || [];
  const row = drives.find((d) => d.id === id);
  const current = row?.driver || "";
  cell.innerHTML = `<input class="tm-driver-edit" list="tm-driver-names" value="${esc(current)}" placeholder="${esc(row?.suggested_driver ? row.suggested_driver + "?" : "driver…")}" autocomplete="off">`;
  const input = cell.querySelector("input");
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (!save || name === current) {
      cell.innerHTML = row ? driverCellHtml(row) : "—";
      return;
    }
    cell.innerHTML = `<span style="color:var(--faint);">saving…</span>`;
    data.assignDriver(id, name).then(() => {
      if (row) row.driver = name || null;
      renderDrives(); // refresh chips + cells against the updated cache
    }).catch(() => {
      cell.innerHTML = `<span style="color:var(--bad);">failed</span>`;
    });
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.focus();
  input.select();
}

async function renderDrives() {
  if (state.openDriveId != null) return renderDriveDetail();
  const all = await cached("all_drives", () => data.drives(vin(), 2000));
  const locations = await safe(cached("locations", () => data.locations()), []);
  const roster = await loadDriverRoster();

  const now = Math.floor(Date.now() / 1000);
  const windows = [now - 7 * 86400, now - 30 * 86400, 0];
  const counts = windows.map((since) => all.filter((d) => d.start_ts >= since).length);
  const inWindow = all.filter((d) => d.start_ts >= windows[state.driveFilter]);

  const drivers = knownDrivers(all);
  if (state.driverFilter !== "__all" && state.driverFilter !== "__none" && !drivers.includes(state.driverFilter)) {
    state.driverFilter = "__all"; // stale filter (driver renamed away)
  }
  const matchesDriver = (d) =>
    state.driverFilter === "__all" ? true :
    state.driverFilter === "__none" ? !d.driver :
    d.driver === state.driverFilter;
  const filtered = inWindow.filter(matchesDriver);
  const driverChips = [
    ["__all", "All", inWindow.length],
    ...drivers.map((name) => [name, name, inWindow.filter((d) => d.driver === name).length]),
    ["__none", "Unassigned", inWindow.filter((d) => !d.driver).length],
  ];
  const cols = "150px minmax(180px,1fr) 110px 84px 84px 92px 108px 96px";

  setContent(`
    <div class="tm-flex-row" style="gap:8px;flex-wrap:wrap;">
      ${["7 days", "30 days", "All"].map((label, i) => `
        <button class="tm-chip-btn ${state.driveFilter === i ? "active" : ""}" data-action="drive-filter" data-filter="${i}">${label}<span class="n">${counts[i]}</span></button>
      `).join("")}
      <a class="tm-chip-btn" style="margin-left:auto;" href="${esc(exportUrl("/data/export/drives.csv", { vin: vin() }))}" target="_blank" rel="noopener" download>&#11015; CSV</a>
    </div>
    ${drivers.length || inWindow.some((d) => !d.driver) ? `
    <div class="tm-flex-row" style="gap:8px;flex-wrap:wrap;">
      ${driverChips.map(([key, label, n]) => `
        <button class="tm-chip-btn ${state.driverFilter === key ? "active" : ""}" data-action="driver-filter" data-driver="${esc(key)}">${esc(label)}<span class="n">${n}</span></button>
      `).join("")}
    </div>` : ""}
    ${roster.length ? rosterHintHtml(roster) : ""}
    <datalist id="tm-driver-names">${[...new Set([...drivers, ...roster.map(rosterName)].filter(Boolean))].sort((a, b) => a.localeCompare(b)).map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>
    ${filtered.length ? `
    <div class="tm-card tm-table-wrap">
      <div style="min-width:960px;">
        <div class="tm-table-head" style="grid-template-columns:${cols};">
          <div>When</div><div>Route</div><div>Driver</div><div class="tm-right">Distance</div><div class="tm-right">Duration</div><div class="tm-right">Avg speed</div><div class="tm-right">Consumption</div><div class="tm-right">Battery</div>
        </div>
        ${filtered.map((d) => `
          <div class="tm-table-row" data-action="open-drive" data-id="${d.id}" style="grid-template-columns:${cols};">
            <div style="font-size:12.5px;color:var(--sub);">${fmtDateTime(d.start_ts)}</div>
            <div class="tm-ellipsis" style="font-size:13.5px;font-weight:500;">${esc(driveEndpoint(d, "start", locations))} <span style="color:var(--faint);">→</span> ${esc(driveEndpoint(d, "end", locations))}</div>
            <div class="tm-ellipsis" data-action="edit-driver" data-id="${d.id}" title="Click to assign driver" style="font-size:12.5px;">${driverCellHtml(d)}</div>
            <div class="tm-right tm-mono">${d.distance_km != null ? fmt1(d.distance_km) : "—"} km</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${fmtDurationMin(d.duration_min)}</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${d.avg_speed != null ? fmt0(d.avg_speed) : "—"} km/h</div>
            <div class="tm-right tm-mono">${d.efficiency_wh_km != null ? fmt0(d.efficiency_wh_km) : "—"} Wh/km</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${d.start_soc != null && d.end_soc != null ? `${d.start_soc} → ${d.end_soc}` : "—"} %</div>
          </div>`).join("")}
        <div class="tm-foot-note">${filtered.length} drive${filtered.length === 1 ? "" : "s"} in range. Click a driver cell to assign; <span class="tm-driver-suggested">italic?</span> names are unconfirmed suggestions. ${esc(DRIVER_MANUAL_NOTE)}</div>
      </div>
    </div>` : emptyHtml("No drives in this range", "Try a wider filter, or check back once more trips are logged.")}
  `);
}

async function renderDriveDetail() {
  const detail = await data.drive(state.openDriveId);
  if (detail.error) return setContent(errorHtml(detail.error));
  const { drive: d, path } = detail;
  const locations = await safe(cached("locations", () => data.locations()), []);
  const roster = await loadDriverRoster();
  const locName = (id) => (id == null ? "Unknown" : locations.find((l) => l.id === id)?.name || "Unknown");

  const speedPts = path.filter((p) => p.speed != null).map((p) => [(p.ts - d.start_ts) / 60, p.speed]);
  const elevPts = path.filter((p) => p.elevation != null).map((p) => [(p.ts - d.start_ts) / 60, p.elevation]);

  setContent(`
    ${driverDatalistHtml(roster, "tm-driver-names-detail")}
    <div class="tm-flex-row" style="gap:14px;flex-wrap:wrap;">
      <button class="tm-back-btn" data-action="back-drives">← Drives</button>
      <div style="font-size:15px;font-weight:600;">${esc(driveEndpoint(d, "start", locations))} <span style="color:var(--faint);">→</span> ${esc(driveEndpoint(d, "end", locations))}</div>
      <div style="font-size:12.5px;color:var(--faint);">${fmtDateTime(d.start_ts)}</div>
      <div class="tm-flex-row" style="margin-left:auto;gap:6px;">
        <a class="tm-chip-btn" style="padding:5px 12px;" href="${esc(exportUrl("/data/export/drive.gpx", { id: d.id }))}" target="_blank" rel="noopener" download>&#11015; GPX</a>
        <span style="font-size:12px;color:var(--sub);">Driver:</span>
        <input id="tm-driver-input" list="tm-driver-names-detail" class="tm-gate-input" style="width:140px;padding:5px 9px;font-family:var(--ui);" placeholder="${esc(d.suggested_driver ? `${d.suggested_driver}?` : "unassigned")}" value="${esc(d.driver || "")}" autocomplete="off">
        <button class="tm-chip-btn" style="padding:5px 12px;" data-action="save-driver" data-id="${d.id}">Save</button>
      </div>
    </div>
    ${rosterHintHtml(roster)}
    <div style="font-size:12px;color:var(--faint);">${esc(DRIVER_MANUAL_NOTE)}${!d.driver && d.suggested_driver ? ` Looks like <span class="tm-driver-suggested">${esc(d.suggested_driver)}</span> drove this — pick a name and Save to confirm.` : ""}</div>
    ${d.behavior_score != null || d.max_decel_ms2 != null ? `
    <div class="tm-grid-metrics">
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Safety score</div><div class="tm-stat-value" style="color:${scoreColor(d.behavior_score)};">${d.behavior_score != null ? d.behavior_score : "—"}</div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Peak braking</div><div class="tm-stat-value">${d.max_decel_ms2 != null ? fmt2(d.max_decel_ms2 / 9.81) : "—"} <span class="tm-stat-unit">g</span></div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Harsh brakes · accels</div><div class="tm-stat-value">${d.harsh_brake_count ?? 0} · ${d.harsh_accel_count ?? 0}</div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Speeding · night</div><div class="tm-stat-value">${d.over_limit_frac != null ? fmt0(d.over_limit_frac * 100) : "—"} · ${d.night_frac != null ? fmt0(d.night_frac * 100) : "—"} <span class="tm-stat-unit">%</span></div></div>
      ${d.max_jerk_ms3 != null ? `<div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Peak jerk</div><div class="tm-stat-value">${fmt1(d.max_jerk_ms3)} <span class="tm-stat-unit">m/s³</span></div></div>` : ""}
    </div>` : ""}
    ${riskCertificateSection(d)}
    <div class="tm-grid-2-wide">
      <div class="tm-card tm-map-card" style="min-height:300px;">
        <div id="tm-drive-map" class="tm-map-canvas"></div>
        ${path.length >= 2 ? `<button class="tm-replay-btn" id="tm-replay-btn" title="Replay drive">&#9654;</button>` : ""}
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
    requestAnimationFrame(() => {
      const map = renderRouteMap(document.getElementById("tm-drive-map"), path);
      attachReplay(map, path, document.getElementById("tm-replay-btn"));
    });
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
  const baselineNote = res?.baseline_note || res?.note || null;

  setContent(`
    <div class="tm-card tm-card-pad" style="background:color-mix(in oklab, var(--accent) 5%, var(--card));">
      <div style="font-size:13px;color:var(--sub);line-height:1.5;">
        <b>How this works.</b> Tesla exposes no way to know <i>who</i> is driving, so assign each trip to a driver on the
        <b>Drives</b> page — then their profile aggregates here. Speed, speeding %, night-driving and mileage are always
        reliable; <b>harsh braking / acceleration / g-force need ~1-second sampling</b> to be meaningful, so at the current
        logging cadence those show as low-fidelity. ${hasScores ? "" : "No behaviour scores yet — they populate as multi-sample drives accumulate."}
      </div>
      ${baselineNote ? `<div style="font-size:12px;color:var(--faint);line-height:1.5;margin-top:10px;border-top:1px solid var(--line2);padding-top:10px;"><b>Baseline.</b> ${esc(baselineNote)}</div>` : ""}
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
          ${driverPercentileHtml(d)}
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

/** Percentile-vs-baseline + confidence band strip on a driver card (new score fields; may be absent). */
function driverPercentileHtml(d) {
  const hasPercentile = d.percentile != null;
  const hasBand = d.score_low != null && d.score_high != null;
  if (!hasPercentile && !hasBand && !d.score_confidence) return "";
  const conf = d.score_confidence ? (CONFIDENCE_LABEL[d.score_confidence] || d.score_confidence) : null;
  const parts = [];
  if (d.behavior_score != null) parts.push(`${d.behavior_score}/100`);
  if (hasPercentile) parts.push(`${ordinal(Math.round(d.percentile))} percentile`);
  if (conf) parts.push(esc(conf));
  return `<div class="tm-driver-percentile">
    <span class="tm-pill tm-pill-chip" style="font-size:11px;">${parts.join(" · ")}</span>
    ${hasBand ? `<span class="tm-stat-note" style="margin-top:0;">band ${d.score_low}–${d.score_high}</span>` : ""}
  </div>`;
}

/** 82 → "82nd", 76 → "76th" etc. */
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function driverStat(label, value, unit) {
  return `<div>
    <div class="tm-readout-label">${esc(label)}</div>
    <div class="tm-readout-value">${value != null ? fmt1(value) : "—"} <span style="font-size:11px;color:var(--sub);font-weight:400;">${esc(unit)}</span></div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Places — saved geofence locations + visit-based suggestions
// ---------------------------------------------------------------------------

async function renderPlaces() {
  if (state.openPlaceId != null) return renderPlaceDetail();
  const [locations, suggestedRes] = await Promise.all([
    safe(cached("locations", () => data.locations()), []),
    safe(cached("suggested_locations", () => data.suggestedLocations(vin())), null),
  ]);
  const suggestions = suggestedRes?.suggestions || [];

  setContent(`
    ${suggestions.length ? `
    <div class="tm-card tm-card-pad">
      <div class="tm-flex-row" style="align-items:baseline;margin-bottom:6px;">
        <div style="font-size:14px;font-weight:600;">Suggested places</div>
        <div style="font-size:12px;color:var(--faint);">frequent stops that aren't saved yet</div>
      </div>
      <div style="font-size:12px;color:var(--faint);margin-bottom:8px;">
        Locations are managed with the worker's <code>set_location</code> MCP tool — this dashboard is read-only, so ask
        Claude to save one (name + coordinates below) and it'll appear in the list.
      </div>
      ${suggestions.map((s) => `
        <div class="tm-activity-row">
          <span class="tm-dot" style="background:var(--warn);"></span>
          <div style="min-width:0;">
            <div class="tm-activity-title">${esc(s.label || "Unnamed spot")}</div>
            <div class="tm-activity-meta">${s.lat != null && s.lon != null ? `${fmt1(s.lat)}, ${fmt1(s.lon)}` : ""}</div>
          </div>
          <span class="tm-activity-time">${s.visits != null ? `${s.visits} visit${s.visits === 1 ? "" : "s"}` : ""}</span>
        </div>`).join("")}
    </div>` : ""}
    ${locations.length ? `
    <div class="tm-card tm-table-wrap">
      <div style="min-width:520px;">
        <div class="tm-table-head" style="grid-template-columns:1fr 150px 96px;">
          <div>Name</div><div class="tm-right">Coordinates</div><div class="tm-right">Radius</div>
        </div>
        ${locations.map((l) => `
          <div class="tm-table-row" data-action="open-place" data-id="${l.id}" style="grid-template-columns:1fr 150px 96px;">
            <div class="tm-ellipsis" style="font-size:13.5px;font-weight:500;">${esc(l.name)}</div>
            <div class="tm-right tm-mono" style="color:var(--sub);font-size:12px;">${fmt1(l.lat)}, ${fmt1(l.lon)}</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${l.radius_m != null ? fmt0(l.radius_m) + " m" : "—"}</div>
          </div>`).join("")}
        <div class="tm-foot-note">${locations.length} saved place${locations.length === 1 ? "" : "s"} · click one for its stats.</div>
      </div>
    </div>` : emptyHtml("No saved places yet", "Save geofence locations (home, work, …) with the set_location MCP tool and drives/charges will auto-label against them.")}
  `);
}

async function renderPlaceDetail() {
  const stats = await safe(data.locationStats(state.openPlaceId), null);
  if (!stats || stats.error || !stats.location) {
    return setContent(`
      <div class="tm-flex-row"><button class="tm-back-btn" data-action="back-places">← Places</button></div>
      ${errorHtml(stats?.error || "Couldn't load this location")}`);
  }
  const l = stats.location;
  // Location stats carry no currency of their own — borrow the dominant one
  // from any already-loaded charge sessions (falls back to € in money()).
  const cur = dominantCurrency(state.cache.all_charges || []);

  setContent(`
    <div class="tm-flex-row" style="gap:14px;flex-wrap:wrap;">
      <button class="tm-back-btn" data-action="back-places">← Places</button>
      <div style="font-size:15px;font-weight:600;">${esc(l.name)}</div>
      <div style="font-size:12.5px;color:var(--faint);">${fmt1(l.lat)}, ${fmt1(l.lon)} · ${l.radius_m != null ? fmt0(l.radius_m) + " m radius" : ""}</div>
    </div>
    <div class="tm-grid-2-wide">
      <div class="tm-card tm-map-card" style="min-height:280px;">
        <div id="tm-place-map" class="tm-map-canvas"></div>
      </div>
      <div class="tm-grid-half" style="align-content:start;">
        <div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Drives from here</div><div class="tm-stat-value">${fmt0(stats.drives_from)}</div></div>
        <div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Drives to here</div><div class="tm-stat-value">${fmt0(stats.drives_to)}</div></div>
        <div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Charge sessions</div><div class="tm-stat-value">${fmt0(stats.charge_sessions)}</div></div>
        <div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Energy charged</div><div class="tm-stat-value">${fmt1(stats.total_energy_added_kwh)} <span class="tm-stat-unit">kWh</span></div></div>
        <div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Charging cost</div><div class="tm-stat-value">${money(stats.total_cost, cur)}</div></div>
        ${l.cost_per_kwh != null ? `<div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Tariff</div><div class="tm-stat-value">${money(l.cost_per_kwh, cur)} <span class="tm-stat-unit">/kWh</span></div></div>` : ""}
      </div>
    </div>
  `);

  if (l.lat != null && l.lon != null) {
    requestAnimationFrame(() => renderPointMap(document.getElementById("tm-place-map"), l.lat, l.lon, esc(l.name)));
  }
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
    <div class="tm-flex-row" style="gap:8px;">
      <span class="tm-pill tm-pill-chip">${charges.length} session${charges.length === 1 ? "" : "s"}</span>
      <a class="tm-chip-btn" style="margin-left:auto;" href="${esc(exportUrl("/data/export/charges.csv", { vin: vin() }))}" target="_blank" rel="noopener" download>&#11015; CSV</a>
    </div>
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

  // Optional asleep-vs-awake split (newer worker builds) shown alongside the
  // blended number. The worker returns `sleep`/`awake` as top-level keys; only
  // treat it as present when a bucket actually has idle time (avoids an
  // all-zero split card on old data).
  const bd = (v.sleep?.hours || v.awake?.hours) ? { sleep: v.sleep, awake: v.awake } : (v.breakdown || null);
  const splitCard = (label, part, hint) => part ? `
    <div class="tm-card tm-card-pad-metric">
      <div class="tm-stat-label">${esc(label)}</div>
      <div class="tm-stat-value">${part.pct_per_day != null ? fmt2(part.pct_per_day) : "—"} <span class="tm-stat-unit">%/day</span></div>
      <div class="tm-stat-note">${part.hours != null ? fmt0(part.hours) + " h" : "—"}${part.soc_lost != null ? ` · −${fmt2(part.soc_lost)}% SOC` : ""} · ${esc(hint)}</div>
    </div>` : "";

  setContent(`
    <div class="tm-grid-metrics">
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Avg drain · idle</div><div class="tm-stat-value">${v.avg_pct_per_day != null ? fmt2(v.avg_pct_per_day) : "—"} <span class="tm-stat-unit">%/day</span></div>${bd ? `<div class="tm-stat-note">blended asleep + awake</div>` : ""}</div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Idle spans</div><div class="tm-stat-value">${v.idle_spans}</div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Lost · ${v.days} days</div><div class="tm-stat-value">${fmt1(v.total_soc_lost_pct)} <span class="tm-stat-unit">% SOC</span></div>${totalKwh != null ? `<div class="tm-stat-note">≈ ${fmt1(totalKwh)} kWh</div>` : ""}</div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Total idle time</div><div class="tm-stat-value">${fmt0(v.total_idle_hours)} <span class="tm-stat-unit">h</span></div></div>
    </div>
    ${bd && (bd.sleep || bd.awake) ? `
    <div class="tm-grid-half">
      ${splitCard("Asleep", bd.sleep, "deep sleep — this is the floor")}
      ${splitCard("Awake idle", bd.awake, "sentry, cabin protection, app pings")}
    </div>` : ""}
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

// ===========================================================================
// FRONTIER 1 — Insurance-grade
// ===========================================================================

/**
 * Household driver roster from /data/drivers (Tesla-reported names + anyone
 * already tagged). New endpoint — 404s until the worker ships it, in which case
 * we fall back to names harvested from loaded drives so the picker still works.
 * Returns [{ name, source, ... }] with source "tesla" | "tagged".
 */
async function loadDriverRoster() {
  const roster = await safe(cached("drivers_roster", () => data.drivers(vin())), null);
  if (roster && Array.isArray(roster.drivers)) return roster.drivers;
  // Fallback: reuse whatever names we've seen assigned across loaded drives.
  const fromDrives = knownDrivers(state.cache.all_drives || []);
  return fromDrives.map((name) => ({ name, source: "tagged" }));
}

/** Roster display name — prefer the composed first/last, else the raw name. */
function rosterName(r) {
  const composed = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
  return composed || r.name || "Unknown";
}

/** <datalist> options + a small "who's in the household" hint, from the roster. */
function driverDatalistHtml(roster, id = "tm-driver-names") {
  const names = [...new Set(roster.map(rosterName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return `<datalist id="${id}">${names.map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>`;
}

/** Roster chips (Tesla-sourced names get a ⬤ badge) — a visual hint of who to assign. */
function rosterHintHtml(roster) {
  if (!roster.length) return "";
  return `<div class="tm-roster-hint">
    <span class="tm-roster-hint-label">Household</span>
    ${roster.map((r) => `<span class="tm-roster-chip" title="${esc(r.source === "tesla" ? "from your Tesla account" : "previously tagged")}">${r.source === "tesla" ? `<span class="tm-roster-dot">⬤</span>` : ""}${esc(rosterName(r))}</span>`).join("")}
  </div>`;
}

const DRIVER_MANUAL_NOTE = "Tesla can't auto-detect who drove — assignment is manual/assisted.";

// --- Claims-grade drive report: risk certificate + printable report ---------

const CONFIDENCE_LABEL = { high: "high confidence", medium: "medium confidence", low: "low confidence" };

/**
 * Risk-certificate section on the drive-detail screen: score + confidence band,
 * over-limit severity + speed-limit source, coach note, plus the always-available
 * "View signed certificate" and "Printable report" buttons (these are claims/
 * incident artifacts for any drive, independent of whether behaviour scores
 * exist — the score sub-parts degrade individually to "—").
 */
function riskCertificateSection(d) {
  const hasBand = d.score_low != null && d.score_high != null;
  const hasSeverity = d.over_limit_severity != null;
  const hasCoach = !!d.coach_note;
  const conf = d.score_confidence ? CONFIDENCE_LABEL[d.score_confidence] || d.score_confidence : null;
  const limitSrc = d.speed_limit_source === "osm" ? "OSM posted limits" : d.speed_limit_source === "none" ? "no limit data" : null;
  return `
    <div class="tm-card tm-card-pad">
      <div class="tm-flex-row" style="align-items:baseline;margin-bottom:14px;">
        <div style="font-size:14px;font-weight:600;">Risk certificate</div>
        <div style="font-size:12px;color:var(--faint);">claims-grade, signed on demand</div>
        <div class="tm-flex-row" style="margin-left:auto;gap:6px;">
          <button class="tm-chip-btn" style="padding:5px 12px;" data-action="view-cert" data-id="${d.id}">View signed certificate</button>
          <button class="tm-chip-btn" style="padding:5px 12px;" data-action="print-report" data-id="${d.id}">🖨 Printable report</button>
        </div>
      </div>
      <div class="tm-grid-metrics">
        <div class="tm-card tm-card-pad-metric" style="background:var(--bg);">
          <div class="tm-stat-label">Safety score</div>
          <div class="tm-stat-value" style="color:${scoreColor(d.behavior_score)};">${d.behavior_score != null ? d.behavior_score : "—"}${hasBand ? ` <span class="tm-stat-unit">band ${d.score_low}–${d.score_high}</span>` : ""}</div>
          <div class="tm-stat-note">${conf ? esc(conf) : "confidence not reported"}</div>
        </div>
        <div class="tm-card tm-card-pad-metric" style="background:var(--bg);">
          <div class="tm-stat-label">Over-limit severity</div>
          <div class="tm-stat-value">${hasSeverity ? "+" + fmt1(d.over_limit_severity) : "—"} <span class="tm-stat-unit">km/h avg</span></div>
          <div class="tm-stat-note">${limitSrc ? esc(limitSrc) : "vs posted speed limit"}</div>
        </div>
      </div>
      ${hasCoach ? `<div class="tm-coach-note"><span class="tm-coach-badge">Coach</span>${esc(d.coach_note)}</div>` : ""}
      <div id="tm-cert-body"></div>
    </div>`;
}

/** Fetch + render the signed certificate inline (canonical JSON + signature + verify URL + copy). */
async function loadDriveCertificate(id) {
  const target = document.getElementById("tm-cert-body");
  if (!target) return;
  target.innerHTML = `<div class="tm-cert-panel"><div class="tm-flex-row" style="gap:8px;color:var(--sub);font-size:12.5px;"><div class="tm-spinner" style="width:16px;height:16px;border-width:2px;"></div>Fetching signed certificate…</div></div>`;
  let cert;
  try {
    cert = await data.driveCertificate(id);
  } catch (e) {
    // The currently-deployed worker uniformly 400s unknown /data/* routes, so a
    // 400/404/501 here almost always means "certificate endpoint not deployed yet".
    const unavailable = !(e instanceof ApiError) || [400, 404, 501].includes(e.status);
    target.innerHTML = `<div class="tm-cert-panel"><div style="font-size:12.5px;color:var(--faint);">${unavailable
      ? "Signed certificates aren't available on this worker yet — this endpoint hasn't been deployed. The score, band and coach note above are the shareable summary for now."
      : "Couldn't fetch the certificate: " + esc(e.message)}</div></div>`;
    return;
  }
  if (!cert || cert.error) {
    target.innerHTML = `<div class="tm-cert-panel"><div style="font-size:12.5px;color:var(--faint);">${esc(cert?.error || "No certificate returned for this drive.")}</div></div>`;
    return;
  }
  const canonicalJson = JSON.stringify(cert.canonical ?? {}, null, 2);
  const copyPayload = JSON.stringify(cert, null, 2);
  target.innerHTML = `
    <div class="tm-cert-panel">
      <div class="tm-flex-row" style="flex-wrap:wrap;gap:8px 14px;margin-bottom:10px;">
        <div><span class="tm-cert-key">Algorithm</span> <span class="tm-mono" style="font-size:12px;">${esc(cert.algorithm || "—")}</span></div>
        ${cert.issued_ts != null ? `<div><span class="tm-cert-key">Issued</span> <span class="tm-mono" style="font-size:12px;">${esc(fmtDateTime(cert.issued_ts))}</span></div>` : ""}
        ${cert.drive_id != null ? `<div><span class="tm-cert-key">Drive</span> <span class="tm-mono" style="font-size:12px;">#${esc(cert.drive_id)}</span></div>` : ""}
      </div>
      <div class="tm-cert-key">Canonical drive metrics</div>
      <pre class="tm-cert-json">${esc(canonicalJson)}</pre>
      <div class="tm-cert-key" style="margin-top:10px;">Signature (HMAC-SHA256)</div>
      <div class="tm-cert-sig tm-mono">${esc(cert.signature_hex || "—")}</div>
      <div class="tm-flex-row" style="gap:8px;margin-top:12px;flex-wrap:wrap;">
        <button class="tm-chip-btn" style="padding:5px 12px;" data-action="copy-cert" data-text="${esc(copyPayload)}">Copy certificate JSON</button>
        ${cert.verify_url ? `<a class="tm-chip-btn" style="padding:5px 12px;" href="${esc(cert.verify_url)}" target="_blank" rel="noopener">Open verify URL ↗</a>` : ""}
      </div>
      ${cert.verify_url ? `<div class="tm-stat-note" style="margin-top:6px;word-break:break-all;">${esc(cert.verify_url)}</div>` : ""}
    </div>`;
}

/**
 * Open a clean, print-friendly incident/claims report for a drive in a new
 * window — map snapshot (static, via the route bounds), metrics, harsh-event
 * summary and the certificate hash. Uses window.print()-friendly markup with
 * inlined styles so it needs no shared CSS.
 */
async function openPrintableReport(id) {
  const w = window.open("", "_blank");
  if (!w) return; // popup blocked — nothing else we can do
  w.document.write(`<!doctype html><meta charset="utf-8"><title>Drive report</title><body style="font-family:Helvetica,Arial,sans-serif;padding:40px;color:#181B20;"><p>Preparing drive report…</p></body>`);
  w.document.close();

  const locations = await safe(cached("locations", () => data.locations()), []);
  let detail;
  try {
    detail = await data.drive(id);
  } catch (e) {
    w.document.body.innerHTML = `<p style="color:#D6453D;">Couldn't load this drive: ${esc(e.message)}</p>`;
    return;
  }
  if (!detail || detail.error) {
    w.document.body.innerHTML = `<p style="color:#D6453D;">${esc(detail?.error || "Drive not found")}</p>`;
    return;
  }
  const d = detail.drive;
  const path = (detail.path || []).filter((p) => p.lat != null && p.lon != null);
  let cert = null;
  try { cert = await data.driveCertificate(id); } catch { /* cert optional */ }

  const startName = driveEndpoint(d, "start", locations);
  const endName = driveEndpoint(d, "end", locations);
  // Static route image: an SVG polyline of the path, normalized to a fixed box.
  const routeSvg = staticRouteSvg(path, 640, 300);
  const row = (label, value) => `<tr><td style="padding:6px 14px 6px 0;color:#5F6670;font-size:12px;">${esc(label)}</td><td style="padding:6px 0;font-family:'IBM Plex Mono',monospace;font-size:13px;font-weight:600;">${value}</td></tr>`;
  const conf = d.score_confidence ? (CONFIDENCE_LABEL[d.score_confidence] || d.score_confidence) : null;

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Drive report · ${esc(startName)} → ${esc(endName)}</title>
  <style>
    @media print { .noprint { display:none !important; } body { padding: 0; } }
    body { font-family: Helvetica, Arial, sans-serif; color:#181B20; padding:40px; max-width:760px; margin:0 auto; line-height:1.5; }
    h1 { font-size:20px; margin:0 0 2px; }
    .sub { color:#5F6670; font-size:13px; margin-bottom:22px; }
    .sec { font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:#98A0AA; font-weight:700; margin:26px 0 10px; }
    table { border-collapse:collapse; width:100%; }
    .metrics td:first-child { width:40%; }
    .cert { background:#F5F6F8; border:1px solid rgba(18,24,38,0.09); border-radius:8px; padding:14px; font-family:'IBM Plex Mono',monospace; font-size:11px; white-space:pre-wrap; word-break:break-all; }
    .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; background:#EDEFF2; color:#5F6670; }
    .foot { margin-top:30px; padding-top:14px; border-top:1px solid rgba(18,24,38,0.09); font-size:11px; color:#98A0AA; }
    button { font:inherit; padding:8px 16px; border-radius:8px; border:1px solid rgba(18,24,38,0.2); background:#2E62E8; color:#fff; cursor:pointer; }
  </style></head><body>
  <div class="noprint" style="margin-bottom:20px;"><button onclick="window.print()">🖨 Print / Save as PDF</button></div>
  <h1>Drive incident report</h1>
  <div class="sub">${esc(startName)} → ${esc(endName)} · ${esc(fmtDateTime(d.start_ts))}${d.driver ? " · driver: " + esc(d.driver) : ""}</div>

  <div class="sec">Route</div>
  ${routeSvg || `<div style="color:#98A0AA;font-size:13px;">No GPS path recorded for this drive.</div>`}

  <div class="sec">Trip metrics</div>
  <table class="metrics">
    ${row("Distance", `${d.distance_km != null ? fmt1(d.distance_km) : "—"} km`)}
    ${row("Duration", fmtDurationMin(d.duration_min))}
    ${row("Avg · top speed", `${d.avg_speed != null ? fmt0(d.avg_speed) : "—"} · ${d.max_speed != null ? fmt0(d.max_speed) : "—"} km/h`)}
    ${row("Consumption", `${d.efficiency_wh_km != null ? fmt0(d.efficiency_wh_km) : "—"} Wh/km`)}
    ${row("Energy used", `${d.energy_used_kwh != null ? fmt2(d.energy_used_kwh) : "—"} kWh`)}
    ${row("Battery", `${d.start_soc != null && d.end_soc != null ? `${d.start_soc} → ${d.end_soc}` : "—"} %`)}
  </table>

  <div class="sec">Risk summary</div>
  <table class="metrics">
    ${row("Safety score", `${d.behavior_score != null ? d.behavior_score : "—"}${d.score_low != null && d.score_high != null ? ` (band ${d.score_low}–${d.score_high})` : ""}${conf ? ` · ${esc(conf)}` : ""}`)}
    ${row("Harsh brakes · accels", `${d.harsh_brake_count ?? 0} · ${d.harsh_accel_count ?? 0}`)}
    ${row("Peak braking", `${d.max_decel_ms2 != null ? fmt2(d.max_decel_ms2 / 9.81) + " g" : "—"}`)}
    ${row("Over-limit severity", `${d.over_limit_severity != null ? "+" + fmt1(d.over_limit_severity) + " km/h avg" : "—"}`)}
    ${row("Speeding · night", `${d.over_limit_frac != null ? fmt0(d.over_limit_frac * 100) : "—"} · ${d.night_frac != null ? fmt0(d.night_frac * 100) : "—"} %`)}
  </table>
  ${d.coach_note ? `<p style="margin-top:12px;"><span class="badge">Coach</span> ${esc(d.coach_note)}</p>` : ""}

  ${cert && !cert.error ? `
  <div class="sec">Tamper-evident certificate</div>
  <div class="cert">algorithm: ${esc(cert.algorithm || "—")}
issued: ${cert.issued_ts != null ? esc(fmtDateTime(cert.issued_ts)) : "—"}
signature: ${esc(cert.signature_hex || "—")}${cert.verify_url ? `
verify: ${esc(cert.verify_url)}` : ""}</div>` : ""}

  <div class="foot">Generated by the Tesla dashboard · VIN ${esc(vin().slice(-6))} · ${new Date().toLocaleString()}. ${esc(DRIVER_MANUAL_NOTE)}</div>
  </body></html>`;

  w.document.open();
  w.document.write(html);
  w.document.close();
}

/** Fixed-box SVG polyline of a lat/lon path — a static route thumbnail for the print report. */
function staticRouteSvg(path, w, h) {
  const pts = path.filter((p) => p.lat != null && p.lon != null);
  if (pts.length < 2) return "";
  const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const pad = 20;
  // Equirectangular-ish projection is fine at this scale; keep aspect sane.
  const spanLat = (maxLat - minLat) || 1e-6, spanLon = (maxLon - minLon) || 1e-6;
  const X = (lon) => pad + ((lon - minLon) / spanLon) * (w - 2 * pad);
  const Y = (lat) => pad + (1 - (lat - minLat) / spanLat) * (h - 2 * pad);
  const poly = pts.map((p) => `${X(p.lon).toFixed(1)},${Y(p.lat).toFixed(1)}`).join(" ");
  const first = pts[0], last = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" style="border:1px solid rgba(18,24,38,0.12);border-radius:8px;background:#F5F6F8;">
    <polyline points="${poly}" style="fill:none;stroke:#2E62E8;stroke-width:3;stroke-linejoin:round;stroke-linecap:round;"></polyline>
    <circle cx="${X(first.lon).toFixed(1)}" cy="${Y(first.lat).toFixed(1)}" r="6" style="fill:#fff;stroke:#2E62E8;stroke-width:3;"></circle>
    <circle cx="${X(last.lon).toFixed(1)}" cy="${Y(last.lat).toFixed(1)}" r="6" style="fill:#2E62E8;stroke:#fff;stroke-width:2;"></circle>
  </svg>`;
}

// ===========================================================================
// FRONTIER 3 — Ask Tessa (natural-language Q&A over the car's data)
// ===========================================================================

const ASK_SUGGESTIONS = [
  "How efficient was I this month?",
  "Is my battery healthy?",
  "Who drives the most?",
  "What's my longest drive?",
];

async function renderAskTessa() {
  setContent(askTessaHtml());
  scrollAskToBottom();
  const input = document.getElementById("tm-ask-input");
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askSubmit(); }
    });
    // Don't steal focus on mobile (would pop the keyboard on every nav), but do on desktop.
    if (window.matchMedia("(min-width: 761px)").matches) input.focus();
  }
}

function askTessaHtml() {
  const t = state.askTranscript;
  const empty = t.length === 0;
  return `
    <div class="tm-ask-wrap">
      <div class="tm-card tm-ask-card">
        <div class="tm-ask-scroll" id="tm-ask-scroll">
          ${empty ? `
          <div class="tm-ask-intro">
            <div class="tm-ask-intro-icon">✦</div>
            <div class="tm-ask-intro-title">Ask Tessa anything about your car</div>
            <div class="tm-ask-intro-sub">Natural-language answers over your drives, charges, battery health and driver scores. Answers are generated live and aren't stored.</div>
            <div class="tm-ask-suggest-row">
              ${ASK_SUGGESTIONS.map((q) => `<button class="tm-chip-btn" data-action="ask-suggest" data-q="${esc(q)}">${esc(q)}</button>`).join("")}
            </div>
          </div>` : t.map((m) => askMessageHtml(m)).join("")}
          ${state.askPending ? askPendingHtml() : ""}
        </div>
        <div class="tm-ask-inputbar">
          <input id="tm-ask-input" class="tm-ask-input" type="text" autocomplete="off" placeholder="Ask about efficiency, battery, drivers…" ${state.askPending ? "disabled" : ""}>
          <button class="tm-ask-send" data-action="ask-send" ${state.askPending ? "disabled" : ""} aria-label="Send">↑</button>
        </div>
      </div>
    </div>`;
}

function askMessageHtml(m) {
  if (m.role === "user") {
    return `<div class="tm-ask-msg tm-ask-user"><div class="tm-ask-bubble">${esc(m.text)}</div></div>`;
  }
  if (m.role === "error") {
    return `<div class="tm-ask-msg tm-ask-tessa"><div class="tm-ask-bubble tm-ask-bubble-error">${esc(m.text)}</div></div>`;
  }
  // assistant
  const tools = (m.tools_used || []).map((t) => `<span class="tm-ask-toolchip">via ${esc(t)}</span>`).join("");
  const detail = m.data ? askDataDetailHtml(m.data) : "";
  return `<div class="tm-ask-msg tm-ask-tessa">
    <div class="tm-ask-bubble">${esc(m.text)}</div>
    ${m.note ? `<div class="tm-ask-note">${esc(m.note)}</div>` : ""}
    ${detail}
    ${tools ? `<div class="tm-ask-tools">${tools}</div>` : ""}
  </div>`;
}

/** Compact key/value view of the answer's structured `data` payload (best-effort). */
function askDataDetailHtml(dataObj) {
  if (dataObj == null || typeof dataObj !== "object") return "";
  const entries = Object.entries(dataObj).filter(([, v]) => v != null && typeof v !== "object").slice(0, 8);
  if (!entries.length) return "";
  return `<details class="tm-ask-data"><summary>data</summary><div class="tm-ask-data-grid">${entries
    .map(([k, v]) => `<div class="tm-ask-data-k">${esc(k)}</div><div class="tm-ask-data-v tm-mono">${esc(typeof v === "number" ? (Number.isInteger(v) ? v : fmt2(v)) : v)}</div>`)
    .join("")}</div></details>`;
}

function askPendingHtml() {
  return `<div class="tm-ask-msg tm-ask-tessa"><div class="tm-ask-bubble tm-ask-typing"><span></span><span></span><span></span></div></div>`;
}

function scrollAskToBottom() {
  const el = document.getElementById("tm-ask-scroll");
  if (el) el.scrollTop = el.scrollHeight;
}

/** Send a question to /ai/ask, appending both the question and the answer to the in-memory transcript. */
async function askSubmit(preset) {
  if (state.askPending) return;
  const input = document.getElementById("tm-ask-input");
  const question = (preset ?? (input ? input.value : "")).trim();
  if (!question) return;
  if (input) input.value = "";
  state.askTranscript.push({ role: "user", text: question });
  state.askPending = true;
  setContent(askTessaHtml());
  scrollAskToBottom();

  try {
    const res = await data.ask(question, vin());
    state.askPending = false;
    state.askTranscript.push({
      role: "assistant",
      text: res?.answer || "(no answer returned)",
      tools_used: res?.tools_used || [],
      data: res?.data ?? null,
      note: res?.note || null,
    });
  } catch (e) {
    state.askPending = false;
    const warming = !(e instanceof ApiError) || e.status === 404 || e.status === 500 || e.status === 501 || e.status === 502 || e.status === 503;
    state.askTranscript.push({
      role: "error",
      text: warming
        ? "Ask Tessa is warming up or unavailable right now — the AI endpoint isn't reachable. This usually means it hasn't been deployed on the worker yet, or it timed out. Try again in a moment."
        : "Couldn't get an answer: " + e.message,
    });
  }
  // Only repaint if we're still on the Ask screen (user may have navigated away).
  if (state.screen === "ask") {
    setContent(askTessaHtml());
    scrollAskToBottom();
    const el = document.getElementById("tm-ask-input");
    if (el && window.matchMedia("(min-width: 761px)").matches) el.focus();
  }
}

// ===========================================================================
// FRONTIER 2 — Predictions (battery forecast + range predictor)
// ===========================================================================

async function renderPredictions() {
  const [forecast, rangeModel, roster] = await Promise.all([
    safe(cached("battery_forecast", () => data.batteryForecast(vin())), null),
    safe(cached("predict_range_model", () => data.predictRange({ vin: vin() })), null),
    loadDriverRoster(),
  ]);

  setContent(`
    <div class="tm-grid-2">
      ${batteryForecastCard(forecast)}
      ${rangePredictorCard(rangeModel, roster)}
    </div>
  `);

  // Render the projected-% line chart into its placeholder (chart primitive needs the DOM node).
  const chartEl = document.getElementById("tm-forecast-chart");
  if (chartEl && forecast?.projected_pct?.length > 1) {
    const pts = forecast.projected_pct
      .filter((p) => p.pct != null && p.year != null)
      .map((p) => [p.year, p.pct]);
    if (pts.length > 1) {
      chartEl.innerHTML = svgLineChart({
        series: [{ points: pts, area: true }],
        yTicks: autoTicks(pts.map((p) => p[1]), 4),
        xTicks: pts.map((p) => ({ value: p[0], label: String(p[0]) })),
      });
    }
  }
}

/** Battery forecast card: health %, degradation slope + r², warranty-cliff timeline, projected-% chart. */
function batteryForecastCard(f) {
  if (!f || f.current_pct == null) {
    return `<div class="tm-card tm-card-pad">
      <div style="font-size:14px;font-weight:600;margin-bottom:4px;">Battery forecast</div>
      <div class="tm-empty">${esc(f?.note || "Not enough data yet — the degradation forecast needs a run of charge sessions before it can project a slope. Check back once more charges are logged, or once the forecast endpoint is deployed.")}</div>
    </div>`;
  }
  const slope = f.slope_pct_per_year;
  const r2 = f.r2;
  const cliff = f.cliff || {};
  const warranty = f.warranty || {};
  const yearsRemaining = cliff.years_remaining;
  const binding = cliff.binding; // "time" | "odometer" | "none"

  return `
    <div class="tm-card tm-card-pad tm-flex-col">
      <div class="tm-flex-row" style="align-items:baseline;">
        <div style="font-size:14px;font-weight:600;">Battery forecast</div>
        <div style="font-size:12px;color:var(--faint);margin-left:auto;">${f.samples != null ? `${f.samples} samples` : ""}</div>
      </div>
      <div class="tm-grid-half" style="gap:14px;">
        <div class="tm-card tm-card-pad-metric" style="background:var(--bg);">
          <div class="tm-stat-label">Current health</div>
          <div class="tm-stat-value">${fmt1(f.current_pct)} <span class="tm-stat-unit">%</span></div>
        </div>
        <div class="tm-card tm-card-pad-metric" style="background:var(--bg);">
          <div class="tm-stat-label">Degradation</div>
          <div class="tm-stat-value">${slope != null ? (slope > 0 ? "−" : "+") + fmt2(Math.abs(slope)) : "—"} <span class="tm-stat-unit">%/yr</span></div>
          <div class="tm-stat-note">${r2 != null ? `r² ${fmt2(r2)}` : "fit quality n/a"}${f.km_per_year != null ? ` · ${fmt0(f.km_per_year)} km/yr` : ""}</div>
        </div>
      </div>
      ${warrantyCliffHtml(cliff, warranty, yearsRemaining, binding)}
      <div>
        <div class="tm-flex-row" style="align-items:baseline;margin-bottom:10px;">
          <div style="font-size:12.5px;font-weight:600;color:var(--sub);">Projected health</div>
          <div style="font-size:11.5px;color:var(--faint);margin-left:auto;">% vs year</div>
        </div>
        <div id="tm-forecast-chart">${f.projected_pct?.length > 1 ? "" : `<div class="tm-empty" style="padding:24px;">No projection points yet</div>`}</div>
      </div>
      ${f.note ? `<div class="tm-stat-note">${esc(f.note)}</div>` : ""}
    </div>`;
}

/** Horizontal warranty-cliff timeline/gauge — years remaining + which cap (time vs odometer) binds first. */
function warrantyCliffHtml(cliff, warranty, yearsRemaining, binding) {
  const warrantyYears = warranty.years;
  const floorPct = warranty.floor_pct;
  // Position the "now" marker on a 0..warrantyYears track; the cliff sits at yearsRemaining.
  const span = warrantyYears || (yearsRemaining != null ? Math.max(yearsRemaining * 1.2, 1) : 8);
  const cliffFrac = yearsRemaining != null ? Math.max(0, Math.min(1, yearsRemaining / span)) : null;
  const bindLabel = binding === "time" ? "time cap (age)" : binding === "odometer" ? "mileage cap (km)" : binding === "none" ? "no cap reached in horizon" : null;
  const color = yearsRemaining == null ? "var(--faint)" : yearsRemaining < 1 ? "var(--bad)" : yearsRemaining < 3 ? "var(--warn)" : "var(--good)";

  return `
    <div class="tm-cliff">
      <div class="tm-flex-row" style="align-items:baseline;">
        <div style="font-size:12.5px;font-weight:600;color:var(--sub);">Warranty cliff</div>
        <div style="font-size:11.5px;color:var(--faint);margin-left:auto;">${warrantyYears != null && warranty.km != null ? `${warrantyYears} yr / ${fmt0(warranty.km)} km${floorPct != null ? ` · floor ${floorPct}%` : ""}` : "warranty terms n/a"}</div>
      </div>
      <div class="tm-cliff-track">
        <div class="tm-cliff-fill" style="width:${cliffFrac != null ? (cliffFrac * 100).toFixed(1) : 0}%;background:${color};"></div>
        ${cliffFrac != null ? `<div class="tm-cliff-marker" style="left:${(cliffFrac * 100).toFixed(1)}%;"></div>` : ""}
      </div>
      <div class="tm-flex-row" style="justify-content:space-between;margin-top:6px;">
        <div class="tm-stat-value" style="font-size:18px;color:${color};">${yearsRemaining != null ? fmt1(yearsRemaining) + " yr" : "—"} <span class="tm-stat-unit" style="font-size:12px;">to cliff</span></div>
        ${bindLabel ? `<div class="tm-stat-note" style="margin-top:0;align-self:flex-end;">binds on ${esc(bindLabel)}${cliff.time_floor_date && binding === "time" ? ` · ${esc(cliff.time_floor_date)}` : ""}${cliff.odo_floor_date && binding === "odometer" ? ` · ${esc(cliff.odo_floor_date)}` : ""}</div>` : ""}
      </div>
    </div>`;
}

/** Range predictor card: a small form → data.predictRange(...) → predicted Wh/km, kWh, SoC used. */
function rangePredictorCard(model, roster) {
  const m = model?.model || null;
  const ready = model?.ready !== false && (m ? (m.n ?? 0) > 0 : false);
  const trust = m ? `model r² ${m.r2 != null ? fmt2(m.r2) : "—"} · n=${m.n ?? "—"}` : null;
  const names = [...new Set(roster.map(rosterName).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  return `
    <div class="tm-card tm-card-pad tm-flex-col">
      <div class="tm-flex-row" style="align-items:baseline;">
        <div style="font-size:14px;font-weight:600;">Range predictor</div>
        <div style="font-size:12px;color:var(--faint);margin-left:auto;">${trust ? esc(trust) : "trained on your drives"}</div>
      </div>
      ${model && !ready ? `<div class="tm-empty" style="padding:20px;">${esc(model?.note || "Not enough data yet — the range model needs more completed drives before it can predict. Keep driving (and logging) and this fills in.")}</div>` : ""}
      ${!model ? `<div class="tm-empty" style="padding:20px;">The range-prediction endpoint isn't available on this worker yet — it hasn't been deployed. Once it is, enter a trip below to estimate energy use.</div>` : ""}
      <div class="tm-predict-form" style="${model && !ready ? "opacity:0.5;" : ""}">
        <div class="tm-predict-grid">
          <label class="tm-predict-field"><span>Distance (km)</span><input id="tm-pr-distance" class="tm-gate-input" type="number" inputmode="decimal" min="0" step="1" placeholder="e.g. 120"></label>
          <label class="tm-predict-field"><span>Temp (°C)</span><input id="tm-pr-temp" class="tm-gate-input" type="number" inputmode="decimal" step="1" placeholder="e.g. 18"></label>
          <label class="tm-predict-field"><span>Elevation gain (m)</span><input id="tm-pr-elev" class="tm-gate-input" type="number" inputmode="decimal" min="0" step="10" placeholder="optional"></label>
          <label class="tm-predict-field"><span>Driver</span>
            <select id="tm-pr-driver" class="tm-gate-input">
              <option value="">Any</option>
              ${names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("")}
            </select>
          </label>
        </div>
        <button class="tm-gate-btn" style="width:auto;padding:9px 18px;margin-top:4px;" data-action="predict-run">Predict</button>
      </div>
      <div id="tm-predict-result"></div>
    </div>`;
}

/** Read the range-predictor form, call data.predictRange, render the result inline. */
async function runRangePrediction() {
  const target = document.getElementById("tm-predict-result");
  if (!target) return;
  const distEl = document.getElementById("tm-pr-distance");
  const distance_km = distEl && distEl.value !== "" ? Number(distEl.value) : null;
  if (distance_km == null || Number.isNaN(distance_km) || distance_km <= 0) {
    target.innerHTML = `<div class="tm-stat-note" style="color:var(--warn);">Enter a distance in km to predict.</div>`;
    return;
  }
  const tempEl = document.getElementById("tm-pr-temp");
  const elevEl = document.getElementById("tm-pr-elev");
  const driverEl = document.getElementById("tm-pr-driver");
  const params = {
    vin: vin(),
    distance_km,
    temp_c: tempEl && tempEl.value !== "" ? Number(tempEl.value) : undefined,
    elevation_gain_m: elevEl && elevEl.value !== "" ? Number(elevEl.value) : undefined,
    driver: driverEl && driverEl.value ? driverEl.value : undefined,
  };
  target.innerHTML = `<div class="tm-flex-row" style="gap:8px;color:var(--sub);font-size:12.5px;margin-top:8px;"><div class="tm-spinner" style="width:16px;height:16px;border-width:2px;"></div>Predicting…</div>`;

  let res;
  try {
    res = await data.predictRange(params);
  } catch (e) {
    const unavailable = !(e instanceof ApiError) || [400, 404, 501].includes(e.status);
    target.innerHTML = `<div class="tm-stat-note" style="color:var(--faint);margin-top:8px;">${unavailable
      ? "The range-prediction endpoint isn't deployed on this worker yet."
      : "Couldn't predict: " + esc(e.message)}</div>`;
    return;
  }
  if (!res || res.error || res.predicted_wh_km == null) {
    target.innerHTML = `<div class="tm-stat-note" style="color:var(--faint);margin-top:8px;">${esc(res?.note || res?.error || "No prediction returned — the model may not be ready.")}</div>`;
    return;
  }
  const m = res.model || {};
  target.innerHTML = `
    <div class="tm-predict-result">
      <div class="tm-grid-metrics" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));">
        <div><div class="tm-readout-label">Consumption</div><div class="tm-readout-value">${fmt0(res.predicted_wh_km)} <span style="font-size:11px;color:var(--sub);">Wh/km</span></div></div>
        <div><div class="tm-readout-label">Energy</div><div class="tm-readout-value">${fmt1(res.predicted_kwh)} <span style="font-size:11px;color:var(--sub);">kWh</span></div></div>
        <div><div class="tm-readout-label">SoC used</div><div class="tm-readout-value">${fmt1(res.predicted_soc_used_pct)} <span style="font-size:11px;color:var(--sub);">%</span></div></div>
      </div>
      ${res.arrival_note ? `<div class="tm-stat-note" style="margin-top:10px;">${esc(res.arrival_note)}</div>` : ""}
      <div class="tm-stat-note">${m.r2 != null ? `model r² ${fmt2(m.r2)}` : ""}${m.n != null ? ` · trained on ${m.n} drives` : ""}${res.note ? ` · ${esc(res.note)}` : ""}</div>
    </div>`;
}

// ---------------------------------------------------------------------------

boot();
