import { auth, data, mcp, verifyToken, exportUrl, ApiError } from "./api.js";
import { svgLineChart, svgBarChart, svgDonut, svgSplitBar, svgDriveChart } from "./charts.js";
import { destroyMaps, renderPointMap, renderRouteMap, renderLifetimeMap, createReplayMarker, invalidateMaps } from "./map.js";

// Bump on every change to this dashboard (UI, features, or the /data/*
// endpoints it depends on) and add a matching entry to CHANGELOG.md — see
// the versioning policy in the repo's CLAUDE.md. Shown in the sidebar footer.
const APP_VERSION = "1.10.0";

const root = document.getElementById("app");
let shellBound = false; // guards one-time attach of the root click handler + sync timer

// PWA: network-first app shell via sw.js (see sw.js). Progressive enhancement
// only — the try/catch means an environment without service workers never
// breaks the app. When an updated worker takes control, reload ONCE so the new
// build is shown immediately (guarded so it fires only on a real update, never
// on first install).
try {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => { /* e.g. file://, private mode */ });
    let reloadedForUpdate = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadedForUpdate || !navigator.serviceWorker.controller) return;
      reloadedForUpdate = true;
      location.reload();
    });
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
/** m:ss / h:mm:ss clock for the drive-replay playhead readout. */
function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? `${h}:` : "") + `${mm}:${String(s).padStart(2, "0")}`;
}
/** Great-circle distance (km) between two {lat, lon} points — for drive-replay odometry. */
function haversineKm(a, b) {
  const R = 6371, toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
/** Linear interpolation over a sorted [ts, value] series (binary search). */
function interpAt(series, ts) {
  if (!series || !series.length) return null;
  if (ts <= series[0][0]) return series[0][1];
  if (ts >= series[series.length - 1][0]) return series[series.length - 1][1];
  let lo = 0, hi = series.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (series[m][0] <= ts) lo = m; else hi = m; }
  const a = series[lo], b = series[hi], f = (ts - a[0]) / ((b[0] - a[0]) || 1);
  return a[1] + (b[1] - a[1]) * f;
}
/** Interpolate a {lat, lon} position over a sorted-by-ts posPts array. */
function interpPos(posPts, ts) {
  if (!posPts.length) return null;
  if (ts <= posPts[0].ts) return posPts[0];
  if (ts >= posPts[posPts.length - 1].ts) return posPts[posPts.length - 1];
  let lo = 0, hi = posPts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (posPts[m].ts <= ts) lo = m; else hi = m; }
  const a = posPts[lo], b = posPts[hi], f = (ts - a.ts) / ((b.ts - a.ts) || 1);
  return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
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
  theme: localStorage.getItem("tm_theme") || ((window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light"),
  vehicle: null, // { vin, display_name, state }
  vehicleData: null, // last on-demand get_vehicle_data snapshot
  driveFilter: 1, // 0=7d, 1=30d, 2=all
  batteryTimelineRange: 0, // index into BATTERY_TIMELINE_RANGES (Battery timeline screen)
  tfCat: "__all", // Telemetry-fields screen: active category chip
  tfQuery: "", // Telemetry-fields screen: search text
  driverFilter: "__all", // "__all" | "__none" (unassigned) | driver name
  mediaDriverFilter: null, // selected driver chip on the Media screen's per-driver breakdown
  openDriveId: null,
  openChargeId: null,
  openPlaceId: null,
  editingPlaceTags: false, // place-detail: driver-tag chip editor open/closed
  renderedScreen: null, // last screen whose content actually painted (skeleton vs refresh-in-place)
  syncing: false,
  lastSync: null,
  apiBudget: null, // Tesla API spend snapshot, surfaced in the sidebar
  connStatus: undefined, // sidebar connection badge: undefined = not fetched yet (optimistic green), null = no data ever, number = last_seen_ts
  placeSearch: { suggestions: [], roster: [], results: null, selected: null, error: null }, // "Add a place" modal state
  cache: {}, // per-screen fetched payloads, cleared on manual refresh
  askTranscript: [], // Ask-Tessa chat history — in-memory only, never persisted
  askPending: false, // true while an /ai/ask request is in flight
};

const NAV = [
  { label: "", items: [["ask", "✦ Ask Tessa"], ["ov", "Overview"], ["tl", "Timeline"], ["st", "Statistics"]] },
  { label: "Driving", items: [["dr", "Drives"], ["dv", "Drivers"], ["pl", "Places"], ["map", "Lifetime map"]] },
  { label: "Media", items: [["md", "♪ Media"]] },
  { label: "Charging", items: [["ch", "Charges"], ["cs", "Charging stats"]] },
  { label: "Battery", items: [["bh", "Battery health"], ["pr", "Predictions"], ["vd", "Vampire drain"]] },
  { label: "Data", items: [["tf", "Telemetry fields"]] },
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
  md: ["Media", "most played, from the car's infotainment system"],
  ch: ["Charges", ""],
  cs: ["Charging stats", "lifetime"],
  bh: ["Battery health", ""],
  pr: ["Predictions", "battery forecast & range predictor"],
  vd: ["Vampire drain", "standby losses"],
  bt: ["Battery timeline", "state of charge over time, with stages"],
  tf: ["Telemetry fields", "every attribute Tesla can stream, and what this car is sending"],
  api: ["API usage", "Tesla Fleet API call log & cost — click the sidebar widget to get here"],
  cl: ["Changelog", "what's shipped, version by version — click the version number to get here"],
};

const EVENT_COLOR = { drive: "var(--accent)", charge: "var(--good)", sleep: "var(--faint)", update: "#8A63D2" };
// vehicle_states vocabulary (see tracking.ts timelineState/recordConnectivityState) → Overview's "Status" readout.
const STATUS_LABEL = { driving: "Driving", charging: "Charging", updating: "Updating", online: "Parked", asleep: "Asleep", offline: "Offline" };

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

// ---------------------------------------------------------------------------
// URL routing — reflects state.screen (+ open drive/charge/place id) in
// location.hash as "#screen" or "#screen/id", so reload, bookmarks and the
// browser back/forward buttons land on the right screen instead of always
// dumping back to Overview. Navigation writes history via pushHistory();
// back/forward is read back through the popstate listener in renderShell().
// ---------------------------------------------------------------------------

function hashToState(hash) {
  const raw = (hash || "").replace(/^#\/?/, "");
  if (!raw) return null;
  const [screen, idStr] = raw.split("/");
  if (!TITLES[screen]) return null;
  const id = idStr ? Number(idStr) : null;
  return { screen, id: Number.isFinite(id) ? id : null };
}
function stateToHash() {
  if (state.screen === "dr" && state.openDriveId != null) return `#dr/${state.openDriveId}`;
  if (state.screen === "ch" && state.openChargeId != null) return `#ch/${state.openChargeId}`;
  if (state.screen === "pl" && state.openPlaceId != null) return `#pl/${state.openPlaceId}`;
  return `#${state.screen}`;
}
/** Call after any change to state.screen/openDriveId/openChargeId/openPlaceId. */
function pushHistory() {
  const hash = stateToHash();
  if (location.hash !== hash) { try { history.pushState(null, "", hash); } catch { /* sandboxed */ } }
}
/** Read location.hash into state at boot, or on a back/forward navigation. */
function applyHashToState() {
  const parsed = hashToState(location.hash);
  if (!parsed) return false;
  state.screen = parsed.screen;
  state.openDriveId = parsed.screen === "dr" ? parsed.id : null;
  state.openChargeId = parsed.screen === "ch" ? parsed.id : null;
  state.openPlaceId = parsed.screen === "pl" ? parsed.id : null;
  return true;
}

async function boot() {
  consumeUrlCredentials();
  if (!auth.hasToken || !auth.vin) return renderGate();
  applyHashToState(); // land on the screen encoded in the URL, if any
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
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", state.theme === "dark" ? "#0E0F12" : "#F5F6F8");
  const vd = state.vehicleData;
  // VIN position 4 encodes the model line — gives a real name ("Model 3") even
  // before a live vehicle_data read, instead of a generic "Vehicle".
  const vinModel = { S: "Model S", "3": "Model 3", X: "Model X", Y: "Model Y" }[(auth.vin || "")[3]] || "Vehicle";
  const carName = vd?.display_name || vinModel;
  const initial = "T";

  root.innerHTML = `
    <div data-tm-root="1" data-theme="${state.theme}">
      <aside class="tm-aside">
        <div class="tm-brand">
          <div class="tm-brand-badge">${esc(initial)}</div>
          <div style="min-width:0;">
            <div class="tm-brand-name tm-ellipsis">${esc(carName)}</div>
            <div class="tm-brand-status" id="tm-conn-status">${connStatusHtml(state.connStatus)}</div>
          </div>
        </div>
        ${NAV.map((g) => `
          <div class="tm-navgroup">
            ${g.label ? `<div class="tm-navlabel">${esc(g.label)}</div>` : ""}
            ${g.items.map(([key, label]) => `<button class="tm-navitem ${state.screen === key ? "active" : ""}" data-action="nav" data-screen="${key}">${esc(label)}</button>`).join("")}
          </div>`).join("")}
        <div class="tm-sidefoot">
          <div class="tm-sidebudget tm-sidebudget-click" id="tm-sidebudget" data-action="nav" data-screen="api" title="View API call log & cost">${sideBudgetHtml(state.apiBudget)}</div>
          <div class="tm-segment">
            <button class="tm-segbtn ${state.theme === "light" ? "active" : ""}" data-action="theme" data-theme="light">Light</button>
            <button class="tm-segbtn ${state.theme === "dark" ? "active" : ""}" data-action="theme" data-theme="dark">Dark</button>
          </div>
          <div class="tm-sidemeta">
            VIN ${esc(auth.vin.slice(-6))}
            &nbsp;·&nbsp;<button data-action="logout" class="tm-link-btn">disconnect</button>
          </div>
          <div class="tm-sidemeta tm-sidebudget-click" style="padding-top:0;" title="See changelog" data-action="nav" data-screen="cl">v${esc(APP_VERSION)}</div>
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
            <button data-action="refresh" title="Refresh" aria-label="Refresh" class="tm-icon-btn" style="margin-left:8px;">&#8635;</button>
          </div>
        </header>
        <div class="tm-scroll"><div class="tm-page" id="tm-content"></div></div>
      </main>
      <div id="tm-modal-root"></div>
    </div>`;

  // Bind once: renderShell re-runs on every navigation, but the click handler
  // and sync timer attach to `root` (not the replaced innerHTML), so re-binding
  // would stack duplicate handlers and timers.
  if (!shellBound) {
    root.addEventListener("click", onRootClick);
    setInterval(tickSyncLabel, 1000);
    document.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (closeModal()) return;
      const open = document.querySelectorAll(".tm-map-card.tm-map-full");
      if (!open.length) return;
      open.forEach((c) => { c.classList.remove("tm-map-full"); const b = c.querySelector(".tm-map-expand"); if (b) { b.innerHTML = "&#10530;"; b.title = "Expand map"; } });
      setTimeout(() => invalidateMaps(), 80);
    });
    window.addEventListener("popstate", () => {
      if (!applyHashToState()) return; // an unrelated/foreign hash — leave state as-is
      renderShell();
      showScreen();
    });
    shellBound = true;
  }
  // Normalize the address bar to the current screen on first paint, so a plain
  // load without a hash (or a stale/invalid one) still gets a matching, shareable URL.
  if (location.hash !== stateToHash()) { try { history.replaceState(null, "", stateToHash()); } catch { /* sandboxed */ } }
  refreshSideBudget();
  refreshConnStatus();
}

function tickSyncLabel() {
  if (state.syncing) return; // "syncing…" holds until the load settles
  const el = document.getElementById("tm-sync-text");
  if (el && state.lastSync) el.textContent = `synced ${agoLabel(state.lastSync)}`;
}

// ---------------------------------------------------------------------------
// Modal — a single reusable popup root (see #tm-modal-root in renderShell).
// Backdrop click or Escape closes it; clicking inside the card doesn't
// (the card carries data-action="modal-noop" so the delegated click handler's
// closest("[data-action]") stops there instead of bubbling to the backdrop).
// ---------------------------------------------------------------------------

function openModal(html) {
  const root = document.getElementById("tm-modal-root");
  if (!root) return;
  root.innerHTML = `
    <div class="tm-modal-backdrop" data-action="modal-close">
      <div class="tm-modal" data-action="modal-noop">${html}</div>
    </div>`;
}
/** Returns true if a modal was open (and is now closed) — lets the Escape handler know whether to also handle map-fullscreen. */
function closeModal() {
  const root = document.getElementById("tm-modal-root");
  if (!root || !root.innerHTML) return false;
  root.innerHTML = "";
  return true;
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
  if (action === "modal-noop") {
    return; // absorbs clicks on inert areas inside the modal card
  } else if (action === "modal-close") {
    closeModal();
    return;
  }
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
    pushHistory();
    renderShell();
    showScreen();
  } else if (action === "theme") {
    state.theme = t.dataset.theme;
    localStorage.setItem("tm_theme", state.theme);
    document.querySelector("[data-tm-root]")?.setAttribute("data-theme", state.theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", state.theme === "dark" ? "#0E0F12" : "#F5F6F8");
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
  } else if (action === "battery-timeline-range") {
    state.batteryTimelineRange = Number(t.dataset.range);
    renderBatteryTimeline();
  } else if (action === "tf-cat") {
    state.tfCat = t.dataset.cat;
    renderTelemetryFields();
  } else if (action === "ov-goto-climate") {
    document.getElementById("tm-ov-climate")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (action === "driver-other-toggle") {
    const other = document.getElementById("tm-driver-other");
    if (other) {
      const open = other.style.display !== "none";
      other.style.display = open ? "none" : "inline-flex";
      if (!open) document.getElementById("tm-driver-input")?.focus();
    }
  } else if (action === "driver-filter") {
    state.driverFilter = t.dataset.driver;
    renderDrives();
  } else if (action === "media-driver-filter") {
    state.mediaDriverFilter = t.dataset.driver;
    const byDriver = state.cache.media_by_driver;
    const target = document.getElementById("tm-media-by-driver");
    if (byDriver?.drivers && target) target.innerHTML = mediaByDriverHtml(byDriver.drivers);
  } else if (action === "edit-driver") {
    if (!t.querySelector(".tm-driver-edit")) beginDriverEdit(t, Number(t.dataset.id));
  } else if (action === "open-place") {
    state.openPlaceId = Number(t.dataset.id);
    state.editingPlaceTags = false;
    pushHistory();
    renderPlaceDetail();
  } else if (action === "back-places") {
    state.openPlaceId = null;
    state.editingPlaceTags = false;
    pushHistory();
    renderPlaces();
  } else if (action === "open-add-place") {
    openAddPlaceModal();
  } else if (action === "save-current-place") {
    const lat = Number(t.dataset.lat), lon = Number(t.dataset.lon);
    openAddPlaceModal({ label: t.dataset.label || "Current location", lat, lon });
  } else if (action === "place-search") {
    const input = document.getElementById("tm-place-search-input");
    const q = input ? input.value.trim() : "";
    if (!q) { input?.focus(); return; }
    t.disabled = true;
    t.textContent = "Searching…";
    data.geocode(q).then((res) => {
      state.placeSearch.results = res?.results || [];
      state.placeSearch.error = null;
      refreshAddPlaceModal();
    }).catch((e) => {
      state.placeSearch.results = null;
      state.placeSearch.error = e?.message || "Search failed";
      refreshAddPlaceModal();
    });
  } else if (action === "place-search-select") {
    const hit = state.placeSearch.results?.[Number(t.dataset.idx)];
    if (hit) {
      state.placeSearch.selected = hit;
      state.placeSearch.error = null;
      refreshAddPlaceModal();
    }
  } else if (action === "place-suggestion-select") {
    const s = state.placeSearch.suggestions?.[Number(t.dataset.idx)];
    if (s) {
      state.placeSearch.selected = { label: s.label || "Unnamed spot", lat: s.lat, lon: s.lon };
      state.placeSearch.error = null;
      refreshAddPlaceModal();
    }
  } else if (action === "place-search-clear") {
    state.placeSearch.selected = null;
    state.placeSearch.error = null;
    refreshAddPlaceModal();
  } else if (action === "toggle-driver-chip") {
    t.classList.toggle("active");
  } else if (action === "place-modal-save") {
    const input = document.getElementById("tm-place-modal-name");
    const name = input ? input.value.trim() : "";
    if (!name) { input?.focus(); return; }
    const lat = Number(t.dataset.lat), lon = Number(t.dataset.lon);
    const drivers = selectedDriverNames(t.closest(".tm-driver-tags-scope"));
    t.disabled = true;
    t.textContent = "Saving…";
    data.saveLocation({ name, lat, lon, drivers }).then(() => {
      delete state.cache.locations;
      delete state.cache.suggested_locations;
      closeModal();
      renderPlaces();
    }).catch((e) => {
      t.disabled = false;
      t.textContent = "Save";
      state.placeSearch.error = e?.message || "Save failed — unknown error";
      refreshAddPlaceModal();
    });
  } else if (action === "edit-place-tags") {
    state.editingPlaceTags = true;
    renderPlaceDetail();
  } else if (action === "cancel-place-tags") {
    state.editingPlaceTags = false;
    renderPlaceDetail();
  } else if (action === "save-place-tags") {
    const id = Number(t.dataset.id);
    const drivers = selectedDriverNames(t.closest(".tm-driver-tags-scope"));
    t.disabled = true;
    t.textContent = "Saving…";
    safe(data.locationStats(id), null).then((stats) => {
      if (!stats?.location) throw new Error("Couldn't reload this location");
      const l = stats.location;
      return data.saveLocation({ id, name: l.name, lat: l.lat, lon: l.lon, drivers });
    }).then(() => {
      delete state.cache.locations;
      state.editingPlaceTags = false;
      renderPlaceDetail();
    }).catch((e) => {
      t.disabled = false;
      t.textContent = "Save tags";
      alert(e?.message || "Save failed — unknown error");
    });
  } else if (action === "quick-assign") {
    // One-tap self-assign: reuses the same assign-driver write the manual
    // input/Save flow already uses, just skipping the typing.
    const id = Number(t.dataset.id);
    const name = t.dataset.driver || "";
    t.disabled = true;
    data.assignDriver(id, name).then(() => {
      delete state.cache.all_drives;
      delete state.cache.ov_recent;
      delete state.cache.tl_feed;
      showScreen();
    }).catch(() => {
      t.disabled = false;
      t.textContent = "Failed";
    });
  } else if (action === "open-drive") {
    // Opening a drive is a navigation into the Drives section — keep the left-nav
    // highlight + header in sync (the detail can be reached from Overview/Timeline too).
    state.openDriveId = Number(t.dataset.id);
    state.screen = "dr";
    pushHistory();
    renderShell();
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
    pushHistory();
    renderDrives();
  } else if (action === "open-charge") {
    state.openChargeId = Number(t.dataset.id);
    state.screen = "ch";
    pushHistory();
    renderShell();
    renderChargeDetail();
  } else if (action === "back-charges") {
    state.openChargeId = null;
    pushHistory();
    renderCharges();
  } else if (action === "goto-bh") {
    state.screen = "bh";
    pushHistory();
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
    const prevLabel = t.textContent;
    t.disabled = true;
    t.textContent = "Loading…";
    loadDriveCertificate(Number(t.dataset.id)).finally(() => { t.disabled = false; t.textContent = prevLabel; });
  } else if (action === "copy-cert") {
    copyToClipboard(t.dataset.text || "", t);
  } else if (action === "print-report") {
    const prevLabel = t.innerHTML;
    t.disabled = true;
    t.textContent = "Preparing…";
    openPrintableReport(Number(t.dataset.id))
      .then(() => { t.textContent = "Opened ✓"; })
      .catch(() => { t.textContent = "Couldn't open"; })
      .finally(() => { setTimeout(() => { t.disabled = false; t.innerHTML = prevLabel; }, 1300); });
  } else if (action === "map-expand") {
    const card = t.closest(".tm-map-card");
    if (card) {
      const full = card.classList.toggle("tm-map-full");
      t.innerHTML = full ? "&#10005;" : "&#10530;";
      t.title = full ? "Close map" : "Expand map";
      setTimeout(() => invalidateMaps(), 80);
    }
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
/** Whole-screen/whole-card empty state: icon badge + title + optional detail. */
function emptyHtml(title, sub) {
  return `<div class="tm-card"><div class="tm-empty"><div class="tm-empty-icon">–</div><div class="tm-empty-title">${esc(title)}</div>${sub ? `<div>${esc(sub)}</div>` : ""}</div></div>`;
}
function errorHtml(message) {
  return `<div class="tm-card"><div class="tm-empty"><div class="tm-empty-icon" style="color:var(--bad);">!</div><div class="tm-empty-title" style="color:var(--bad);">Couldn't load this</div><div>${esc(message)}</div></div></div>`;
}
/** Single-line empty note inside an already-titled card/chart (e.g. "No SoC history yet"). */
function miniEmptyHtml(text) {
  return `<div class="tm-mini-empty">${esc(text)}</div>`;
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
    case "md":
      return `<div class="tm-card tm-card-pad-lg tm-flex-row" style="gap:16px;">${skel("height:56px;width:56px;border-radius:10px;")}${skel("height:16px;width:40%;")}</div>${metrics}${table(8)}`;
    case "bh":
      return `<div class="tm-grid-3col"><div class="tm-card tm-card-pad-lg" style="display:flex;align-items:center;justify-content:center;">${skel("height:132px;width:132px;border-radius:50%;")}</div>${metric.repeat(2)}</div>${chart}`;
    case "bt":
      return `<div class="tm-flex-row" style="gap:8px;">${skel("height:30px;width:86px;border-radius:999px;").repeat(3)}</div>${chart}`;
    case "tf":
      return `<div class="tm-flex-row" style="gap:8px;flex-wrap:wrap;">${skel("height:30px;width:86px;border-radius:999px;").repeat(5)}</div>${table(14)}`;
    case "cs":
      return `${metrics}<div class="tm-grid-2">${chart}${chart}</div>`;
    case "vd":
      return `${metrics}${table(6)}`;
    case "api":
      return `${metrics}${table(10)}`;
    case "cl": {
      const clCard = `<div class="tm-card tm-card-pad">${skel("height:16px;width:110px;")}${skel("height:11px;width:160px;margin-top:8px;")}${skel("height:12px;margin-top:16px;")}${skel("height:12px;width:85%;margin-top:8px;")}${skel("height:12px;width:70%;margin-top:8px;")}</div>`;
      return `<div class="tm-flex-col" style="gap:16px;">${clCard.repeat(4)}</div>`;
    }
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
      case "md": await renderMedia(); break;
      case "ch": await renderCharges(); break;
      case "cs": await renderChargingStats(); break;
      case "bh": await renderBatteryHealth(); break;
      case "bt": await renderBatteryTimeline(); break;
      case "tf": await renderTelemetryFields(); break;
      case "pr": await renderPredictions(); break;
      case "vd": await renderVampireDrain(); break;
      case "api": await renderApiUsage(); break;
      case "cl": await renderChangelog(); break;
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

/** Month-end forecast line shared by budgetCard() and sideBudgetHtml(). */
function budgetForecastNote(b, compact) {
  const f = b.forecast;
  if (!f || f.method === "insufficient_data") return "";
  const overBudget = f.projected_over_budget === true;
  const warn = overBudget || f.budget_exhausted_in_days != null;
  const text = f.budget_exhausted_in_days != null
    ? `At this rate, runs out in ~${fmt1(f.budget_exhausted_in_days)} day${f.budget_exhausted_in_days === 1 ? "" : "s"} — before month-end`
    : overBudget
      ? `Projected ≈ $${fmt2(f.projected_month_usd)} by month-end — over the $${fmt0(b.poll_budget_usd)} cap`
      : `On track — projected ≈ $${fmt2(f.projected_month_usd)} by month-end`;
  return compact
    ? `<div style="font-size:10.5px;color:${warn ? "var(--warn)" : "var(--faint)"};margin-top:3px;">${esc(text)}</div>`
    : `<div class="tm-stat-note" style="${warn ? "color:var(--warn);" : ""}">${esc(text)}</div>`;
}

/** Compact Tesla API spend for the sidebar (calls + $ spend + a one-line forecast, above the theme toggle). */
function sideBudgetHtml(b) {
  if (!b || typeof b !== "object") return "";
  const cap = b.poll_budget_usd > 0 ? b.poll_budget_usd : null;
  const pct = cap ? Math.min(100, (b.spent_usd / cap) * 100) : 0;
  const atRisk = b.poll_allowed === false || b.forecast?.projected_over_budget === true || b.forecast?.budget_exhausted_in_days != null;
  const color = atRisk ? "var(--warn)" : "var(--good)";
  const calls = [b.reads, b.billed_reads, b.count, b.calls].find((v) => typeof v === "number");
  return `
    <div class="tm-sidebudget-top">
      <span>Tesla API${calls != null ? ` · ${fmt0(calls)} calls` : ""}</span>
      <span class="tm-mono">$${fmt2(b.spent_usd)}${cap ? ` <span style="color:var(--faint);">/ ${fmt0(cap)}</span>` : ""}</span>
    </div>
    ${cap ? `<div class="tm-sidebudget-bar"><div style="width:${pct.toFixed(1)}%;background:${color};"></div></div>` : ""}
    ${budgetForecastNote(b, true)}`;
}
function updateSideBudget(b) {
  if (b) state.apiBudget = b;
  const el = document.getElementById("tm-sidebudget");
  if (el) el.innerHTML = sideBudgetHtml(state.apiBudget);
}
async function refreshSideBudget() {
  if (!vin()) return;
  const s = await safe(cached("summary", () => data.summary(vin())), null);
  if (s?.api_budget) updateSideBudget(s.api_budget);
}

// ---------------------------------------------------------------------------
// Connection status (sidebar, top-left) — the ONE status-with-a-dot indicator
// in the app (previously duplicated by an Overview-local "Online/Reporting"
// pill, now removed). Optimistic by default (green) since the worker never
// auto-polls/auto-wakes — this reflects whether telemetry is actually
// flowing, not whether an on-demand live read has been done this session.
// Only flips off-green when data is genuinely missing or stale.
// ---------------------------------------------------------------------------

const STALE_AFTER_S = 6 * 3600; // beyond a typical idle/cron-throttled gap — likely actually broken, not just parked

/** `lastSeenTs` (unix seconds) or null/undefined for "not loaded yet" (optimistic default). */
function connStatusHtml(lastSeenTs) {
  let label = "Online", color = "var(--good)", live = true, title = "";
  if (lastSeenTs === null) {
    label = "No data yet"; color = "var(--faint)"; live = false;
  } else if (typeof lastSeenTs === "number") {
    const ageS = Math.floor(Date.now() / 1000) - lastSeenTs;
    if (ageS > STALE_AFTER_S) { label = "Stale"; color = "var(--warn)"; live = false; }
    title = `Last car data: ${fmtDateTime(lastSeenTs)} (${agoLabel(lastSeenTs * 1000)})`;
  }
  return `
    <span class="tm-dot ${live ? "tm-dot-live" : ""}" style="background:${color};"></span>
    <span title="${esc(title)}">${esc(label)}</span>`;
}
function updateConnStatus(lastSeenTs) {
  state.connStatus = lastSeenTs;
  const el = document.getElementById("tm-conn-status");
  if (el) el.innerHTML = connStatusHtml(lastSeenTs);
}
async function refreshConnStatus() {
  if (!vin()) return;
  const s = await safe(cached("summary", () => data.summary(vin())), null);
  updateConnStatus(s ? s.last_seen_ts ?? null : undefined);
}

// ---------------------------------------------------------------------------
// API usage — drill-down behind the sidebar spend widget
// ---------------------------------------------------------------------------

/**
 * Why the call log failed, as an actionable card — NOT the generic empty state.
 * A 404 here has one overwhelmingly likely cause: the deployed worker predates
 * the /data/budget-calls route (the dashboard ships via Pages on every merge,
 * the worker only ships when someone runs `npm run deploy`). Saying exactly
 * that is the difference between "it doesn't work" and knowing what to run.
 */
function callLogErrorHtml(err) {
  const status = err?.status;
  if (status === 404) {
    return `<div class="tm-card tm-card-pad">
      <div class="tm-empty-title" style="color:var(--warn);">Call log not available on the deployed worker</div>
      <div style="font-size:13px;color:var(--sub);margin-top:8px;line-height:1.55;">
        This screen reads <code>/data/budget-calls</code>, but the worker that's live right now answers 404 for it —
        the deployed worker is older than this feature, so it also isn't recording the per-call breakdown yet.
        The month total above still works (it uses an older endpoint).
      </div>
      <div style="font-size:13px;color:var(--sub);margin-top:8px;line-height:1.55;">
        Fix: redeploy the worker — <code>cd tesla-cf-mcp-worker &amp;&amp; npm run deploy</code>.
        The per-call log starts recording from the moment the new worker is live (spend before that stays visible only in the month total).
      </div>
    </div>`;
  }
  if (status === 401 || status === 403) {
    return `<div class="tm-card tm-card-pad">
      <div class="tm-empty-title" style="color:var(--warn);">Call log request was rejected (${status})</div>
      <div style="font-size:13px;color:var(--sub);margin-top:8px;">Your access token didn't authorize <code>/data/budget-calls</code> — try disconnecting and logging in again with a current token.</div>
    </div>`;
  }
  return `<div class="tm-card tm-card-pad">
    <div class="tm-empty-title" style="color:var(--warn);">Couldn't load the call log</div>
    <div style="font-size:13px;color:var(--sub);margin-top:8px;">${esc(err?.message || "Unknown error")} — the request to <code>/data/budget-calls</code> failed. Check the worker is reachable, then reload.</div>
  </div>`;
}

async function renderApiUsage() {
  // The call-log failure is kept (not swallowed to null) so the screen can say
  // WHY it's missing — a silent empty table here is exactly what made a real
  // budget overrun undiagnosable from the dashboard.
  const [summary, logRes] = await Promise.all([
    safe(cached("summary", () => data.summary(vin())), null),
    data.budgetCallLog(30).then((v) => ({ log: v }), (e) => ({ error: e })),
  ]);
  const b = summary?.api_budget ?? null;
  const log = logRes.log ?? null;

  if (!b && !log) {
    return setContent(`
      ${emptyHtml("No API spend recorded yet", "This fills in once the worker starts polling or streaming telemetry for your car.")}
      ${logRes.error ? callLogErrorHtml(logRes.error) : ""}`);
  }

  const f = b?.forecast ?? null;
  // Per-call accounting can start mid-month (it began with a worker deploy) —
  // when the table covers less spend than the month total, say so instead of
  // letting the numbers silently disagree.
  const earliestDay = log?.entries?.length ? log.entries[log.entries.length - 1].day : null;
  const accountingGap = b && log && b.spent_usd > (log.total_cost_usd ?? 0) + 0.05;
  setContent(`
    <div class="tm-grid-metrics">
      <div class="tm-card tm-card-pad-metric">
        <div class="tm-stat-label">Spent this month</div>
        <div class="tm-stat-value">$${b ? fmt2(b.spent_usd) : "—"} ${b ? `<span class="tm-stat-unit">/ $${fmt0(b.poll_budget_usd)}</span>` : ""}</div>
        ${b ? budgetForecastNote(b, false) : ""}
      </div>
      <div class="tm-card tm-card-pad-metric">
        <div class="tm-stat-label">Daily rate</div>
        <div class="tm-stat-value">${f?.daily_rate_usd != null ? "$" + fmt2(f.daily_rate_usd) : "—"} <span class="tm-stat-unit">/ day</span></div>
      </div>
      <div class="tm-card tm-card-pad-metric">
        <div class="tm-stat-label">Projected · month-end</div>
        <div class="tm-stat-value">${f?.projected_month_usd != null ? "$" + fmt2(f.projected_month_usd) : "—"}</div>
      </div>
      <div class="tm-card tm-card-pad-metric">
        <div class="tm-stat-label">Last ${log?.days ?? 30} days total</div>
        <div class="tm-stat-value">${log ? "$" + fmt2(log.total_cost_usd) : "—"}</div>
      </div>
    </div>
    ${logRes.error ? callLogErrorHtml(logRes.error) : ""}
    ${log?.by_kind?.length ? `
    <div class="tm-grid-metrics">
      ${log.by_kind.map((k) => `
        <div class="tm-card tm-card-pad-metric">
          <div class="tm-stat-label">${esc(k.label)}</div>
          <div class="tm-stat-value">$${fmt2(k.cost_usd)}</div>
          <div class="tm-stat-note">${fmt0(k.count)} call${k.count === 1 ? "" : "s"}</div>
        </div>`).join("")}
    </div>` : ""}
    ${log ? `
    <div class="tm-card tm-table-wrap">
      <div style="min-width:560px;">
        <div class="tm-table-head" style="grid-template-columns:120px 1fr 90px 90px;">
          <div>Day</div><div>Call kind</div><div class="tm-right">Count</div><div class="tm-right">Cost</div>
        </div>
        ${log.entries?.length ? log.entries.map((e) => `
          <div class="tm-table-row no-click" style="grid-template-columns:120px 1fr 90px 90px;">
            <div style="font-size:12.5px;color:var(--sub);">${esc(e.day)}</div>
            <div>${esc(e.label)}</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${fmt0(e.count)}</div>
            <div class="tm-right tm-mono">$${fmt2(e.cost_usd)}</div>
          </div>`).join("") : `<div class="tm-empty" style="padding:20px 22px;">No call log entries in this window yet.</div>`}
        ${accountingGap ? `<div class="tm-foot-note" style="color:var(--warn);">The rows above total $${fmt2(log.total_cost_usd)} but the month has spent $${fmt2(b.spent_usd)} — per-call accounting only began ${earliestDay ? `on ${esc(earliestDay)}` : "recently"} (with a worker deploy); spend before that is in the month total only.</div>` : ""}
        <div class="tm-foot-note">One row per day + call kind, not one row per call — reload this screen to see today's row grow. This is a cost summary, not a live call feed: the "synced Xs ago" you see elsewhere is the dashboard re-reading already-stored data (free), separate from the worker's own, much slower Tesla API poll cadence that this screen tracks.</div>
      </div>
    </div>` : ""}
  `);
}

/** Light inline-markdown rendering for changelog prose: `code`, **bold**, [text](url). Escapes first, so this is safe against the raw CHANGELOG.md text. */
function mdInline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
      const safeUrl = /^https?:\/\//i.test(url) ? esc(url) : "#";
      return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
}

/**
 * Parses CHANGELOG.md's known, consistent structure: `## X.Y.Z — YYYY-MM-DD`
 * headers, an optional intro paragraph, then `- ` bullets (which may wrap
 * onto indented continuation lines). Anything before the first `## ` header
 * (the title + versioning-policy blurb) is ignored — this screen is a
 * version timeline, not a copy of the whole file.
 */
function parseChangelog(md) {
  const lines = md.split("\n");
  const versions = [];
  let current = null;
  for (const line of lines) {
    const h = line.match(/^##\s+([\d.]+)\s+—\s+(\d{4}-\d{2}-\d{2})\s*$/);
    if (h) {
      current = { version: h[1], date: h[2], intro: [], bullets: [] };
      versions.push(current);
      continue;
    }
    if (!current) continue;
    const b = line.match(/^-\s+(.*)$/);
    if (b) {
      current.bullets.push(b[1]);
    } else if (/^\s+\S/.test(line) && current.bullets.length) {
      // Indented continuation of the previous bullet.
      current.bullets[current.bullets.length - 1] += " " + line.trim();
    } else if (line.trim()) {
      current.intro.push(line.trim());
    }
  }
  return versions;
}

async function renderChangelog() {
  let md;
  try {
    const resp = await fetch("./CHANGELOG.md");
    if (!resp.ok) throw new Error(`fetch failed (${resp.status})`);
    md = await resp.text();
  } catch (e) {
    return setContent(errorHtml(`Couldn't load the changelog: ${e.message || e}`));
  }
  const versions = parseChangelog(md);
  if (!versions.length) {
    return setContent(emptyHtml("No changelog entries found", "CHANGELOG.md didn't parse into any versions."));
  }
  setContent(`
    <div class="tm-flex-col" style="gap:16px;max-width:760px;">
      ${versions.map((v, i) => `
        <div class="tm-card tm-card-pad">
          <div class="tm-flex-row" style="justify-content:space-between;align-items:baseline;">
            <div style="font-size:16px;font-weight:600;">v${esc(v.version)}${i === 0 ? ' <span class="tm-badge tm-badge-ac" style="margin-left:6px;">current</span>' : ""}</div>
            <div style="font-size:12px;color:var(--faint);">${esc(v.date)}</div>
          </div>
          ${v.intro.length ? `<div style="margin-top:8px;color:var(--sub);font-size:13px;">${v.intro.map((p) => `<p>${mdInline(p)}</p>`).join("")}</div>` : ""}
          ${v.bullets.length ? `<ul class="tm-changelog-list">${v.bullets.map((b) => `<li>${mdInline(b)}</li>`).join("")}</ul>` : ""}
        </div>`).join("")}
    </div>
  `);
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
  const bal = t?.balance ?? null;
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
      ${bal ? `<div class="tm-stat-note" style="${bal.asymmetric ? "color:var(--warn);" : ""}">
        ${bal.asymmetric ? "Persistent side-to-side gap — " : "Well balanced — "}
        FL–FR ${bal.fl_fr_bar >= 0 ? "+" : ""}${bal.fl_fr_bar} · RL–RR ${bal.rl_rr_bar >= 0 ? "+" : ""}${bal.rl_rr_bar} bar avg (${bal.paired_samples} samples)
      </div>` : ""}
    </div>`;
}

/**
 * Compact tyre status for the Overview readout: a green check when all four
 * corners are present and within tolerance, otherwise the worst-offending
 * corner (label + PSI, or "no reading" when a sensor value is missing).
 */
function tyreStatusHtml(t) {
  const latest = t?.latest ?? null;
  const trend = t?.trend_bar_per_week ?? null;
  if (!latest) return `<span style="color:var(--faint);">—</span>`;
  const cells = WHEELS.map(([w, label]) => ({ w, label, v: typeof latest[w] === "number" ? latest[w] : null }));
  const nums = cells.filter((c) => c.v != null).map((c) => c.v);
  if (nums.length === 0) return `<span style="color:var(--faint);">—</span>`;
  let median = null;
  if (nums.length === 4) { const s = nums.slice().sort((a, b) => a - b); median = (s[1] + s[2]) / 2; }
  const bad = cells.filter((c) => {
    if (c.v == null) return true;
    if (median != null && Math.abs(c.v - median) > 0.3) return true;
    const tr = trend?.[c.w];
    return typeof tr === "number" && tr < -0.15;
  });
  if (bad.length === 0 && nums.length === 4) return `<span style="color:var(--good);">&#10003; Good</span>`;
  const c = bad[0];
  const val = c.v != null ? `${fmt0(c.v * 14.5038)} PSI` : "no reading";
  return `<span style="color:var(--warn);">${c.label} ${val}${bad.length > 1 ? ` +${bad.length - 1}` : ""}</span>`;
}

async function renderOverview() {
  if (!vin()) return setContent(emptyHtml("No vehicle connected", "Disconnect and reconnect with a VIN."));

  const [summary, latest, locations, tires, degradation] = await Promise.all([
    safe(cached("summary", () => data.summary(vin())), null),
    safe(cached("latest", () => data.latest(vin())), null),
    safe(cached("locations", () => data.locations()), []),
    safe(cached("tires", () => data.tires(vin(), 30)), null),
    safe(cached("degradation", () => data.degradation(vin())), null),
  ]);
  const batteryHealthPct = degradation?.degradation_pct != null ? Math.max(0, 100 - degradation.degradation_pct) : null;

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
  // vs.odometer (live read) is miles; summary/latest are already-normalized km.
  const odometer = typeof vs?.odometer === "number" ? vs.odometer * MI : summary?.odometer_km ?? latest?.odometer ?? null;
  const swVersion = vs?.car_version ?? latest?.software_version ?? null;
  const lat = ds?.latitude ?? latest?.lat ?? null;
  const lon = ds?.longitude ?? latest?.lon ?? null;
  const modelSub = vc ? [vc.car_type, vc.trim_badging].filter(Boolean).join(" · ") : "";

  const hasLive = soc != null || range != null;

  const socChart = await cached("ov_soc7", async () => {
    try {
      const pts = await data.series(vin(), "soc", 7 * 24);
      return pts.filter((p) => typeof p.value === "number").map((p) => [p.ts, p.value]);
    } catch { return []; }
  });

  // Cabin climate: inside vs outside over 24h ("is the AC keeping up?").
  // Both are long-standing position columns, so this works on any worker build.
  const climate = await cached("ov_climate24", async () => {
    const grab = async (field) => {
      try {
        const pts = await data.series(vin(), field, 24);
        return pts.filter((p) => typeof p.value === "number").map((p) => [p.ts, p.value]);
      } catch { return []; }
    };
    return { insidePts: await grab("inside_temp"), outsidePts: await grab("outside_temp") };
  });

  const recentFeed = await cached("ov_recent", async () => {
    try {
      const feed = await buildEventFeed(locations, 10);
      return feed.slice(0, 5);
    } catch { return []; }
  });

  const nearestLoc = lat != null && lon != null ? nearestLocation(locations, lat, lon) : null;

  // Current activity/status (driving/charging/parked/asleep/offline), from the
  // same state-timeline the Timeline screen uses — the most recent row is
  // either still open (end_ts null, bypassing the hours window server-side)
  // or the last-closed one, so this is "what's the car doing right now"
  // without needing an on-demand live read.
  const states = await safe(cached("ov_states", () => data.states(vin(), 3)), []);
  const currentStatus = STATUS_LABEL[states[0]?.state] || null;

  // Reverse-geocoded address for the current point, only when it isn't
  // already a named saved place (nearestLoc) — cached per-coordinate so a
  // later refresh at a different spot doesn't show a stale address.
  let currentAddress = null;
  if (!nearestLoc && lat != null && lon != null) {
    const latR = Math.round(lat * 1000) / 1000, lonR = Math.round(lon * 1000) / 1000;
    const rg = await safe(cached(`ov_revgeo:${latR},${lonR}`, () => data.reverseGeocode(lat, lon)), null);
    currentAddress = rg?.label || null;
  }
  // "Not a saved place, and not currently driving" — offer to save it.
  const offerSavePlace = !nearestLoc && lat != null && lon != null && states[0]?.state !== "driving";

  setContent(`
    <div class="tm-grid-2-wide">
      <div class="tm-card tm-card-pad-lg tm-flex-col">
        ${hasLive ? `
          ${chargeLimit != null ? `<div class="tm-flex-row"><span style="font-size:11.5px;color:var(--faint);">Charge limit ${fmt0(chargeLimit)}%</span></div>` : ""}
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
            <div class="tm-readout-click" data-action="ov-goto-climate" title="See inside vs outside temperature"><div class="tm-readout-label">Inside</div><div class="tm-readout-value">${inside != null ? fmt1(inside) + " °C" : "—"}</div></div>
            <div class="tm-readout-click" data-action="ov-goto-climate" title="See inside vs outside temperature"><div class="tm-readout-label">Outside</div><div class="tm-readout-value">${outside != null ? fmt1(outside) + " °C" : "—"}</div></div>
            <div class="tm-readout-click" data-action="nav" data-screen="st" title="Tyre pressures & trends on Statistics"><div class="tm-readout-label">Tyres</div><div class="tm-readout-value">${tyreStatusHtml(tires)}</div></div>
            <div class="tm-readout-click" data-action="nav" data-screen="tl" title="Full state timeline"><div class="tm-readout-label">Status</div><div class="tm-readout-value">${esc(currentStatus || "—")}</div></div>
          </div>
        ` : `
          <div class="tm-empty" style="padding:12px 0 4px;">
            <div class="tm-empty-title">No live data loaded yet</div>
            <div>Telemetry isn't streaming in yet, so live battery/climate state isn't cached. Load a one-time on-demand read from the car (this is a billed Tesla API call, and only runs when you click it).</div>
            <button class="tm-gate-btn" style="margin-top:8px;width:auto;padding:8px 16px;" data-action="load-live">Load live data</button>
          </div>
        `}
      </div>
      <div class="tm-card tm-map-card">
        <div id="tm-ov-map" class="tm-map-canvas"></div>
        ${lat != null && lon != null ? `<button class="tm-map-expand" data-action="map-expand" title="Expand map" aria-label="Expand map">&#10530;</button>` : ""}
        ${lat != null && lon != null ? `
        <div class="tm-map-overlay">
          <div style="min-width:0;">
            <div class="tm-map-overlay-title">${esc(nearestLoc ? nearestLoc.name : currentAddress || "Current location")}</div>
            ${currentStatus ? `<div class="tm-map-overlay-meta">${esc(currentStatus)}</div>` : ""}
          </div>
          ${offerSavePlace ? `<button class="tm-chip-btn" style="flex:none;padding:5px 12px;" data-action="save-current-place" data-lat="${lat}" data-lon="${lon}" data-label="${esc(currentAddress || "")}">Save this place</button>` : ""}
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
        <div class="tm-stat-value">${batteryHealthPct != null ? fmt1(batteryHealthPct) : "—"}${batteryHealthPct != null ? `<span class="tm-stat-unit">%</span>` : ""}</div>
      </div>
      <div class="tm-card tm-card-pad-metric">
        <div class="tm-stat-label">Avg efficiency</div>
        <div class="tm-stat-value">${summary?.avg_efficiency_wh_km != null ? fmt0(summary.avg_efficiency_wh_km) : "—"} <span class="tm-stat-unit">Wh/km</span></div>
      </div>
    </div>

    <div class="tm-grid-2">
      <div class="tm-card tm-card-pad tm-card-hover" data-action="nav" data-screen="bt">
        <div class="tm-card-head">
          <div class="tm-card-head-title">Charge level</div>
          <div class="tm-card-head-sub">last 7 days &middot; click for the full timeline</div>
        </div>
        ${socChart.length > 1 ? svgLineChart({
          series: [{ points: socChart, area: true }],
          yTicks: [0, 25, 50, 75, 100].map((v) => ({ value: v, label: String(v) })),
          xTicks: buildDayTicks(socChart),
          yDomain: [0, 100],
        }) : miniEmptyHtml("No SoC history yet")}
      </div>
      <div class="tm-card tm-card-pad">
        <div style="font-size:14px;font-weight:600;margin-bottom:14px;">Recent activity</div>
        ${recentFeed.length ? recentFeed.map((e) => {
          const link = e.type === "drive" && e.raw ? `data-action="open-drive" data-id="${e.raw.id}"` : e.type === "charge" && e.raw ? `data-action="open-charge" data-id="${e.raw.id}"` : "";
          return `
          <div class="tm-activity-row ${link ? "tm-activity-click" : ""}" ${link}>
            <span class="tm-dot" style="background:${EVENT_COLOR[e.type]};"></span>
            <div style="min-width:0;">
              <div class="tm-activity-title">${esc(e.title)}</div>
              <div class="tm-activity-meta">${e.meta}</div>
            </div>
            <span class="tm-activity-time">${fmtTime(e.ts)}</span>
            ${link ? `<span class="tm-activity-chev">&#8250;</span>` : ""}
          </div>`;
        }).join("") : miniEmptyHtml("Nothing recorded yet")}
      </div>
    </div>

    <div class="tm-card tm-card-pad" id="tm-ov-climate">
      <div class="tm-card-head">
        <div class="tm-card-head-title">Cabin climate</div>
        <div class="tm-card-head-sub">inside vs outside · last 24h</div>
      </div>
      ${(climate.insidePts.length > 1 || climate.outsidePts.length > 1) ? svgLineChart({
        series: [
          { points: climate.outsidePts, color: "var(--faint)", dashed: true },
          { points: climate.insidePts, color: "var(--accent)", width: 2.2 },
        ].filter((s) => s.points.length > 1),
        yTicks: autoTicks([...climate.insidePts, ...climate.outsidePts].map((p) => p[1]), 4),
        xTicks: buildDayTicks(climate.insidePts.length > 1 ? climate.insidePts : climate.outsidePts),
      }) : miniEmptyHtml("No cabin temperature samples in the last 24h")}
      <div class="tm-flex-row" style="gap:16px;margin-top:10px;font-size:12px;color:var(--sub);">
        <span style="display:flex;align-items:center;gap:6px;"><span style="width:14px;height:2px;background:var(--accent);flex:none;"></span>Inside</span>
        <span style="display:flex;align-items:center;gap:6px;"><span style="width:14px;border-top:2px dashed var(--faint);flex:none;"></span>Outside</span>
      </div>
      ${climateVerdictHtml(latest, inside, outside)}
    </div>
  `);

  updateSideBudget(summary?.api_budget);

  if (lat != null && lon != null) {
    requestAnimationFrame(() => renderPointMap(document.getElementById("tm-ov-map"), lat, lon, esc(nearestLoc?.name || currentAddress || "Current location")));
  }
}

/**
 * One-line answer to "is the AC keeping the cabin in check?" from the latest
 * merged state: AC on/off (hvac_ac_on may arrive as boolean, 0/1, or "true"
 * depending on the ingest path), Climate Keeper mode, and the inside-vs-
 * outside delta. Warn when the cabin is cooking with nothing running.
 */
function climateVerdictHtml(latest, inside, outside) {
  const truthy = (v) => v === true || v === 1 || String(v).toLowerCase() === "true";
  if (inside == null || outside == null) return "";
  const acOn = truthy(latest?.hvac_ac_on) || truthy(latest?.hvac_power);
  const keeper = latest?.climate_keeper_mode ? String(latest.climate_keeper_mode) : null;
  const keeperOn = keeper && !/off|unknown/i.test(keeper);
  const delta = inside - outside;
  let text, warn = false;
  if (acOn && delta <= 1) {
    text = `AC is on and holding — cabin ${fmt1(inside)}°C vs ${fmt1(outside)}°C outside.`;
  } else if (acOn) {
    text = `AC is on but the cabin is still ${fmt1(delta)}°C above outside — likely just started, or fighting heavy sun load.`;
    warn = delta > 4;
  } else if (delta > 3) {
    text = `AC is off and the cabin is ${fmt1(delta)}°C hotter than outside${keeperOn ? ` (Climate Keeper: ${keeper})` : ""} — heat is building up.`;
    warn = true;
  } else {
    text = `AC is off — cabin is tracking the outside temperature${keeperOn ? ` (Climate Keeper: ${keeper})` : ""}.`;
  }
  return `<div class="tm-stat-note" style="margin-top:8px;${warn ? "color:var(--warn);" : ""}">${esc(text)}</div>`;
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
  const [drives, charges, states, roster] = await Promise.all([
    safe(data.drives(vin(), driveLimit), []),
    safe(data.chargeSessions(vin(), driveLimit), []),
    safe(data.states(vin(), 24 * 21), []), // last 3 weeks
    loadDriverRoster(),
  ]);
  const locName = (id) => (id == null ? null : locations.find((l) => l.id === id)?.name);
  const quickAssignHtml = (d) => {
    const quickNames = [...new Set(roster.map(rosterName).filter(Boolean))].sort((a, b) => a.localeCompare(b)).filter((n) => n !== (d.driver || ""));
    if (!quickNames.length) return "";
    return `<span class="tm-quick-assign" style="margin-top:4px;">${quickNames.map((n) => `<button type="button" class="tm-quick-chip" data-action="quick-assign" data-id="${d.id}" data-driver="${esc(n)}">${esc(n)}</button>`).join("")}</span>`;
  };

  const events = [];
  for (const d of drives) {
    if (d.start_ts == null) continue;
    const stats = `${d.distance_km != null ? fmt1(d.distance_km) + " km" : "—"} · ${fmtDurationMin(d.duration_min)}${d.efficiency_wh_km != null ? " · " + fmt0(d.efficiency_wh_km) + " Wh/km" : ""}`;
    // Driver + score when assigned; a one-tap quick-assign row when not —
    // "meta" is raw HTML from here on (unlike the other event types, which
    // stay plain interpolated numbers), so render sites must NOT re-escape it.
    const driverBit = d.driver
      ? ` · ${esc(d.driver)}${d.behavior_score != null ? ` <span style="color:${scoreColor(d.behavior_score)};">(${d.behavior_score}/100)</span>` : ""}`
      : d.suggested_driver
        ? ` · <span class="tm-driver-suggested">${esc(d.suggested_driver)}?</span>`
        : "";
    events.push({
      ts: d.start_ts,
      type: "drive",
      title: `${driveEndpoint(d, "start", locations)} → ${driveEndpoint(d, "end", locations)}`,
      meta: `${esc(stats)}${driverBit}${!d.driver ? quickAssignHtml(d) : ""}`,
      raw: d,
    });
  }
  for (const c of charges) {
    if (c.start_ts == null) continue;
    events.push({
      ts: c.start_ts,
      type: "charge",
      title: `Charged at ${chargeLocName(c, locations)}`,
      meta: esc(`${c.energy_added_kwh != null ? "+" + fmt1(c.energy_added_kwh) + " kWh" : "—"}${c.start_soc != null && c.end_soc != null ? ` · ${fmt0(c.start_soc)} → ${fmt0(c.end_soc)}%` : ""}${c.cost != null ? ` · ${money(c.cost, c.currency)}` : ""}`),
      raw: c,
    });
  }
  for (const s of states) {
    if (s.start_ts == null) continue;
    if (s.state === "asleep" || s.state === "offline") {
      events.push({ ts: s.start_ts, type: "sleep", title: s.state === "asleep" ? "Asleep" : "Offline", meta: esc(fmtDurationSec(s.duration_s)) });
    } else if (s.state === "updating") {
      events.push({ ts: s.start_ts, type: "update", title: "Software update", meta: esc(fmtDurationSec(s.duration_s)) });
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
            ${day.ev.map((e) => {
              const link = e.type === "drive" && e.raw ? `data-action="open-drive" data-id="${e.raw.id}"` : e.type === "charge" && e.raw ? `data-action="open-charge" data-id="${e.raw.id}"` : "";
              return `
              <div class="tm-timeline-row ${link ? "tm-activity-click" : ""}" ${link}>
                <span class="tm-timeline-time">${fmtTime(e.ts)}</span>
                <span class="tm-dot" style="background:${EVENT_COLOR[e.type]};"></span>
                <div style="min-width:0;">
                  <div class="tm-timeline-title">${esc(e.title)}</div>
                  <div class="tm-timeline-meta">${e.meta}</div>
                </div>
                ${link ? `<span class="tm-activity-chev" style="margin-left:auto;">&#8250;</span>` : ""}
              </div>`;
            }).join("")}
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
      <div class="tm-card-head">
        <div class="tm-card-head-title">Efficiency vs temperature</div>
        <div class="tm-card-head-sub">avg Wh/km per 5 °C bin${totalDrives ? ` · ${totalDrives} drives` : ""}</div>
      </div>
      ${pts.length >= 2 ? svgLineChart({
        series: [{
          points: pts,
          markers: true,
          titles: bins.map((b) => `${fmt1(b.t_min)}–${fmt1(b.t_max)} °C · ${fmt0(b.avg_wh_km)} Wh/km · ${b.drives ?? "?"} drives · ${fmt0(b.distance_km)} km`),
        }],
        yTicks: autoTicks(pts.map((p) => p[1]), 4),
        xTicks: pts.map((p) => ({ value: p[0], label: `${fmt0(p[0])}°` })),
      }) : miniEmptyHtml("Not enough temperature-tagged drives yet — this fills in as drives with outside-temperature samples accumulate.")}
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

/** ADAS feature adoption (idea #62/#70) — how much your driving interacts with the car's own safety systems. */
function safetyFeaturesCard(s) {
  if (!s || s.has_data === false) return "";
  return `
    <div class="tm-card tm-card-pad">
      <div class="tm-card-head"><div class="tm-card-head-title">Safety feature usage</div><div class="tm-card-head-sub">last ${s.days} days</div></div>
      <div class="tm-grid-half" style="gap:14px;">
        <div><div class="tm-readout-label">AEB disabled</div><div class="tm-readout-value" style="${s.aeb_disabled_pct > 0 ? "color:var(--warn);" : ""}">${s.aeb_disabled_pct != null ? fmt0(s.aeb_disabled_pct) + "%" : "—"}</div></div>
        <div><div class="tm-readout-label">Blind-spot chimes</div><div class="tm-readout-value">${fmt0(s.blind_spot_chime_count)}</div></div>
        <div><div class="tm-readout-label">Lane departure</div><div class="tm-readout-value" style="font-size:14px;">${esc(s.lane_departure_setting || "—")}</div></div>
        <div><div class="tm-readout-label">Forward collision warning</div><div class="tm-readout-value" style="font-size:14px;">${esc(s.forward_collision_warning_setting || "—")}</div></div>
      </div>
    </div>`;
}

/** Climate/comfort habits (idea #33/#38) — the same signal the driver auto-assign fingerprint uses, as its own report. */
function climateHabitsCard(c) {
  if (!c || c.has_data === false) return "";
  return `
    <div class="tm-card tm-card-pad">
      <div class="tm-card-head"><div class="tm-card-head-title">Climate habits</div><div class="tm-card-head-sub">last ${c.days} days</div></div>
      <div class="tm-grid-half" style="gap:14px;">
        <div><div class="tm-readout-label">Auto climate · L</div><div class="tm-readout-value">${c.auto_climate_left_pct != null ? fmt0(c.auto_climate_left_pct) + "%" : "—"}</div></div>
        <div><div class="tm-readout-label">Auto climate · R</div><div class="tm-readout-value">${c.auto_climate_right_pct != null ? fmt0(c.auto_climate_right_pct) + "%" : "—"}</div></div>
        <div><div class="tm-readout-label">Seat heater · L / R</div><div class="tm-readout-value">${c.avg_seat_heater_left ?? "—"} / ${c.avg_seat_heater_right ?? "—"}</div></div>
        <div><div class="tm-readout-label">Seat cooling · L / R</div><div class="tm-readout-value">${c.avg_seat_cool_left ?? "—"} / ${c.avg_seat_cool_right ?? "—"}</div></div>
      </div>
      ${c.seat_heater_divergence != null && c.seat_heater_divergence >= 1 ? `<div class="tm-stat-note" style="margin-top:12px;">Driver/passenger seat-heater habits diverge by ${c.seat_heater_divergence} levels on average.</div>` : ""}
    </div>`;
}

async function renderStatistics() {
  const [drives, charges, effTemp, monthlyRes, tires, safetyFeatures, climateHabits] = await Promise.all([
    safe(cached("all_drives", () => data.drives(vin(), 2000)), []),
    safe(cached("all_charges", () => data.chargeSessions(vin(), 2000)), []),
    safe(cached("eff_temp", () => data.efficiencyByTemp(vin())), null),
    safe(cached("monthly", () => data.monthly(vin(), 12)), null),
    safe(cached("tires_90", () => data.tires(vin(), 90)), null), // distinct key from Overview's 30-day "tires" cache
    safe(cached("safety_features", () => data.safetyFeatures(vin(), 90)), null),
    safe(cached("climate_habits", () => data.climateHabits(vin(), 90)), null),
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
      <div class="tm-card-head">
        <div class="tm-card-head-title">Distance driven</div>
        <div class="tm-card-head-sub">km per month</div>
      </div>
      ${monthlyRows.length ? svgBarChart({ bars: monthlyRows.slice().reverse().map((m) => ({ label: monthShort(m.month), value: m.distance_km || 0 })) })
        : months.length ? svgBarChart({ bars: months.map((m) => ({ label: m.m, value: m.km })) })
        : miniEmptyHtml("No monthly data yet")}
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
    ${tires?.balance || tires?.latest ? `<div class="tm-grid-3col">${tpmsCard(tires)}</div>` : ""}
    ${(safetyFeatures?.has_data || climateHabits?.has_data) ? `<div class="tm-grid-2">${safetyFeaturesCard(safetyFeatures)}${climateHabitsCard(climateHabits)}</div>` : ""}
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

/** True when a drive was reconstructed from an odometer jump (no GPS trace). */
function isSyntheticDrive(d) {
  return d?.synthetic === 1 || d?.synthetic === true;
}

const SYNTHETIC_TITLE = "Reconstructed from the odometer — this drive happened between polls, so distance & endpoints are known but there's no GPS trace. Live capture needs more frequent polling or telemetry streaming.";

/** Muted "reconstructed · no route" pill for odometer-reconstructed drives. */
function syntheticBadgeHtml() {
  return `<span class="tm-pill tm-pill-chip" style="font-size:10.5px;" title="${esc(SYNTHETIC_TITLE)}">reconstructed · no route</span>`;
}

/** Driver cell body: assigned name, or the classifier's guess (muted, "?"-suffixed), or —. */
function driverCellHtml(d) {
  if (d.driver) {
    const auto = d.driver_source === "auto"
      ? `<span class="tm-pill tm-pill-chip" style="font-size:9.5px;padding:1px 6px;margin-left:5px;vertical-align:1px;" title="Assigned automatically from place, time and climate-profile patterns — click to correct it if it's wrong.">auto</span>`
      : "";
    return esc(d.driver) + auto;
  }
  if (d.suggested_driver) return `<span class="tm-driver-suggested">${esc(d.suggested_driver)}?</span>`;
  return `<span style="color:var(--faint);">—</span>`;
}

/** Swap a driver cell for an inline input (datalist of known names); saves on Enter/blur. */
function beginDriverEdit(cell, id) {
  const drives = state.cache.all_drives || [];
  const row = drives.find((d) => d.id === id);
  const current = row?.driver || "";
  // Roster chips let a driver self-assign in one tap instead of typing their
  // own name — reuses whatever roster renderDrives() already loaded.
  const roster = state.cache.drivers_roster?.drivers || knownDrivers(drives).map((name) => ({ name, source: "tagged" }));
  const quickNames = [...new Set(roster.map(rosterName).filter(Boolean))].sort((a, b) => a.localeCompare(b)).filter((n) => n !== current);
  cell.innerHTML = `
    <input class="tm-driver-edit" list="tm-driver-names" value="${esc(current)}" placeholder="${esc(row?.suggested_driver ? row.suggested_driver + "?" : "driver…")}" autocomplete="off">
    ${quickNames.length ? `<div class="tm-quick-assign">${quickNames.map((n) => `<button type="button" class="tm-quick-chip" data-action="quick-assign" data-id="${id}" data-driver="${esc(n)}">${esc(n)}</button>`).join("")}</div>` : ""}
  `;
  const input = cell.querySelector("input");
  // A click on a quick chip would otherwise blur the input first (finishing
  // the edit with whatever was typed) before the chip's own click fires —
  // keep focus on the input so only the chip's quick-assign action runs.
  cell.querySelector(".tm-quick-assign")?.addEventListener("mousedown", (e) => e.preventDefault());
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
      <div class="tm-drives-grid" style="min-width:960px;">
        <div class="tm-table-head" style="grid-template-columns:${cols};">
          <div>When</div><div>Route</div><div>Driver</div><div class="tm-right">Distance</div><div class="tm-right">Duration</div><div class="tm-right">Avg speed</div><div class="tm-right">Consumption</div><div class="tm-right">Battery</div>
        </div>
        ${filtered.map((d) => `
          <div class="tm-table-row" data-action="open-drive" data-id="${d.id}" style="grid-template-columns:${cols};">
            <div data-role="when" style="font-size:12.5px;color:var(--sub);">${fmtDateTime(d.start_ts)}</div>
            <div data-role="route" class="tm-ellipsis" style="font-size:13.5px;font-weight:500;"><bdi>${esc(driveEndpoint(d, "start", locations))}</bdi> <span style="color:var(--faint);">→</span> <bdi>${esc(driveEndpoint(d, "end", locations))}</bdi>${isSyntheticDrive(d) ? " " + syntheticBadgeHtml() : ""}</div>
            <div data-k="Driver" class="tm-ellipsis tm-edit-cell" data-action="edit-driver" data-id="${d.id}" title="Click to assign driver" style="font-size:12.5px;">${driverCellHtml(d)}</div>
            <div data-k="Distance" class="tm-right tm-mono">${d.distance_km != null ? fmt1(d.distance_km) : "—"} km</div>
            <div data-k="Duration" class="tm-right tm-mono" style="color:var(--sub);">${fmtDurationMin(d.duration_min)}</div>
            <div data-k="Speed" class="tm-right tm-mono" style="color:var(--sub);">${d.avg_speed != null ? fmt0(d.avg_speed) : "—"} km/h</div>
            <div data-k="Wh/km" class="tm-right tm-mono">${d.efficiency_wh_km != null ? fmt0(d.efficiency_wh_km) : "—"} Wh/km</div>
            <div data-k="Battery" class="tm-right tm-mono" style="color:var(--sub);">${d.start_soc != null && d.end_soc != null ? `${fmt0(d.start_soc)} → ${fmt0(d.end_soc)}` : "—"} %</div>
          </div>`).join("")}
        <div class="tm-foot-note">${filtered.length} drive${filtered.length === 1 ? "" : "s"} in range. Click a driver cell to assign; <span class="tm-driver-suggested">italic?</span> names are unconfirmed suggestions. ${esc(DRIVER_MANUAL_NOTE)}</div>
      </div>
    </div>` : emptyHtml("No drives in this range", "Try a wider filter, or check back once more trips are logged.")}
  `);
}

async function renderDriveDetail() {
  const detail = await data.drive(state.openDriveId);
  if (detail.error) return setContent(errorHtml(detail.error));
  const { drive: d, path, media = [] } = detail;
  const locations = await safe(cached("locations", () => data.locations()), []);
  const roster = await loadDriverRoster();
  const locName = (id) => (id == null ? "Unknown" : locations.find((l) => l.id === id)?.name || "Unknown");

  // Synthetic drives are reconstructed from an odometer jump between polls — they
  // carry no GPS route, so show a placeholder card instead of an empty map.
  const synthetic = isSyntheticDrive(d);
  const hasRoute = !synthetic && path.length >= 2;

  const t0 = d.start_ts;
  const speedPts = path.filter((p) => p.speed != null).map((p) => [(p.ts - t0) / 60, p.speed]);
  const elevPts = path.filter((p) => p.elevation != null).map((p) => [(p.ts - t0) / 60, p.elevation]);

  // ---- Playback prep. Position rows are sparse — a sample may carry lat/lon OR
  // speed OR soc — so each field is interpolated from its own [ts, value] series. ----
  const posPts = path.filter((p) => p.lat != null && p.lon != null && p.ts != null).map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon }));
  const spSeries = path.filter((p) => p.speed != null && p.ts != null).map((p) => [p.ts, p.speed]);
  const socSeries = path.filter((p) => p.soc != null && p.ts != null).map((p) => [p.ts, p.soc]);
  const powSeries = path.filter((p) => p.power != null && p.ts != null).map((p) => [p.ts, p.power]);
  const hasGps = !synthetic && posPts.length >= 2;

  // Cumulative haversine distance as a [ts, km] series, for the live "distance so far".
  const kmSeries = [];
  for (let i = 0, acc = 0; i < posPts.length; i++) {
    if (i > 0) acc += haversineKm(posPts[i - 1], posPts[i]);
    kmSeries.push([posPts[i].ts, acc]);
  }
  const totalKm = kmSeries.length ? kmSeries[kmSeries.length - 1][1] : (d.distance_km || 0);

  // Instantaneous longitudinal accel (m/s²) from the speed slope, and deduped harsh
  // brake/accel events (a single hard stop → one dot, not a cluster of samples).
  const accSeries = [];
  for (let i = 1; i < spSeries.length; i++) {
    const dt = Math.max(0.5, spSeries[i][0] - spSeries[i - 1][0]);
    accSeries.push([spSeries[i][0], ((spSeries[i][1] - spSeries[i - 1][1]) / 3.6) / dt]);
  }
  const BRAKE_MS2 = -2.8, ACCEL_MS2 = 2.2, EVENT_GAP_S = 4;
  const events = [];
  const lastEv = { brake: -Infinity, accel: -Infinity };
  for (const [ts, a] of accSeries) {
    const type = a <= BRAKE_MS2 ? "brake" : a >= ACCEL_MS2 ? "accel" : null;
    if (!type) continue;
    if (ts - lastEv[type] < EVENT_GAP_S) {
      const last = events[events.length - 1];
      if (last && last.type === type && Math.abs(a) > Math.abs(last.acc)) {
        Object.assign(last, { acc: a, t: (ts - t0) / 60, speed: interpAt(spSeries, ts) ?? last.speed, g: a / 9.81 });
      }
      lastEv[type] = ts;
      continue;
    }
    lastEv[type] = ts;
    events.push({ t: (ts - t0) / 60, type, speed: interpAt(spSeries, ts) ?? 0, acc: a, g: a / 9.81 });
  }

  const lastTs = Math.max(posPts.at(-1)?.ts ?? t0, spSeries.at(-1)?.[0] ?? t0);
  const totalSec = Math.max(1, lastTs - t0);
  const totalMin = totalSec / 60;
  const avgPower = powSeries.length ? powSeries.reduce((s, p) => s + p[1], 0) / powSeries.length : null;
  const trackMarkers = media.map((m) => ({ t: (m.ts - t0) / 60, title: m.title, artist: m.artist }));
  const chart = speedPts.length > 1
    ? svgDriveChart({ speedPts, elevPts, events, tracks: trackMarkers, durationMin: totalMin })
    : { html: "", plot: null };

  const routePlaceholder = `
      <div class="tm-card tm-card-pad-lg tm-flex-col" style="min-height:320px;justify-content:center;gap:16px;">
        ${synthetic ? syntheticBadgeHtml() : ""}
        <div class="tm-route-placeholder">
          <div class="tm-route-endpoint"><span class="tm-route-dot" style="background:var(--good);"></span><span class="tm-ellipsis">${esc(driveEndpoint(d, "start", locations))}</span></div>
          <div class="tm-route-connector"></div>
          <div class="tm-route-endpoint"><span class="tm-route-dot" style="background:var(--accent);"></span><span class="tm-ellipsis">${esc(driveEndpoint(d, "end", locations))}</span></div>
        </div>
        <div class="tm-stat-note" style="margin-top:0;">${synthetic
          ? "No GPS route recorded for this drive — it was reconstructed from the odometer, so distance & endpoints are known but there's no trace to map."
          : "No GPS route recorded for this drive."}</div>
      </div>`;

  setContent(`
    ${driverDatalistHtml(roster, "tm-driver-names-detail")}
    <div class="tm-flex-row" style="gap:14px;flex-wrap:wrap;">
      <button class="tm-back-btn" data-action="back-drives">← Drives</button>
      <div style="font-size:15px;font-weight:600;"><bdi>${esc(driveEndpoint(d, "start", locations))}</bdi> <span style="color:var(--faint);">→</span> <bdi>${esc(driveEndpoint(d, "end", locations))}</bdi></div>
      <div style="font-size:12.5px;color:var(--faint);">${fmtDateTime(d.start_ts)}</div>
      ${synthetic ? syntheticBadgeHtml() : ""}
      <div class="tm-flex-row" style="margin-left:auto;gap:6px;">
        <a class="tm-chip-btn" style="padding:5px 12px;" href="${esc(exportUrl("/data/export/drive.gpx", { id: d.id }))}" target="_blank" rel="noopener" download>&#11015; GPX</a>
      </div>
    </div>
    ${(() => {
      // ONE driver control (was three: a header input+Save, a reassign-chip
      // row, and a Household hint — issue #24). The roster chips ARE the
      // API-derived household list; the current driver renders active; a
      // suggested driver gets a "?" chip to confirm in one tap; "other…"
      // reveals the free-text input for a name not on the roster.
      const names = [...new Set([...roster.map(rosterName), d.driver].filter(Boolean))].sort((a, b) => a.localeCompare(b));
      return `<div class="tm-flex-row" style="gap:8px;align-items:center;flex-wrap:wrap;">
        <span style="font-size:12px;color:var(--sub);">Driver:</span>
        <div class="tm-quick-assign" style="margin-top:0;">
          ${names.map((n) => `<button type="button" class="tm-quick-chip ${n === d.driver ? "active" : ""}" data-action="quick-assign" data-id="${d.id}" data-driver="${esc(n)}" ${n === d.driver ? 'title="Currently assigned"' : ""}>${esc(n)}${!d.driver && n === d.suggested_driver ? "?" : ""}</button>`).join("")}
        </div>
        <button type="button" class="tm-link-btn" data-action="driver-other-toggle" style="font-size:12px;">other…</button>
        <span id="tm-driver-other" style="display:none;gap:6px;align-items:center;">
          <input id="tm-driver-input" list="tm-driver-names-detail" class="tm-gate-input" style="width:140px;padding:5px 9px;font-family:var(--ui);" placeholder="name…" value="${esc(d.driver || "")}" autocomplete="off">
          <button class="tm-chip-btn" style="padding:5px 12px;" data-action="save-driver" data-id="${d.id}">Save</button>
        </span>
      </div>
      <div style="font-size:12px;color:var(--faint);">${!d.driver && d.suggested_driver ? `Looks like <span class="tm-driver-suggested">${esc(d.suggested_driver)}</span> drove this — tap their name to confirm. ` : ""}${esc(DRIVER_MANUAL_NOTE)}</div>`;
    })()}

    <div class="tm-grid-2-wide">
      <div class="tm-drive-livegrid">
        <div class="tm-card tm-lv"><div class="tm-stat-label">Distance</div><div class="tm-lv-val tm-mono" id="tm-lv-dist">${totalKm ? fmt1(totalKm) : (d.distance_km != null ? fmt1(d.distance_km) : "—")} <span class="tm-lv-u">km</span></div><div class="tm-lv-sub" id="tm-lv-dist-s">total</div></div>
        <div class="tm-card tm-lv"><div class="tm-stat-label">Elapsed</div><div class="tm-lv-val tm-mono" id="tm-lv-time">${fmtDurationMin(d.duration_min)}</div><div class="tm-lv-sub" id="tm-lv-time-s">duration</div></div>
        <div class="tm-card tm-lv"><div class="tm-stat-label">Speed</div><div class="tm-lv-val tm-mono" id="tm-lv-speed">${d.avg_speed != null ? fmt0(d.avg_speed) : "—"} <span class="tm-lv-u">km/h</span></div><div class="tm-lv-sub" id="tm-lv-speed-s">avg · ${d.max_speed != null ? fmt0(d.max_speed) : "—"} top</div></div>
        <div class="tm-card tm-lv"><div class="tm-stat-label">Accel</div><div class="tm-lv-val tm-mono" id="tm-lv-accel">${d.max_decel_ms2 != null ? fmt2(d.max_decel_ms2 / 9.81) : "—"} <span class="tm-lv-u">g</span></div><div class="tm-lv-sub" id="tm-lv-accel-s">peak brake</div></div>
        <div class="tm-card tm-lv"><div class="tm-stat-label">Power</div><div class="tm-lv-val tm-mono" id="tm-lv-power">${avgPower != null ? fmt0(avgPower) : (d.efficiency_wh_km != null ? fmt0(d.efficiency_wh_km) : "—")} <span class="tm-lv-u">${avgPower != null ? "kW" : "Wh/km"}</span></div><div class="tm-lv-sub" id="tm-lv-power-s">${avgPower != null ? "avg" : "consumption"}</div></div>
        <div class="tm-card tm-lv"><div class="tm-stat-label">Battery</div><div class="tm-lv-val tm-mono" id="tm-lv-soc">${d.start_soc != null && d.end_soc != null ? `${fmt0(d.start_soc)}→${fmt0(d.end_soc)}` : "—"} <span class="tm-lv-u">%</span></div><div class="tm-lv-sub" id="tm-lv-soc-s">start → end</div></div>
      </div>
      ${hasGps ? `
      <div class="tm-card tm-map-card" style="min-height:320px;">
        <div id="tm-drive-map" class="tm-map-canvas"></div>
        <button class="tm-map-expand" data-action="map-expand" title="Expand map" aria-label="Expand map">&#10530;</button>
      </div>` : routePlaceholder}
    </div>

    ${speedPts.length > 1 ? `
    <div class="tm-card tm-card-pad">
      <div class="tm-play-bar">
        <button class="tm-play-btn" id="tm-play-btn" title="Play drive" aria-label="Play drive">▶</button>
        <div class="tm-play-clock tm-mono" id="tm-play-clock">0:00 / ${fmtClock(totalSec)}</div>
        <div class="tm-play-legend">
          <span><i style="background:var(--bad);"></i>hard brake</span>
          <span><i style="background:var(--warn);"></i>hard accel</span>
          <span><i class="tm-dash"></i>elevation</span>
          ${trackMarkers.length ? `<span><i style="background:#8A63D2;"></i>♪ track change</span>` : ""}
        </div>
        <div style="margin-left:auto;font-size:11.5px;color:var(--faint);">${d.outside_temp_avg != null ? `outside ${fmt1(d.outside_temp_avg)} °C` : "Speed km/h · tap chart to scrub"}</div>
      </div>
      <div id="tm-drive-chart">${chart.html}</div>
    </div>` : `<div class="tm-card tm-card-pad">${miniEmptyHtml("No speed samples recorded for this drive")}</div>`}

    ${d.behavior_score != null || d.max_decel_ms2 != null ? `
    <div class="tm-grid-metrics">
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Safety score</div><div class="tm-stat-value" style="color:${scoreColor(d.behavior_score)};">${d.behavior_score != null ? d.behavior_score : "—"}</div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Peak braking</div><div class="tm-stat-value">${d.max_decel_ms2 != null ? fmt2(d.max_decel_ms2 / 9.81) : "—"} <span class="tm-stat-unit">g</span></div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Harsh brakes · accels</div><div class="tm-stat-value">${d.harsh_brake_count ?? 0} · ${d.harsh_accel_count ?? 0}</div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Speeding · night</div><div class="tm-stat-value">${d.over_limit_frac != null ? fmt0(d.over_limit_frac * 100) : "—"} · ${d.night_frac != null ? fmt0(d.night_frac * 100) : "—"} <span class="tm-stat-unit">%</span></div></div>
      ${d.max_jerk_ms3 != null ? `<div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Peak jerk</div><div class="tm-stat-value">${fmt1(d.max_jerk_ms3)} <span class="tm-stat-unit">m/s³</span></div></div>` : ""}
    </div>` : ""}
    ${riskCertificateSection(d)}
  `);

  if (chart.plot || hasGps) {
    requestAnimationFrame(() => setupDrivePlayback({
      d, path, hasGps, plot: chart.plot, t0, totalSec, totalMin, totalKm,
      posPts, spSeries, socSeries, powSeries, kmSeries, accSeries,
    }));
  }
}

// Module-scoped so a navigation away (which rebuilds the DOM) can cancel the
// previous drive's animation frame before a new one attaches.
let activeDrivePlaybackStop = null;

/**
 * Unified drive replay: one clock drives the map marker, the chart playhead, and
 * the live metric cards together. The chart is click/drag scrubbable. Cleanup is
 * self-guarding — if the play button is gone (navigated away), the loop stops.
 */
function setupDrivePlayback(ctx) {
  if (activeDrivePlaybackStop) { try { activeDrivePlaybackStop(); } catch { /* already gone */ } activeDrivePlaybackStop = null; }
  const { d, path, hasGps, plot, t0, totalSec, totalMin, totalKm, posPts, spSeries, socSeries, powSeries, kmSeries, accSeries } = ctx;

  const rm = hasGps ? createReplayMarker(renderRouteMap(document.getElementById("tm-drive-map"), path)) : null;
  const btn = document.getElementById("tm-play-btn");
  if (!btn) return;
  const clockEl = document.getElementById("tm-play-clock");
  const phLine = document.getElementById("tm-ph-line");
  const phDot = document.getElementById("tm-ph-dot");
  const scrub = document.getElementById("tm-ph-scrub");
  const $ = (id) => document.getElementById(id);
  const el = {
    dist: $("tm-lv-dist"), distS: $("tm-lv-dist-s"), time: $("tm-lv-time"), timeS: $("tm-lv-time-s"),
    speed: $("tm-lv-speed"), speedS: $("tm-lv-speed-s"), accel: $("tm-lv-accel"), accelS: $("tm-lv-accel-s"),
    power: $("tm-lv-power"), powerS: $("tm-lv-power-s"), soc: $("tm-lv-soc"), socS: $("tm-lv-soc-s"),
  };

  const DURATION_MS = Math.min(40000, Math.max(12000, totalMin * 1100));
  let raf = null, playing = false, progress = 0, lastFrame = null;
  const val = (v, u) => `${v} <span class="tm-lv-u">${u}</span>`;

  function paint(frac) {
    const ts = t0 + frac * totalSec;
    if (rm) { const pos = interpPos(posPts, ts); if (pos) rm.move(pos.lat, pos.lon); }
    const sp = interpAt(spSeries, ts), soc = interpAt(socSeries, ts), pow = interpAt(powSeries, ts);
    const km = interpAt(kmSeries, ts), ac = interpAt(accSeries, ts);
    if (plot) {
      const X = plot.X((ts - t0) / 60);
      phLine.setAttribute("x1", X); phLine.setAttribute("x2", X); phLine.style.opacity = "0.5";
      if (sp != null) { phDot.setAttribute("cx", X); phDot.setAttribute("cy", plot.Y(sp)); phDot.style.opacity = "1"; }
    }
    if (el.dist) { el.dist.innerHTML = val(fmt1(km ?? 0), "km"); el.distS.textContent = `of ${fmt1(totalKm)} km`; }
    if (el.time) { el.time.textContent = fmtClock(ts - t0); el.timeS.textContent = `of ${fmtClock(totalSec)}`; }
    if (el.speed) { el.speed.innerHTML = val(sp != null ? fmt0(sp) : "—", "km/h"); el.speedS.textContent = "now"; }
    if (el.accel && ac != null) {
      const g = ac / 9.81;
      el.accel.innerHTML = val(`${g >= 0 ? "+" : ""}${fmt2(g)}`, "g");
      el.accel.style.color = ac <= -2.8 ? "var(--bad)" : ac >= 2.2 ? "var(--warn)" : "var(--text)";
      el.accelS.textContent = "now";
    }
    if (el.power && pow != null) { el.power.innerHTML = val(fmt0(pow), "kW"); el.powerS.textContent = "now"; }
    if (el.soc && soc != null) { el.soc.innerHTML = val(fmt0(soc), "%"); el.socS.textContent = "now"; }
    if (clockEl) clockEl.textContent = `${fmtClock(ts - t0)} / ${fmtClock(totalSec)}`;
  }

  const setBtn = () => { btn.textContent = playing ? "❚❚" : "▶"; btn.title = playing ? "Pause" : "Play drive"; };
  const frame = (now) => {
    raf = null;
    if (!document.getElementById("tm-play-btn")) { playing = false; return; } // navigated away
    if (!playing) return;
    if (lastFrame != null) progress += (now - lastFrame) / DURATION_MS;
    lastFrame = now;
    if (progress >= 1) { progress = 1; paint(1); playing = false; lastFrame = null; setBtn(); return; }
    paint(progress);
    raf = requestAnimationFrame(frame);
  };
  btn.addEventListener("click", () => {
    playing = !playing;
    if (playing) { if (progress >= 1) progress = 0; lastFrame = null; if (raf == null) raf = requestAnimationFrame(frame); }
    else if (raf != null) { cancelAnimationFrame(raf); raf = null; }
    setBtn();
  });
  if (scrub && plot) {
    const svg = scrub.ownerSVGElement;
    const seek = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const vbX = ((clientX - rect.left) / (rect.width || 1)) * plot.width;
      progress = Math.max(0, Math.min(1, (vbX - plot.l) / ((plot.width - plot.l - plot.r) || 1)));
      paint(progress);
    };
    scrub.addEventListener("pointerdown", (e) => { seek(e.clientX); try { scrub.setPointerCapture(e.pointerId); } catch { /* unsupported */ } });
    scrub.addEventListener("pointermove", (e) => { if (e.buttons & 1) seek(e.clientX); });
  }
  setBtn();
  activeDrivePlaybackStop = () => { playing = false; if (raf != null) cancelAnimationFrame(raf); raf = null; if (rm) rm.hide(); };
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
  // Full household roster (Tesla-reported + tagged). 404s gracefully → []. Any
  // roster member without a scored drive is surfaced in a "Household drivers"
  // section below, so a shared driver with 0 tagged trips is still visible.
  const roster = await loadDriverRoster();
  const scoredNames = new Set(drivers.map((d) => (d.driver || "").toLowerCase()));
  const rosterOnly = roster.filter((r) => {
    const name = rosterName(r);
    return name && name !== "Unknown" && !scoredNames.has(name.toLowerCase());
  });

  if (!drivers.length && !rosterOnly.length) return setContent(emptyHtml("No drives recorded yet", "Once trips are logged you can assign each drive to a driver (on the Drives page) and their risk profile appears here."));

  const hasScores = drivers.some((d) => d.behavior_score != null);
  const baselineNote = res?.baseline_note || res?.note || null;

  setContent(`
    <div class="tm-card tm-card-pad" style="background:color-mix(in oklab, var(--accent) 5%, var(--card));">
      <div style="font-size:13px;color:var(--sub);line-height:1.5;">
        <b>How this works.</b> Tesla exposes no way to know <i>who</i> is driving, so the system infers it from place,
        time-of-day and climate-profile patterns — confidently-matched trips are tagged automatically
        (<span class="tm-pill tm-pill-chip" style="font-size:9.5px;padding:1px 6px;">auto</span>), weaker matches are
        left as a one-tap suggestion on the <b>Drives</b> page, and you can always correct either one. Speed, speeding %,
        night-driving and mileage are always reliable; <b>harsh braking / acceleration / g-force need ~1-second sampling</b> to be meaningful, so at the current
        logging cadence those show as low-fidelity. ${hasScores ? "" : "No behaviour scores yet — they populate as multi-sample drives accumulate."}
      </div>
      ${baselineNote ? `<div style="font-size:12px;color:var(--faint);line-height:1.5;margin-top:10px;border-top:1px solid var(--line2);padding-top:10px;"><b>Baseline.</b> ${esc(baselineNote)}</div>` : ""}
    </div>
    ${drivers.length ? `<div class="tm-grid-3col">
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
    </div>` : ""}
    ${rosterOnly.length ? `
    <div class="tm-flex-row" style="align-items:baseline;gap:10px;margin-top:4px;">
      <div style="font-size:14px;font-weight:600;">Household drivers</div>
      <div style="font-size:12px;color:var(--faint);">on the roster but with no scored trips yet</div>
    </div>
    <div class="tm-grid-3col">
      ${rosterOnly.map((r) => `
        <div class="tm-card tm-card-pad">
          <div class="tm-flex-row" style="justify-content:space-between;align-items:flex-start;gap:10px;">
            <div style="min-width:0;">
              <div class="tm-ellipsis" style="font-size:15px;font-weight:600;">${esc(rosterName(r))}</div>
              <div style="font-size:12px;color:var(--faint);margin-top:4px;">no drives tagged yet</div>
            </div>
            <span class="tm-pill tm-pill-chip" style="font-size:11px;white-space:nowrap;" title="${esc(r.source === "tesla" ? "from your Tesla account" : "previously tagged")}">
              ${r.source === "tesla" ? `<span class="tm-roster-dot">⬤</span> Household · Tesla` : "Tagged"}
            </span>
          </div>
          <div class="tm-stat-note" style="margin-top:14px;">Assign this person's trips on the <b>Drives</b> page and their risk profile will appear here.</div>
        </div>`).join("")}
    </div>` : ""}
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

/** Toggleable driver-tag chips — click reads directly off the DOM at save time, no state needed. */
function driverChipsHtml(names, preselected = []) {
  if (!names.length) return "";
  return `<div class="tm-driver-tags">${names.map((n) => `
    <button type="button" class="tm-driver-chip ${preselected.includes(n) ? "active" : ""}" data-action="toggle-driver-chip" data-name="${esc(n)}">${esc(n)}</button>`).join("")}</div>`;
}
function selectedDriverNames(scopeEl) {
  return [...scopeEl.querySelectorAll(".tm-driver-chip.active")].map((c) => c.dataset.name);
}

/**
 * "Add a place" popup: pick a frequent stop the car has already visited, or
 * search an address for one it hasn't — either way, name it, optionally tag
 * which driver(s) it's for, and save it. Kept as a modal (not always on the
 * page) since most visits to Places don't involve adding anything.
 */
function addPlaceModalHtml() {
  const ps = state.placeSearch;
  const names = [...new Set((ps.roster || []).map(rosterName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const closeBtn = `<button class="tm-icon-btn" data-action="modal-close" aria-label="Close">✕</button>`;

  if (ps.selected) {
    return `
      <div class="tm-modal-head">
        <div><div class="tm-modal-title">Name this place</div><div class="tm-modal-sub">${esc(ps.selected.label || "")}</div></div>
        ${closeBtn}
      </div>
      <div id="tm-place-modal-map" class="tm-map-canvas" style="height:160px;border-radius:10px;margin-bottom:14px;"></div>
      <div class="tm-driver-tags-scope">
        <input class="tm-gate-input" id="tm-place-modal-name" type="text" placeholder="Name this place…" autocomplete="off" maxlength="120" style="width:100%;" value="${esc(ps.selected.label || "")}">
        ${names.length ? `<div class="tm-stat-label" style="margin:12px 0 2px;">Whose place is this? <span style="font-weight:400;text-transform:none;letter-spacing:0;">(optional — leave blank to share)</span></div>${driverChipsHtml(names)}` : ""}
        ${ps.error ? `<div class="tm-suggest-error" style="margin-top:10px;">${esc(ps.error)}</div>` : ""}
        <div class="tm-flex-row" style="gap:14px;margin-top:16px;">
          <button class="tm-chip-btn" data-action="place-modal-save" data-lat="${ps.selected.lat}" data-lon="${ps.selected.lon}">Save</button>
          <button class="tm-link-btn" data-action="place-search-clear">✕ choose another</button>
        </div>
      </div>`;
  }

  return `
    <div class="tm-modal-head">
      <div><div class="tm-modal-title">Add a place</div><div class="tm-modal-sub">from a frequent stop, or search an address</div></div>
      ${closeBtn}
    </div>
    ${ps.suggestions.length ? `
      <div class="tm-stat-label" style="margin-bottom:6px;">Frequent stops</div>
      ${ps.suggestions.map((s, i) => `
        <div class="tm-table-row" data-action="place-suggestion-select" data-idx="${i}" style="grid-template-columns:1fr auto;">
          <div class="tm-ellipsis" style="font-size:13.5px;">${esc(s.label || "Unnamed spot")}</div>
          <span class="tm-pill tm-pill-chip" style="font-size:10.5px;">${fmt0(s.visits ?? 0)} visit${s.visits === 1 ? "" : "s"}</span>
        </div>`).join("")}
      <div style="border-top:1px solid var(--line2);margin:14px 0;"></div>
    ` : ""}
    <div class="tm-stat-label" style="margin-bottom:6px;">Search an address</div>
    <div class="tm-flex-row" style="gap:8px;">
      <input class="tm-gate-input" id="tm-place-search-input" type="text" placeholder="Address, place name…" autocomplete="off" maxlength="120" style="flex:1;">
      <button class="tm-chip-btn" data-action="place-search">Search</button>
    </div>
    ${ps.error ? `<div class="tm-suggest-error" style="margin-top:8px;">${esc(ps.error)}</div>` : ""}
    ${ps.results && ps.results.length ? `<div style="margin-top:10px;">${ps.results.map((r, i) => `
      <div class="tm-table-row" data-action="place-search-select" data-idx="${i}" style="grid-template-columns:1fr auto;">
        <div class="tm-ellipsis" style="font-size:13.5px;">${esc(r.label)}</div>
        <span class="tm-pill tm-pill-chip" style="font-size:10.5px;">${esc(r.source)}</span>
      </div>`).join("")}</div>` : ""}
    ${ps.results && ps.results.length === 0 ? `<div class="tm-stat-note" style="margin-top:8px;">No matches — try a fuller address.</div>` : ""}
  `;
}

/** Re-renders the already-open modal from current state (no data fetch — used after search/select/clear/error). */
function refreshAddPlaceModal() {
  openModal(addPlaceModalHtml());
  if (state.placeSearch.selected) {
    const { lat, lon, label } = state.placeSearch.selected;
    requestAnimationFrame(() => {
      renderPointMap(document.getElementById("tm-place-modal-map"), lat, lon, esc(label || ""));
      document.getElementById("tm-place-modal-name")?.select();
    });
  }
}

/** Opens the modal, fetching suggestions + the driver roster once. */
/** `preselected` (optional {label, lat, lon}) skips straight to the name/tag/save step — used by "Save this place" on Overview's current-location card. */
async function openAddPlaceModal(preselected = null) {
  state.placeSearch = { suggestions: [], roster: [], results: null, selected: preselected, error: null };
  openModal(addPlaceModalHtml()); // instant shell while the fetch is in flight
  const [suggestedRes, roster] = await Promise.all([
    preselected ? null : safe(cached("suggested_locations", () => data.suggestedLocations(vin())), null),
    loadDriverRoster(),
  ]);
  state.placeSearch.suggestions = suggestedRes?.suggestions || [];
  state.placeSearch.roster = roster;
  refreshAddPlaceModal();
}

async function renderPlaces() {
  if (state.openPlaceId != null) return renderPlaceDetail();
  const [locations, suggestedRes] = await Promise.all([
    safe(cached("locations", () => data.locations()), []),
    safe(cached("suggested_locations", () => data.suggestedLocations(vin())), null),
  ]);
  const suggestionCount = suggestedRes?.suggestions?.length || 0;

  setContent(`
    <div class="tm-flex-row" style="justify-content:space-between;flex-wrap:wrap;gap:10px;">
      <div style="font-size:12.5px;color:var(--sub);">${locations.length} saved place${locations.length === 1 ? "" : "s"}${suggestionCount ? ` · ${suggestionCount} frequent stop${suggestionCount === 1 ? "" : "s"} not yet named` : ""}</div>
      <button class="tm-chip-btn" data-action="open-add-place">+ Add a place</button>
    </div>
    ${locations.length ? `
    <div class="tm-card tm-table-wrap">
      <div style="min-width:560px;">
        <div class="tm-table-head" style="grid-template-columns:1fr 150px 96px;">
          <div>Name</div><div class="tm-right">Coordinates</div><div class="tm-right">Radius</div>
        </div>
        ${locations.map((l) => `
          <div class="tm-table-row" data-action="open-place" data-id="${l.id}" style="grid-template-columns:1fr 150px 96px;">
            <div style="min-width:0;">
              <div class="tm-ellipsis" style="font-size:13.5px;font-weight:500;">${esc(l.name)}</div>
              ${l.drivers?.length ? `<div style="margin-top:4px;">${l.drivers.map((d) => `<span class="tm-place-tag" style="margin-right:4px;">${esc(d)}</span>`).join("")}</div>` : ""}
            </div>
            <div class="tm-right tm-mono" style="color:var(--sub);font-size:12px;">${fmt1(l.lat)}, ${fmt1(l.lon)}</div>
            <div class="tm-right tm-mono" style="color:var(--sub);">${l.radius_m != null ? fmt0(l.radius_m) + " m" : "—"}</div>
          </div>`).join("")}
        <div class="tm-foot-note">${locations.length} saved place${locations.length === 1 ? "" : "s"} · click one for its stats.</div>
      </div>
    </div>` : emptyHtml("No saved places yet", suggestionCount ? "Add one of the frequent stops the car's already visited, or search an address." : "Add a place by address, or wait for a frequent-stop suggestion once a spot's been visited a few times.")}
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
  const roster = state.editingPlaceTags ? await loadDriverRoster() : [];
  const names = [...new Set(roster.map(rosterName).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  setContent(`
    <div class="tm-flex-row" style="gap:14px;flex-wrap:wrap;">
      <button class="tm-back-btn" data-action="back-places">← Places</button>
      <div style="font-size:15px;font-weight:600;">${esc(l.name)}</div>
      <div style="font-size:12.5px;color:var(--faint);">${fmt1(l.lat)}, ${fmt1(l.lon)} · ${l.radius_m != null ? fmt0(l.radius_m) + " m radius" : ""}</div>
    </div>
    <div class="tm-driver-tags-scope tm-flex-row" style="align-items:center;flex-wrap:wrap;gap:8px;margin-top:6px;">
      ${state.editingPlaceTags ? `
        ${names.length ? driverChipsHtml(names, l.drivers) : `<span style="font-size:12px;color:var(--faint);">No household drivers on the roster yet.</span>`}
        <button class="tm-chip-btn" style="padding:5px 12px;" data-action="save-place-tags" data-id="${l.id}">Save tags</button>
        <button class="tm-link-btn" data-action="cancel-place-tags">✕ cancel</button>
      ` : `
        ${l.drivers?.length ? l.drivers.map((d) => `<span class="tm-place-tag">${esc(d)}</span>`).join("") : `<span style="font-size:12px;color:var(--faint);">Shared — not tagged to a specific driver</span>`}
        <button class="tm-link-btn" data-action="edit-place-tags">edit tags</button>
      `}
    </div>
    <div class="tm-grid-2-wide" style="margin-top:14px;">
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
// Media — "most played" from Fleet Telemetry's MediaNowPlaying* fields
// ---------------------------------------------------------------------------

// Tesla exposes no cover art at all — this looks it up from Apple's free,
// unauthenticated iTunes Search API using the track/artist TEXT the car does
// report, purely for visual polish. Never persisted (in-memory only, one
// lookup per distinct title+artist per session); silently absent if the
// lookup fails or the environment blocks the request — same "enhance, don't
// depend on" posture as the rest of the app's optional network calls.
const COVER_ART_CACHE = new Map();
function fetchCoverArt(title, artist) {
  const key = `${title}|||${artist || ""}`;
  if (COVER_ART_CACHE.has(key)) return COVER_ART_CACHE.get(key);
  const p = (async () => {
    try {
      const term = encodeURIComponent([title, artist].filter(Boolean).join(" "));
      const res = await fetch(`https://itunes.apple.com/search?term=${term}&media=music&limit=1`);
      if (!res.ok) return null;
      const j = await res.json();
      return j?.results?.[0]?.artworkUrl100 || null;
    } catch { return null; }
  })();
  COVER_ART_CACHE.set(key, p);
  return p;
}
/** Fills a `.tm-media-cover` placeholder once the (async, non-blocking) art lookup resolves. */
function loadCoverInto(elId, title, artist) {
  if (!title) return;
  fetchCoverArt(title, artist).then((url) => {
    if (!url) return;
    const el = document.getElementById(elId);
    if (el) el.innerHTML = `<img src="${esc(url)}" alt="" loading="lazy">`;
  });
}

function nowPlayingCard(latest) {
  const title = latest?.media_title, artist = latest?.media_artist, album = latest?.media_album;
  const station = latest?.media_station, source = latest?.media_source, status = latest?.media_status;
  const volume = latest?.media_volume;
  if (!title && !station) {
    return `<div class="tm-card tm-card-pad-lg"><div class="tm-empty" style="padding:10px 0;">
      <div class="tm-empty-icon">♪</div>
      <div class="tm-empty-title">Nothing playing right now</div>
      <div>Shows up here the moment the car streams a Media* field and something's on.</div>
    </div></div>`;
  }
  const playing = typeof status === "string" && /playing/i.test(status);
  // Tesla reports a fixed 18,000,000 ms (5h) sentinel for radio/stations with
  // no real track length — a progress bar for that is meaningless, so only
  // show one for an actual, bounded track duration.
  const durationMs = latest?.media_duration_ms;
  const elapsedMs = latest?.media_elapsed_ms;
  const hasProgress = typeof durationMs === "number" && durationMs > 0 && durationMs !== 18_000_000
    && typeof elapsedMs === "number" && elapsedMs >= 0;
  const progressPct = hasProgress ? Math.min(100, (elapsedMs / durationMs) * 100) : 0;
  return `
    <div class="tm-card tm-card-pad-lg tm-flex-row" style="gap:16px;align-items:center;">
      <div class="tm-media-cover tm-media-cover-lg" id="tm-np-cover">♪</div>
      <div style="min-width:0;flex:1;">
        <div class="tm-flex-row" style="gap:8px;">
          <span class="tm-pill ${playing ? "tm-pill-good" : "tm-pill-chip"}">${playing ? "▶ Playing" : esc(status || "Now playing")}</span>
          ${source ? `<span class="tm-pill tm-pill-chip">${esc(source)}</span>` : ""}
        </div>
        <div class="tm-ellipsis" style="font-size:17px;font-weight:600;margin-top:8px;">${esc(title || station || "—")}</div>
        <div class="tm-ellipsis" style="font-size:13px;color:var(--sub);margin-top:2px;">${esc([artist, album].filter(Boolean).join(" · ") || (station ? "Radio" : ""))}</div>
        ${hasProgress ? `
        <div style="margin-top:10px;">
          <div class="tm-progress"><div class="tm-progress-fill" style="width:${progressPct.toFixed(1)}%;"></div></div>
          <div class="tm-flex-row" style="margin-top:4px;font-size:11px;color:var(--faint);">
            <span>${fmtClock(elapsedMs / 1000)}</span><span style="margin-left:auto;">${fmtClock(durationMs / 1000)}</span>
          </div>
        </div>` : ""}
      </div>
      ${volume != null ? `<div style="text-align:right;flex:none;"><div class="tm-readout-label">Volume</div><div class="tm-readout-value">${fmt0(volume)}</div></div>` : ""}
    </div>`;
}

/** Ranked list row for a leaderboard (tracks get cover art; artists/sources/stations don't). */
function mediaListHtml(rows, key, opts = {}) {
  if (!rows || !rows.length) return miniEmptyHtml("Nothing yet");
  return `<div class="tm-flex-col" style="gap:0;">${rows.map((r, i) => {
    const coverId = opts.cover ? `tm-cover-${key}-${i}` : null;
    return `
    <div class="tm-media-row">
      <span class="tm-media-rank">${i + 1}</span>
      ${coverId ? `<div class="tm-media-cover" id="${coverId}">♪</div>` : ""}
      <div class="tm-ellipsis" style="flex:1;min-width:0;font-size:13px;font-weight:500;">${esc(r[key])}</div>
      <span class="tm-mono" style="font-size:12px;color:var(--sub);white-space:nowrap;">${r.plays} play${r.plays === 1 ? "" : "s"}</span>
      ${r.minutes != null ? `<span class="tm-mono tm-right" style="font-size:12px;color:var(--faint);width:60px;">${fmt0(r.minutes)} min</span>` : ""}
    </div>`;
  }).join("")}</div>`;
}

async function renderMedia() {
  const [stats, latest] = await Promise.all([
    safe(cached("media", () => data.media(vin(), 90)), null),
    safe(cached("latest", () => data.latest(vin())), null),
  ]);

  if (!stats || stats.has_data === false) {
    return setContent(emptyHtml(
      "No media data yet",
      stats?.note || "Stream MediaNowPlayingTitle/MediaNowPlayingArtist/MediaPlaybackSource via configure_telemetry to start tracking what's played in the car.",
    ));
  }

  setContent(`
    ${nowPlayingCard(latest)}
    <div class="tm-grid-metrics">
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Plays · ${stats.days} days</div><div class="tm-stat-value">${fmt0(stats.total_plays)}</div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Listening time</div><div class="tm-stat-value">${fmt1(stats.total_listening_hours)} <span class="tm-stat-unit">h</span></div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Distinct tracks</div><div class="tm-stat-value">${fmt0(stats.top_tracks.length)}</div></div>
      <div class="tm-card tm-card-pad-metric"><div class="tm-stat-label">Distinct artists</div><div class="tm-stat-value">${fmt0(stats.top_artists.length)}</div></div>
    </div>
    <div class="tm-card tm-card-pad">
      <div class="tm-card-head"><div class="tm-card-head-title">Most played tracks</div><div class="tm-card-head-sub">by play count · last ${stats.days} days</div></div>
      ${mediaListHtml(stats.top_tracks, "title", { cover: true })}
    </div>
    <div class="tm-grid-2">
      <div class="tm-card tm-card-pad">
        <div class="tm-card-head"><div class="tm-card-head-title">Top artists</div></div>
        ${mediaListHtml(stats.top_artists, "artist")}
      </div>
      <div class="tm-card tm-card-pad">
        <div class="tm-card-head"><div class="tm-card-head-title">Top sources</div></div>
        ${mediaListHtml(stats.top_sources, "source")}
      </div>
    </div>
    ${stats.top_stations.length ? `
    <div class="tm-card tm-card-pad">
      <div class="tm-card-head"><div class="tm-card-head-title">Top stations</div></div>
      ${mediaListHtml(stats.top_stations, "station")}
    </div>` : ""}
    ${stats.traffic_mood && (stats.traffic_mood.heavy.length || stats.traffic_mood.light.length) ? `
    <div class="tm-card tm-card-pad">
      <div class="tm-card-head"><div class="tm-card-head-title">Traffic mood</div><div class="tm-card-head-sub">what's playing when traffic bites vs. when the road's clear</div></div>
      <div class="tm-grid-2">
        <div><div class="tm-stat-label" style="margin-bottom:8px;color:var(--warn);">Heavy traffic (10+ min delay)</div>${mediaListHtml(stats.traffic_mood.heavy, "title")}</div>
        <div><div class="tm-stat-label" style="margin-bottom:8px;color:var(--good);">Clear roads (≤5 min delay)</div>${mediaListHtml(stats.traffic_mood.light, "title")}</div>
      </div>
    </div>` : ""}
    <div id="tm-media-by-driver"></div>
  `);

  // Cover art loads in after first paint — an external lookup must never block render.
  if (latest?.media_title) loadCoverInto("tm-np-cover", latest.media_title, latest.media_artist);
  stats.top_tracks.forEach((r, i) => loadCoverInto(`tm-cover-title-${i}`, r.title, null));

  renderMediaByDriver();
}

/** Fills #tm-media-by-driver in place once the per-driver breakdown loads (skips silently if there's nothing to add). */
async function renderMediaByDriver() {
  const byDriver = await safe(cached("media_by_driver", () => data.mediaByDriver(vin(), 90)), null);
  const target = document.getElementById("tm-media-by-driver"); // re-check: user may have navigated away while this loaded
  if (!target || !byDriver || byDriver.has_data === false || !byDriver.drivers?.length) return;
  if (!state.mediaDriverFilter || !byDriver.drivers.some((d) => d.driver === state.mediaDriverFilter)) {
    state.mediaDriverFilter = byDriver.drivers[0].driver;
  }
  target.innerHTML = mediaByDriverHtml(byDriver.drivers);
}

function mediaByDriverHtml(drivers) {
  const active = drivers.find((d) => d.driver === state.mediaDriverFilter) || drivers[0];
  return `
    <div class="tm-card tm-card-pad">
      <div class="tm-card-head"><div class="tm-card-head-title">Most played by driver</div><div class="tm-card-head-sub">who listens to what</div></div>
      <div class="tm-flex-row" style="gap:8px;flex-wrap:wrap;margin-bottom:14px;">
        ${drivers.map((d) => `<button class="tm-chip-btn ${d.driver === active.driver ? "active" : ""}" data-action="media-driver-filter" data-driver="${esc(d.driver)}">${esc(d.driver)}<span class="n">${d.total_plays}</span></button>`).join("")}
      </div>
      <div class="tm-grid-2">
        <div><div class="tm-stat-label" style="margin-bottom:8px;">Top tracks</div>${mediaListHtml(active.top_tracks, "title")}</div>
        <div><div class="tm-stat-label" style="margin-bottom:8px;">Top artists</div>${mediaListHtml(active.top_artists, "artist")}</div>
      </div>
    </div>`;
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
            <div class="tm-right tm-mono" style="color:var(--sub);">${c.start_soc != null && c.end_soc != null ? `${fmt0(c.start_soc)} → ${fmt0(c.end_soc)}` : "—"} %</div>
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
      <div class="tm-card" style="padding:18px 20px;"><div class="tm-stat-label">Battery</div><div style="font-size:19px;font-weight:600;margin-top:5px;" class="tm-mono">${c.start_soc != null && c.end_soc != null ? `${fmt0(c.start_soc)} → ${fmt0(c.end_soc)}` : "—"} %</div></div>
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
      }) : miniEmptyHtml("No power samples recorded for this session")}
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Charging stats
// ---------------------------------------------------------------------------

/** Lifetime charging power-delivery curve (avg/peak kW per 5% SoC bin) — idea #51: the taper profile across every session, not just one. */
function chargeTaperCard(taper) {
  const bins = taper?.bins || [];
  const pts = bins.map((b) => [(b.soc_min + b.soc_max) / 2, b.avg_power_kw]);
  return `
    <div class="tm-card tm-card-pad">
      <div class="tm-card-head">
        <div class="tm-card-head-title">Charging taper curve</div>
        <div class="tm-card-head-sub">lifetime avg power by state of charge</div>
      </div>
      ${pts.length >= 2 ? svgLineChart({
        series: [{
          points: pts,
          markers: true,
          titles: bins.map((b) => `${b.soc_min}–${b.soc_max}% · avg ${fmt0(b.avg_power_kw)} kW · peak ${fmt0(b.max_power_kw)} kW · ${b.samples} samples`),
        }],
        yTicks: autoTicks(pts.map((p) => p[1]), 4),
        xTicks: pts.map((p) => ({ value: p[0], label: `${fmt0(p[0])}%` })),
      }) : miniEmptyHtml(taper?.note || "Not enough charge sessions yet to draw a taper curve.")}
    </div>`;
}

async function renderChargingStats() {
  const charges = await cached("all_charges", () => data.chargeSessions(vin(), 2000));
  const locations = await safe(cached("locations", () => data.locations()), []);
  const taper = await safe(cached("charge_taper", () => data.chargeTaperCurve(vin())), null);
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
        <div class="tm-card-head">
          <div class="tm-card-head-title">Energy charged</div>
          <div class="tm-card-head-sub">kWh per month</div>
        </div>
        ${months.length ? svgBarChart({ bars: months.map((m) => ({ label: m.m, value: m.kwh })) }) : miniEmptyHtml("No monthly data yet")}
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
          <div class="tm-bar-row">
            <div class="tm-ellipsis" style="font-size:13px;font-weight:500;">${esc(l.name)}</div>
            <div class="tm-bar-track"><div class="tm-bar-fill" style="width:${((l.kwh / maxLocKwh) * 100).toFixed(1)}%;"></div></div>
            <div class="tm-mono tm-right" style="font-size:12.5px;">${fmt0(l.kwh)} kWh</div>
            <div class="tm-right" style="font-size:12px;color:var(--faint);">${l.n} sessions</div>
          </div>`).join("")}
      </div>
    </div>
    ${chargeTaperCard(taper)}
  `);
}

// ---------------------------------------------------------------------------
// Battery health
// ---------------------------------------------------------------------------

async function renderBatteryHealth() {
  const deg = await cached("degradation", () => data.degradation(vin()));
  const summary = await cached("summary", () => data.summary(vin()));

  if (!deg.series?.length || deg.degradation_pct == null) {
    return setContent(emptyHtml("Not enough data yet", deg.note || "Battery health tracking needs at least two charges that ended above 50% — check back after a couple more, and the trend will start filling in."));
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
      <div class="tm-card-head">
        <div class="tm-card-head-title">Projected range @ 100%</div>
        <div class="tm-card-head-sub">km vs time, from completed charges</div>
      </div>
      ${pts.length > 1 ? svgLineChart({
        series: [{ points: pts, area: true }],
        yTicks: autoTicks(pts.map((p) => p[1]), 4),
        xTicks: [pts[0], pts[pts.length - 1]].map((p) => ({ value: p[0], label: new Date(p[0] * 1000).toLocaleDateString(undefined, { month: "short", year: "2-digit" }) })),
      }) : miniEmptyHtml("Need more charge sessions to plot a trend")}
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
// Battery timeline
// ---------------------------------------------------------------------------

const BATTERY_TIMELINE_RANGES = [["24 hours", 24], ["7 days", 24 * 7], ["30 days", 24 * 30]];
const STAGE_COLOR = { driving: "var(--accent)", charging: "var(--good)", connected: "var(--warn)", resting: "var(--faint)" };
const STAGE_LABEL = { driving: "Driving", charging: "Charging", connected: "Connected (not charging)", resting: "Resting" };
const STAGE_ORDER = ["driving", "charging", "connected", "resting"];

/** Colored strip under the SoC chart showing which stage was active when, time-positioned like the chart above it. */
function batteryStageStripHtml(segments, x0, x1) {
  if (!segments?.length || x1 <= x0) return "";
  const segs = segments.map((seg) => {
    const left = ((seg.start_ts - x0) / (x1 - x0)) * 100;
    const width = Math.max(0.4, ((Math.max(seg.end_ts, seg.start_ts) - seg.start_ts) / (x1 - x0)) * 100);
    return `<div class="tm-stage-seg" style="left:${left}%;width:${width}%;background:${STAGE_COLOR[seg.stage] || "var(--faint)"};" title="${esc(STAGE_LABEL[seg.stage] || seg.stage)}"></div>`;
  }).join("");
  return `<div class="tm-stage-strip">${segs}</div>`;
}

function batteryStageLegendHtml(stageHours) {
  return `<div class="tm-flex-row" style="gap:16px;flex-wrap:wrap;margin-top:12px;">
    ${STAGE_ORDER.map((k) => `
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--sub);">
        <span style="width:9px;height:9px;border-radius:2px;background:${STAGE_COLOR[k]};flex:none;"></span>
        ${esc(STAGE_LABEL[k])} · ${fmt1(stageHours?.[k] ?? 0)}h
      </div>`).join("")}
  </div>`;
}

async function renderBatteryTimeline() {
  const hours = BATTERY_TIMELINE_RANGES[state.batteryTimelineRange][1];
  const tl = await safe(cached(`battery_timeline:${hours}`, () => data.batteryTimeline(vin(), hours)), null);

  const rangeChips = `<div class="tm-flex-row" style="gap:8px;flex-wrap:wrap;">
    <button class="tm-back-btn" data-action="nav" data-screen="ov">&larr; Overview</button>
    ${BATTERY_TIMELINE_RANGES.map(([label], i) => `
      <button class="tm-chip-btn ${state.batteryTimelineRange === i ? "active" : ""}" data-action="battery-timeline-range" data-range="${i}">${esc(label)}</button>
    `).join("")}
  </div>`;

  if (!tl?.points?.length) {
    return setContent(`${rangeChips}${emptyHtml("No battery data in this window", "Give the car some time to log driving/charging samples, or pick a wider range.")}`);
  }

  const socPts = tl.points.map((p) => [p.ts, p.soc]);
  const x0 = tl.points[0].ts, x1 = tl.points[tl.points.length - 1].ts;

  setContent(`
    ${rangeChips}
    <div class="tm-card tm-card-pad" style="margin-top:14px;">
      <div class="tm-card-head">
        <div class="tm-card-head-title">Battery level</div>
        <div class="tm-card-head-sub">${esc(BATTERY_TIMELINE_RANGES[state.batteryTimelineRange][0])}</div>
      </div>
      ${socPts.length > 1 ? svgLineChart({
        series: [{ points: socPts, area: true }],
        yTicks: [0, 25, 50, 75, 100].map((v) => ({ value: v, label: String(v) })),
        xTicks: buildDayTicks(socPts),
        yDomain: [0, 100],
      }) : miniEmptyHtml("Not enough samples yet to plot a line")}
      ${batteryStageStripHtml(tl.segments, x0, x1)}
      ${batteryStageLegendHtml(tl.stage_hours)}
    </div>
  `);
}

// ---------------------------------------------------------------------------
// Telemetry fields — every attribute from fleet_streaming_fields.csv, with
// what this car is actually sending (vendored CSV + /data/telemetry-fields).
// ---------------------------------------------------------------------------

/** Minimal quoted-CSV parser (commas inside quotes, doubled-quote escapes). Returns array of rows. */
function parseCsv(text) {
  const out = [];
  let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.length > 1 || row[0] !== "") out.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  return out;
}

function fmtAgo(ts) {
  if (ts == null) return "—";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return fmtDay(ts);
}

function fmtTfValue(v) {
  if (v == null) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return String(v);
}

const TF_COLS = "190px 92px 150px 96px minmax(280px,1fr)";

function tfRowsHtml(rows, status) {
  const q = state.tfQuery.trim().toLowerCase();
  const visible = rows.filter((r) =>
    (state.tfCat === "__all" || r.category === state.tfCat) &&
    (!q || r.field.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)));
  if (!visible.length) return `<div class="tm-empty" style="padding:20px 22px;">No fields match.</div>`;
  return visible.map((r) => {
    const st = status.get(r.field);
    const mapped = !!st;
    const seen = mapped && st.value != null;
    return `
      <div class="tm-table-row no-click" style="grid-template-columns:${TF_COLS};${mapped ? "" : "opacity:0.5;"}">
        <div class="tm-mono tm-ellipsis" style="font-size:12px;" title="${esc(r.field)}${mapped ? ` → ${esc(st.canonical)}` : ""}">${esc(r.field)}</div>
        <div><span class="tm-pill tm-pill-chip" style="font-size:10px;">${esc(r.category || "—")}</span></div>
        <div class="tm-mono tm-ellipsis" style="${seen ? "" : "color:var(--faint);"}" title="${esc(fmtTfValue(st?.value))}">${seen ? esc(fmtTfValue(st.value)) : mapped ? "—" : "not tracked"}</div>
        <div class="tm-mono" style="font-size:11.5px;color:var(--sub);">${mapped ? esc(fmtAgo(st.last_seen)) : "—"}</div>
        <div style="font-size:12px;color:var(--sub);white-space:normal;">${esc(r.description)}${mapped ? "" : ` <span style="color:var(--faint);">(deliberately unmapped: diagnostics/Semi-only/static config)</span>`}</div>
      </div>`;
  }).join("");
}

async function renderTelemetryFields() {
  const [csvText, statusRes] = await Promise.all([
    cached("tf_csv", () => fetch("./fleet_streaming_fields.csv").then((r) => {
      if (!r.ok) throw new Error("couldn't load fleet_streaming_fields.csv");
      return r.text();
    })),
    safe(cached("tf_status", () => data.telemetryFields(vin())), null),
  ]);
  const parsed = parseCsv(csvText);
  const rows = parsed.slice(1).map((r) => ({
    field: r[0] || "", category: r[1] || "", type: r[2] || "",
    vehicleDataEquivalent: r[3] || "", description: r[4] || "",
  })).filter((r) => r.field);
  const status = new Map((statusRes?.fields ?? []).map((f) => [f.tesla, f]));
  const cats = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  if (state.tfCat !== "__all" && !cats.includes(state.tfCat)) state.tfCat = "__all";
  const seenCount = rows.filter((r) => status.get(r.field)?.value != null).length;
  const mappedCount = rows.filter((r) => status.has(r.field)).length;

  setContent(`
    <div class="tm-flex-row" style="gap:8px;flex-wrap:wrap;">
      <button class="tm-chip-btn ${state.tfCat === "__all" ? "active" : ""}" data-action="tf-cat" data-cat="__all">All<span class="n">${rows.length}</span></button>
      ${cats.map((c) => `<button class="tm-chip-btn ${state.tfCat === c ? "active" : ""}" data-action="tf-cat" data-cat="${esc(c)}">${esc(c)}<span class="n">${rows.filter((r) => r.category === c).length}</span></button>`).join("")}
      <input class="tm-gate-input" id="tm-tf-search" type="search" placeholder="Search fields…" autocomplete="off" value="${esc(state.tfQuery)}" style="margin-left:auto;width:200px;padding:6px 12px;font-size:12.5px;">
    </div>
    <div style="font-size:12.5px;color:var(--sub);">${seenCount} of ${rows.length} fields received on this car · ${mappedCount} mapped by the worker${statusRes ? "" : ` · <span style="color:var(--warn);">live values unavailable — the deployed worker doesn't have /data/telemetry-fields yet (redeploy it)</span>`}</div>
    <div class="tm-card tm-table-wrap">
      <div style="min-width:900px;">
        <div class="tm-table-head" style="grid-template-columns:${TF_COLS};">
          <div>Field</div><div>Category</div><div>Latest value</div><div>Last seen</div><div>Description</div>
        </div>
        <div id="tm-tf-rows">${tfRowsHtml(rows, status)}</div>
        <div class="tm-foot-note">Straight from Tesla's fleet_streaming_fields reference — dimmed rows are fields the worker deliberately doesn't record. Values refresh on reload (this reads already-stored data, free).</div>
      </div>
    </div>
  `);

  const search = document.getElementById("tm-tf-search");
  if (search) {
    search.addEventListener("input", () => {
      state.tfQuery = search.value;
      const body = document.getElementById("tm-tf-rows");
      if (body) body.innerHTML = tfRowsHtml(rows, status);
    });
  }
}

// ---------------------------------------------------------------------------
// Vampire drain
// ---------------------------------------------------------------------------

async function renderVampireDrain() {
  const [v, sentryLog] = await Promise.all([
    cached("vampire", () => data.vampire(vin(), 30)),
    safe(cached("sentry_log", () => data.sentryLog(vin(), 30)), null),
  ]);
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
    ${sentryLogCard(sentryLog)}
  `);
}
function fmt3(n) { return n == null ? "—" : (Math.round(n * 1000) / 1000).toString(); }

/**
 * Sentry Mode event log. Works whichever way the account streams SentryMode:
 * boolean-only (armed hours, no events, with a note explaining why) or the
 * full Idle/Aware/Panic enum (armed hours + an actual trigger-event list with
 * location). `enum_available` is what tells the two apart.
 */
function sentryLogCard(s) {
  if (!s || s.has_data === false) return "";
  return `
    <div class="tm-card tm-card-pad">
      <div class="tm-card-head"><div class="tm-card-head-title">Sentry Mode</div><div class="tm-card-head-sub">last ${s.days} days${s.enum_available ? " · full event detection" : " · on/off only"}</div></div>
      <div class="tm-grid-half" style="gap:14px;">
        <div><div class="tm-readout-label">Armed</div><div class="tm-readout-value">${fmt1(s.armed_hours)} <span class="tm-stat-unit">h</span></div></div>
        <div><div class="tm-readout-label">Trigger events</div><div class="tm-readout-value" style="${s.panic_count > 0 ? "color:var(--warn);" : ""}">${s.event_count}${s.panic_count > 0 ? ` <span class="tm-stat-unit">(${s.panic_count} panic)</span>` : ""}</div></div>
      </div>
      ${s.note ? `<div class="tm-stat-note" style="margin-top:12px;">${esc(s.note)}</div>` : ""}
      ${s.events && s.events.length ? `
      <div class="tm-table-wrap" style="margin-top:14px;border-top:1px solid var(--border);">
        <div style="min-width:420px;">
          <div class="tm-table-head" style="grid-template-columns:1fr 90px 1fr;">
            <div>When</div><div>Transition</div><div>Location</div>
          </div>
          ${s.events.map((e) => `
            <div class="tm-table-row no-click" style="grid-template-columns:1fr 90px 1fr;">
              <div style="font-size:12.5px;color:var(--sub);">${fmtDateTime(e.ts)}</div>
              <div class="tm-mono" style="${e.to === "panic" ? "color:var(--warn);" : ""}">${esc(e.from)} → ${esc(e.to)}</div>
              <div class="tm-mono" style="color:var(--sub);font-size:12.5px;">${e.lat != null ? `${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}` : "—"}</div>
            </div>`).join("")}
        </div>
      </div>` : ""}
    </div>`;
}

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

const DRIVER_MANUAL_NOTE = "Tesla exposes no way to know who's driving — the system assigns a driver itself when confident (place/time/climate patterns), otherwise it suggests one for you to confirm. You can always correct it below.";

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
    ${row("Battery", `${d.start_soc != null && d.end_soc != null ? `${fmt0(d.start_soc)} → ${fmt0(d.end_soc)}` : "—"} %`)}
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
      ${miniEmptyHtml(f?.note || "Not enough data yet — the degradation forecast needs a run of charge sessions before it can project a slope. Check back once more charges are logged, or once the forecast endpoint is deployed.")}
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
        <div id="tm-forecast-chart">${f.projected_pct?.length > 1 ? "" : miniEmptyHtml("No projection points yet")}</div>
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
      ${model && !ready ? miniEmptyHtml(model?.note || "Not enough data yet — the range model needs more completed drives before it can predict. Keep driving (and logging) and this fills in.") : ""}
      ${!model ? miniEmptyHtml("The range-prediction endpoint isn't available on this worker yet — it hasn't been deployed. Once it is, enter a trip below to estimate energy use.") : ""}
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
