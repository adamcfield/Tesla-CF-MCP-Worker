/**
 * Dependency-free SVG chart primitives, generalized from the design mockup's
 * chart()/monthBars()/battery-ring math to work over real (possibly sparse or
 * empty) data instead of fixed mock arrays.
 */

function scale(points, { w, h, l = 46, r = 12, t = 12, b = 26, x0, x1, y0, y1 }) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const X0 = x0 ?? Math.min(...xs);
  const X1 = x1 ?? Math.max(...xs);
  const Y0 = y0 ?? Math.min(...ys);
  const Y1 = y1 ?? Math.max(...ys);
  const X = (v) => +(l + ((v - X0) / ((X1 - X0) || 1)) * (w - l - r)).toFixed(1);
  const Y = (v) => +(t + (1 - (v - Y0) / ((Y1 - Y0) || 1)) * (h - t - b)).toFixed(1);
  return { X, Y, X0, X1, Y0, Y1, bottom: h - b, left: l, right: w - r };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");

// ---------------------------------------------------------------------------
// Hover tooltips (#35): every svgLineChart registers its data + scale here;
// one document-level listener maps the mouse to the nearest data point and
// positions a single shared tooltip element. Registry is capped — charts from
// screens navigated away from age out instead of accumulating.
// ---------------------------------------------------------------------------

let chartSeq = 0;
const CHART_REGISTRY = new Map();
const REGISTRY_CAP = 48;

function registerChart(meta) {
  const id = `tmch${++chartSeq}`;
  CHART_REGISTRY.set(id, meta);
  if (CHART_REGISTRY.size > REGISTRY_CAP) CHART_REGISTRY.delete(CHART_REGISTRY.keys().next().value);
  return id;
}

let tipEl = null;
function tip() {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "tm-chart-tip";
    tipEl.style.display = "none";
    // [data-tm-root] is where every theme color variable (--card, --text, ...)
    // is scoped; this element lives outside that subtree (a permanent
    // document.body child so it survives screen re-renders), so it needs the
    // same attribute on ITSELF to resolve those variables — otherwise
    // `background: var(--card)` falls back to transparent and chart lines
    // show straight through the tooltip text.
    // .tm-root-plain is the SAME escape hatch the login gate uses (styles.css)
    // to get the color variables WITHOUT the app-shell layout rule
    // ([data-tm-root] alone also sets display:flex/width:100%/height:100vh/
    // overflow:hidden) -- without it the tooltip becomes a full-viewport box.
    tipEl.setAttribute("data-tm-root", "1");
    tipEl.classList.add("tm-root-plain");
    document.body.appendChild(tipEl);
  }
  // Keep in sync with the live theme (it can toggle after the tooltip was
  // first created, and the real root is the source of truth for it).
  const liveTheme = document.querySelector("[data-tm-root]")?.getAttribute("data-theme");
  if (liveTheme) tipEl.setAttribute("data-theme", liveTheme);
  return tipEl;
}

/** Nearest index by x in an x-ascending [[x,y],...] array. */
function nearestIdx(pts, x) {
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][0] < x) lo = mid; else hi = mid;
  }
  return x - pts[lo][0] <= pts[hi][0] - x ? lo : hi;
}

function fmtTipX(x) {
  if (x > 1e9) { // epoch seconds → local day + time
    return new Date(x * 1000).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return String(Math.round(x * 100) / 100);
}

function fmtTipY(y) {
  return typeof y === "number" ? String(Math.round(y * 100) / 100) : String(y);
}

// Click-driven re-renders (e.g. cycling a strip segment's zoom level) replace
// the chart DOM without the mouse itself moving, so the real `mousemove`
// event that would normally refresh the tooltip never fires -- it's left
// showing whatever it had right before the click. `updateTooltip` is the
// shared body both the live listener AND `refreshChartTooltip` (called after
// a re-render, replaying the last known cursor position) drive, so the
// tooltip always reflects what's actually under the cursor right now.
let lastMouse = null;

function updateTooltip(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const svg = el?.closest?.("svg[data-tmchart]");
  const t = tip();
  const meta = svg ? CHART_REGISTRY.get(svg.dataset.tmchart) : null;
  if (!meta) { t.style.display = "none"; return; }

  // Map client position into viewBox units (the SVG scales uniformly, width-driven).
  const rect = svg.getBoundingClientRect();
  const svgX = ((clientX - rect.left) / rect.width) * meta.width;
  const frac = (svgX - meta.left) / (meta.right - meta.left);
  if (frac < -0.02 || frac > 1.02) { t.style.display = "none"; return; }

  // `pc` (the matched warp piece) is the SAME piece used to draw the state
  // strip at this x — reused below for the state row and the dedicated
  // strip-hover tooltip so both always agree with what's visually under the
  // cursor, instead of an independent time-based segment search that can
  // disagree in a densely-packed region.
  let dataX, pc = null;
  if (meta.warpPieces?.length) {
    const px = Math.max(meta.left, Math.min(meta.right, svgX));
    pc = meta.warpPieces.find((p) => px >= p.x0 && px <= p.x1) || meta.warpPieces[meta.warpPieces.length - 1];
    dataX = pc.t0 + ((px - pc.x0) / ((pc.x1 - pc.x0) || 1)) * (pc.t1 - pc.t0);
  } else {
    dataX = meta.X0 + Math.max(0, Math.min(1, frac)) * (meta.X1 - meta.X0);
  }

  // Hovering the state strip itself (Chart explorer): a focused phase +
  // duration readout instead of the full signal breakdown -- "so it will be
  // easy to understand the non-linear axis". Also explains what the NEXT
  // click will do in concrete resolution terms (derived per-segment from its
  // own duration/pixel share, not a fixed value) -- "hovering the state bar
  // should explain what is going to happen next click".
  if (meta.stripY != null && meta.height) {
    const svgY = ((clientY - rect.top) / rect.height) * meta.height;
    if (svgY >= meta.stripY - 2 && svgY <= meta.stripY + meta.stripH + 2 && pc) {
      t.innerHTML = `<div class="tm-chart-tip-x">${esc(fmtTipX(dataX))}</div>`
        + `<div class="tm-chart-tip-row"><span class="tm-chart-tip-dot" style="background:${meta.stageColor?.[pc.stage] || "var(--faint)"};"></span><strong>${esc(pc.label || pc.stage || "No data")}</strong></div>`
        + (pc.nextHint ? `<div class="tm-chart-tip-row" style="color:var(--sub);font-size:10.5px;">${esc(pc.nextHint)}</div>` : "");
      t.style.display = "block";
      const tw = t.offsetWidth || 120;
      const x = clientX + 14 + tw > window.innerWidth ? clientX - tw - 12 : clientX + 14;
      t.style.left = `${x}px`;
      t.style.top = `${Math.max(4, clientY - t.offsetHeight - 10)}px`;
      return;
    }
  }

  const lines = meta.series
    .filter((sr) => sr.points.length)
    .map((sr) => {
      const p = sr.points[nearestIdx(sr.points, dataX)];
      return { name: sr.name, unit: sr.unit, color: sr.color || "var(--accent)", x: p[0], y: p[1] };
    });
  if (!lines.length) { t.style.display = "none"; return; }

  // Car-state row (Chart explorer): the SAME piece (`pc`) drives this, so it
  // can never disagree with the strip segment actually under the cursor.
  let stateRow = "";
  if (meta.segments?.length && pc) {
    stateRow = `<div class="tm-chart-tip-row"><span class="tm-chart-tip-dot" style="background:${meta.stageColor?.[pc.stage] || "var(--faint)"};"></span><strong>${esc(pc.label || pc.stage || "No data")}</strong></div>`;
  }

  // Event markers directly under the cursor — PIXEL proximity to where each
  // marker dot is actually drawn, not time proximity. Time-based "nearby"
  // breaks under the smart (warped) axis: 1.5% of a 24h window is ~20
  // minutes, which on a stretched driving segment can span hundreds of
  // pixels — several unrelated events would all show up on every hover.
  let markerRows = "";
  if (meta.markers?.length) {
    const markerPx = (ts) => {
      if (!meta.warpPieces?.length) return meta.left + ((ts - meta.X0) / ((meta.X1 - meta.X0) || 1)) * (meta.right - meta.left);
      const p = meta.warpPieces.find((mp) => ts >= mp.t0 && ts <= mp.t1) || meta.warpPieces[meta.warpPieces.length - 1];
      return p.x0 + ((ts - p.t0) / ((p.t1 - p.t0) || 1)) * (p.x1 - p.x0);
    };
    const NEAR_PX = 8; // ~the drawn marker circle's radius + a little hover slop
    markerRows = meta.markers
      .filter((m) => Math.abs(markerPx(m.ts) - svgX) <= NEAR_PX)
      .slice(0, 3)
      .map((m) => `<div class="tm-chart-tip-row"><span class="tm-chart-tip-dot" style="background:${meta.markerColor?.[m.kind] || "var(--warn)"};"></span>${esc(m.label)}</div>`)
      .join("");
  }

  t.innerHTML = `<div class="tm-chart-tip-x">${esc(fmtTipX(lines[0].x))}</div>` + stateRow + lines
    .map((l) => `<div class="tm-chart-tip-row"><span class="tm-chart-tip-dot" style="background:${l.color};"></span>${l.name ? esc(l.name) + ": " : ""}<strong>${esc(fmtTipY(l.y))}${l.unit ? " " + esc(l.unit) : ""}</strong></div>`)
    .join("") + markerRows;
  t.style.display = "block";
  // Keep the tooltip inside the viewport: flip to the left of the cursor near the right edge.
  const tw = t.offsetWidth || 120;
  const x = clientX + 14 + tw > window.innerWidth ? clientX - tw - 12 : clientX + 14;
  t.style.left = `${x}px`;
  t.style.top = `${Math.max(4, clientY - t.offsetHeight - 10)}px`;
}

document.addEventListener("mousemove", (ev) => {
  lastMouse = { x: ev.clientX, y: ev.clientY };
  updateTooltip(ev.clientX, ev.clientY);
});

/**
 * Re-evaluates the tooltip at the last known cursor position. Needed after
 * any click that re-renders the chart DOM in place (e.g. cycling a strip
 * segment's zoom level) -- the cursor hasn't moved, so no new `mousemove`
 * fires on its own, and without this the tooltip is left showing whatever
 * it had right before the click.
 */
export function refreshChartTooltip() {
  if (lastMouse) updateTooltip(lastMouse.x, lastMouse.y);
}

/**
 * Multi-series line/area chart. `series`: [{points:[[x,y],...], color, dashed, area}]
 * `yTicks`/`xTicks`: [{value, label}] in DATA units (mapped through the shared scale).
 */
export function svgLineChart({ width = 760, height = 210, series, yTicks = [], xTicks = [], yDomain, xDomain }) {
  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length === 0) return "";
  const sc = scale(allPoints, {
    w: width, h: height,
    x0: xDomain?.[0], x1: xDomain?.[1],
    y0: yDomain?.[0], y1: yDomain?.[1],
  });

  const grid = yTicks
    .map((t) => {
      const y = sc.Y(t.value);
      return `<line x1="${sc.left}" x2="${sc.right + (width - sc.right - 12)}" y1="${y}" y2="${y}" style="stroke:var(--line2); stroke-width:1;"></line>
        <text x="${sc.left - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" style="font:10.5px var(--mono); fill:var(--faint);">${esc(t.label)}</text>`;
    })
    .join("");

  const xLabels = xTicks
    .map((t) => `<text x="${sc.X(t.value)}" y="${height - 6}" text-anchor="middle" style="font:10.5px var(--mono); fill:var(--faint);">${esc(t.label)}</text>`)
    .join("");

  const seriesMarkup = series
    .map((s) => {
      const pts = s.points.map((p) => `${sc.X(p[0])},${sc.Y(p[1])}`).join(" ");
      const color = s.color || "var(--accent)";
      let out = "";
      if (s.area) {
        const first = s.points[0], last = s.points[s.points.length - 1];
        const areaPts = `${sc.X(first[0])},${sc.bottom} ${pts} ${sc.X(last[0])},${sc.bottom}`;
        out += `<polygon points="${areaPts}" style="fill:color-mix(in oklab, ${color} 9%, transparent);"></polygon>`;
      }
      out += `<polyline points="${pts}" style="fill:none; stroke:${color}; stroke-width:${s.width || 2}; stroke-linejoin:round; stroke-linecap:round;${s.dashed ? " stroke-dasharray:5 4;" : ""}"></polyline>`;
      if (s.markers) {
        // Point markers (scatter-over-line), with optional per-point hover titles.
        out += s.points
          .map((p, i) => `<circle cx="${sc.X(p[0])}" cy="${sc.Y(p[1])}" r="3.5" style="fill:${color}; stroke:var(--card); stroke-width:1.5;">${s.titles?.[i] ? `<title>${esc(s.titles[i])}</title>` : ""}</circle>`)
          .join("");
      }
      return out;
    })
    .join("");

  const chartId = registerChart({
    width, X0: sc.X0, X1: sc.X1, left: sc.left, right: sc.right,
    series: series.map((s) => ({ name: s.name, color: s.color, points: s.points })),
  });
  return `<svg viewBox="0 0 ${width} ${height}" class="tm-svg-block" data-tmchart="${chartId}">${grid}${xLabels}${seriesMarkup}</svg>`;
}

/**
 * Chart-explorer overlay: N signals with WILDLY different scales (km/h, %, °C,
 * kW…) drawn together by normalizing each to its own min-max band — the
 * tooltip carries the real values + units, so the chart shows shape and the
 * hover shows numbers. Adds an event-marker band on top (harsh brake/accel,
 * track changes, warnings) and a car-state strip along the bottom
 * (driving/charging/connected/resting), both of which also feed the tooltip.
 *
 * `series`: [{key, name, unit, color, dashed, points:[[ts,v],...]}]
 * `segments`/`markers`: as returned by /data/timeline-chart.
 * `stageColor`/`stageLabel`/`markerColor`: display maps owned by the caller.
 */
export function svgTimelineExplorer({
  width = 760, height = 320,
  series = [], segments = [], markers = [],
  stageColor = {}, stageLabel = {}, markerColor = {},
  xDomain,
  // Smart (non-linear) axis: per-stage horizontal weight factors + per-segment
  // user overrides ({[start_ts]: multiplier}). A driving minute gets ~16x the
  // width of a charging/resting minute by default, so drives are readable and
  // an overnight charge compresses to a sliver — visible, never hidden.
  warp = null,
}) {
  const drawable = series.filter((s) => s.points.length > 1);
  if (!drawable.length && !segments.length) return "";

  const l = 14, r = 14;
  const markerBandY = 14;      // marker dots
  const t = 30;                // plot top (below the marker band)
  const stripH = 12;           // state strip height
  const xLabelH = 18;
  const bottom = height - xLabelH - stripH - 6; // plot bottom
  const stripY = bottom + 4;
  const plotL = l, plotR = width - r, plotW = plotR - plotL;

  // Shared x domain across everything visible.
  const allX = [
    ...drawable.flatMap((s) => [s.points[0][0], s.points[s.points.length - 1][0]]),
    ...segments.flatMap((s) => [s.start_ts, s.end_ts]),
    ...markers.map((m) => m.ts),
  ];
  const X0 = xDomain?.[0] ?? Math.min(...allX);
  const X1 = xDomain?.[1] ?? Math.max(...allX);

  // ---- Piecewise time->px mapping ("smart axis") --------------------------
  // Tile [X0,X1] with the stage segments (gaps between/around them become
  // weight-1 tiles), weight each tile by a 5-level zoom scale, hand each
  // tile a proportional pixel share (with a floor so nothing vanishes), then
  // map time linearly WITHIN each tile.
  //
  // 5 discrete levels (1 = min .. 5 = max), weight doubling per level, applied
  // PER SEGMENT: driving defaults to level 4, every other stage (charging,
  // connected, resting, and data gaps) defaults to level 1 (min) -- clicking
  // a segment cycles its OWN level 1->2->3->4->5->1, overriding the default.
  const LEVEL_WEIGHTS = [1, 2, 4, 8, 16];
  const defaultLevel = (stage) => (stage === "driving" ? 4 : 1);
  // Tick step sizes shared with the axis-label generator below AND with the
  // "what will the next click do" resolution hint -- one source of truth so
  // the hint can never claim a granularity the axis wouldn't actually show.
  const STEPS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
  const stepFor = (dur, pxW) => STEPS.find((s) => (dur / s) * 56 <= pxW) ?? STEPS[STEPS.length - 1];
  const fmtStepSize = (s) => {
    if (s < 60) return `${s} sec`;
    if (s < 3600) return `${Math.round(s / 60)} min`;
    if (s < 86400) return `${s % 3600 === 0 ? (s / 3600).toFixed(0) : (s / 3600).toFixed(1)} h`;
    return `${Math.round(s / 86400)} d`;
  };

  const tiles = [];
  let cursor = X0;
  for (const seg of segments) {
    const s0 = Math.max(X0, seg.start_ts), s1 = Math.min(X1, Math.max(seg.end_ts, seg.start_ts));
    if (s1 <= cursor) continue;
    if (s0 > cursor) tiles.push({ t0: cursor, t1: s0, stage: null, segStart: null });
    tiles.push({ t0: Math.max(cursor, s0), t1: s1, stage: seg.stage, segStart: seg.start_ts });
    cursor = s1;
  }
  if (cursor < X1) tiles.push({ t0: cursor, t1: X1, stage: null, segStart: null });
  if (!tiles.length) tiles.push({ t0: X0, t1: X1, stage: null, segStart: null });

  const levelOverrides = warp?.levels || {};
  for (const tile of tiles) {
    const dur = Math.max(1, tile.t1 - tile.t0);
    const level = tile.stage == null ? 1
      : (tile.segStart != null && levelOverrides[tile.segStart]) || defaultLevel(tile.stage);
    tile.level = level;
    tile.weight = dur * (warp ? LEVEL_WEIGHTS[level - 1] : 1);
    tile.zoomed = tile.stage != null && level !== defaultLevel(tile.stage);
  }
  const totalW = tiles.reduce((s, x) => s + x.weight, 0) || 1;
  for (const tile of tiles) tile.px = (tile.weight / totalW) * plotW;
  // Predicted resolution before/after the next click, for the strip-hover
  // hint ("Click: ~1 min -> ~30 sec intervals") -- computed from each real
  // segment's OWN duration and its (approximate, floor-less) pixel share at
  // its current vs. next level, holding every other tile's weight constant.
  // Approximate because the floor-redistribution below can shift shares
  // slightly; close enough to describe what a click will roughly do.
  const otherWeight = (tile) => totalW - tile.weight;
  for (const tile of tiles) {
    if (tile.stage == null) { tile.nextHint = null; continue; }
    const dur = Math.max(1, tile.t1 - tile.t0);
    const curLevel = tile.level;
    const nextLevel = curLevel >= 5 ? 1 : curLevel + 1;
    const pxAt = (lvl) => {
      const w = dur * LEVEL_WEIGHTS[lvl - 1];
      return Math.max(1, (w / (otherWeight(tile) + w)) * plotW);
    };
    const curStep = stepFor(dur, pxAt(curLevel));
    const nextStep = stepFor(dur, pxAt(nextLevel));
    tile.nextHint = `Click: ~${fmtStepSize(curStep)} → ~${fmtStepSize(nextStep)} intervals (level ${curLevel}/5 → ${nextLevel}/5)`;
  }
  // Floor: any tile longer than a minute stays at least 16px wide (clickable,
  // visible); take the excess proportionally from the bigger tiles.
  const MINPX = 16;
  const need = tiles.filter((x) => x.t1 - x.t0 > 60 && x.px < MINPX);
  const deficit = need.reduce((s, x) => s + (MINPX - x.px), 0);
  if (deficit > 0) {
    const donors = tiles.filter((x) => !need.includes(x));
    const donorPx = donors.reduce((s, x) => s + x.px, 0) || 1;
    for (const x of need) x.px = MINPX;
    for (const x of donors) x.px -= (x.px / donorPx) * deficit;
  }
  let acc = plotL;
  const pieces = tiles.map((x) => {
    const p = { t0: x.t0, t1: x.t1, x0: acc, x1: acc + x.px, stage: x.stage, segStart: x.segStart, zoomed: x.zoomed, level: x.level, nextHint: x.nextHint };
    acc = p.x1;
    return p;
  });
  const X = (v) => {
    if (v <= X0) return plotL;
    if (v >= X1) return plotR;
    const p = pieces.find((pc) => v >= pc.t0 && v <= pc.t1) || pieces[pieces.length - 1];
    return +(p.x0 + ((v - p.t0) / ((p.t1 - p.t0) || 1)) * (p.x1 - p.x0)).toFixed(1);
  };

  // ---- Grid + per-piece time ticks ----------------------------------------
  let grid = "";
  for (const f of [0.25, 0.5, 0.75]) {
    const y = +(t + f * (bottom - t)).toFixed(1);
    grid += `<line x1="${plotL}" x2="${plotR}" y1="${y}" y2="${y}" style="stroke:var(--line2);stroke-width:1;opacity:0.6;"></line>`;
  }
  // Boundary guides where the axis scale changes (skip hairline tiles).
  let boundaries = "";
  for (const p of pieces.slice(1)) {
    if (p.x1 - p.x0 < 8) continue;
    boundaries += `<line x1="${p.x0.toFixed(1)}" x2="${p.x0.toFixed(1)}" y1="${t}" y2="${bottom}" style="stroke:var(--line2);stroke-width:1;stroke-dasharray:2 4;opacity:0.7;pointer-events:none;"></line>`;
  }
  // Ticks: each piece labels itself at the density its own width affords —
  // a stretched drive gets minute marks, a squeezed overnight charge maybe one.
  // (STEPS/stepFor are shared with the level-weight section above, so the
  // axis and the "what will the next click do" hint can never disagree.)
  const fmtTick = (ts) => new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const regularTicks = [];
  for (const p of pieces) {
    const pxW = p.x1 - p.x0;
    if (pxW < 34) continue;
    const dur = p.t1 - p.t0;
    const step = stepFor(dur, pxW);
    for (let ts = Math.ceil(p.t0 / step) * step; ts <= p.t1; ts += step) regularTicks.push({ ts, x: X(ts) });
  }
  // Boundary ticks: exactly where the car's state changes -- teaches the
  // viewer how the smart axis compresses/stretches time at a glance. These
  // get PRIORITY placement over the regular grid ticks (reserved first),
  // and only appear where there's room (same 46px min-gap rule).
  const boundaryTicks = pieces.slice(1).map((p) => ({ ts: p.t0, x: p.x0 }));
  const MIN_TICK_GAP = 46;
  const placedTicks = [];
  const tryPlaceTick = (tk) => {
    if (tk.x < plotL + 14 || tk.x > plotR - 14) return;
    if (placedTicks.some((pl) => Math.abs(pl.x - tk.x) < MIN_TICK_GAP)) return;
    placedTicks.push(tk);
  };
  boundaryTicks.slice().sort((a, b) => a.x - b.x).forEach(tryPlaceTick);
  regularTicks.slice().sort((a, b) => a.x - b.x).forEach(tryPlaceTick);
  const xLabels = placedTicks
    .sort((a, b) => a.x - b.x)
    .map((tk) => `<text x="${tk.x}" y="${height - 5}" text-anchor="middle" style="font:10.5px var(--mono);fill:var(--faint);">${esc(fmtTick(tk.ts))}</text>`)
    .join("");

  // ---- State strip (clickable: expand <-> compress a part) ----------------
  // Every piece is drawn, including data GAPS (stage null) -- the strip must
  // never have a blank/empty stretch, since that reads as "unknown" rather
  // than "the car reported nothing here". Gaps get a distinct hollow/dashed
  // treatment (not a solid stage color) and aren't click-to-zoom targets.
  const fmtDur = (s) => s >= 5400 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`;
  // Plain phase + duration -- the zoom level lives on the "Click: ..." hint
  // line instead (built above), not here: this label is also reused for the
  // main tooltip's car-state row when hovering the DATA/plot area, where a
  // zoom-level tag would read as out of place.
  const stripLabel = (p) => {
    if (p.stage == null) return `No data · ${fmtDur(p.t1 - p.t0)}`;
    return `${stageLabel[p.stage] || p.stage} · ${fmtDur(p.t1 - p.t0)}`;
  };
  const strip = pieces
    .map((p) => {
      const w = Math.max(1.2, p.x1 - p.x0);
      if (p.stage == null) {
        return `<rect x="${p.x0.toFixed(1)}" y="${stripY}" width="${w.toFixed(1)}" height="${stripH}" rx="2" style="fill:none;stroke:var(--faint);stroke-width:1;stroke-dasharray:3 2;opacity:0.5;"><title>${esc(stripLabel(p))}</title></rect>`;
      }
      const title = `${stripLabel(p)} — ${p.nextHint || "click to change detail"}`;
      return `<rect x="${p.x0.toFixed(1)}" y="${stripY}" width="${w.toFixed(1)}" height="${stripH}" rx="2" data-action="explorer-seg" data-seg="${p.segStart}" data-level="${p.level}" style="fill:${stageColor[p.stage] || "var(--faint)"};cursor:pointer;${p.zoomed ? "stroke:var(--text);stroke-width:1;" : ""}"><title>${esc(title)}</title></rect>`;
    })
    .join("");

  // ---- Series (each normalized to its own band) ----------------------------
  const seriesMarkup = drawable
    .map((s) => {
      const ys = s.points.map((p) => p[1]);
      let y0 = Math.min(...ys), y1 = Math.max(...ys);
      if (y0 === y1) { y0 -= 1; y1 += 1; }
      const pad = (y1 - y0) * 0.04;
      y0 -= pad; y1 += pad;
      const Y = (v) => +(t + (1 - (v - y0) / (y1 - y0)) * (bottom - t)).toFixed(1);
      const pts = s.points.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ");
      return `<polyline points="${pts}" style="fill:none;stroke:${s.color || "var(--accent)"};stroke-width:${s.width || 1.8};stroke-linejoin:round;stroke-linecap:round;opacity:0.92;${s.dashed ? "stroke-dasharray:5 4;" : ""}"></polyline>`;
    })
    .join("");

  // ---- Event markers --------------------------------------------------------
  const markerMarkup = markers
    .map((m) => {
      const x = X(m.ts);
      const col = markerColor[m.kind] || "var(--warn)";
      return `<line x1="${x}" x2="${x}" y1="${markerBandY + 5}" y2="${bottom}" style="stroke:${col};stroke-width:1;stroke-dasharray:2 3;opacity:0.28;pointer-events:none;"></line>`
        + `<circle cx="${x}" cy="${markerBandY}" r="4" style="fill:${col};stroke:var(--card);stroke-width:1.3;"><title>${esc(m.label)}</title></circle>`;
    })
    .join("");

  // Each piece carries its own display label (built once here, shared verbatim
  // by the tooltip handler when hovering the state strip directly) plus its
  // stage, so the shared listener can do PIXEL-consistent state lookups --
  // the exact same piece used to draw the strip and invert the cursor
  // position, instead of an independent time-based segment search that can
  // disagree with what's visually under the cursor in a densely-packed region.
  const warpPieces = pieces.map((p) => ({ t0: p.t0, t1: p.t1, x0: p.x0, x1: p.x1, stage: p.stage, label: stripLabel(p), nextHint: p.nextHint }));
  const chartId = registerChart({
    width, height, X0, X1, left: plotL, right: plotR, warpPieces, stripY, stripH,
    series: drawable.map((s) => ({ name: s.name, unit: s.unit, color: s.color, points: s.points })),
    segments, stageColor, stageLabel, markers, markerColor,
  });
  return `<svg viewBox="0 0 ${width} ${height}" class="tm-svg-block" data-tmchart="${chartId}" data-x0="${X0}" data-x1="${X1}" data-left="${plotL}" data-right="${plotR}" data-w="${width}" data-warp="${JSON.stringify(warpPieces).replace(/"/g, "&quot;")}">${grid}${boundaries}${strip}${seriesMarkup}${markerMarkup}${xLabels}</svg>`;
}

/**
 * Playable single-drive chart: speed area+line, faint elevation terrain, harsh
 * brake/accel event dots, plus a hidden playhead line + dot the caller animates.
 * Returns { html, plot } where `plot` exposes the same X()/Y() scale the SVG was
 * drawn with, so the caller can position the playhead in the SVG's own coordinate
 * space (viewBox units) regardless of the rendered size.
 *
 * `speedPts`/`elevPts`: [[minutes, value], …]. `events`: [{t (min), type:'brake'|'accel', speed, g}].
 */
export function svgDriveChart({ speedPts, elevPts = [], events = [], tracks = [], durationMin = 0, width = 760, height = 240 }) {
  if (!speedPts || speedPts.length < 2) return { html: "", plot: null };
  const l = 48, r = 16, t = 16, b = 30;
  const x0 = 0;
  const x1 = Math.max(durationMin || 0, speedPts[speedPts.length - 1][0]) || 1;
  const maxSpeed = Math.max(60, ...speedPts.map((p) => p[1]));
  const y0 = 0, y1 = Math.ceil(maxSpeed / 20) * 20;
  const X = (v) => +(l + ((v - x0) / ((x1 - x0) || 1)) * (width - l - r)).toFixed(1);
  const Y = (v) => +(t + (1 - (v - y0) / ((y1 - y0) || 1)) * (height - t - b)).toFixed(1);
  const bottom = height - b;

  let grid = "";
  for (let v = y0; v <= y1; v += 20) {
    const y = Y(v);
    grid += `<line x1="${l}" x2="${width - r}" y1="${y}" y2="${y}" style="stroke:var(--line2);stroke-width:1;"></line>`
      + `<text x="${l - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" style="font:10.5px var(--mono);fill:var(--faint);">${v}</text>`;
  }
  const xlabels = [0, x1 / 2, x1]
    .map((v) => `<text x="${X(v)}" y="${height - 8}" text-anchor="middle" style="font:10.5px var(--mono);fill:var(--faint);">${Math.round(v)}m</text>`)
    .join("");

  // Transparent hit-area for click/drag-to-scrub — sits just above the grid so the
  // event dots (drawn later) keep their hover tooltips, and empty plot regions scrub.
  const scrub = `<rect id="tm-ph-scrub" x="${l}" y="${t}" width="${(width - l - r).toFixed(1)}" height="${(bottom - t).toFixed(1)}" style="fill:transparent;cursor:pointer;"></rect>`;

  let elev = "";
  if (elevPts.length > 1) {
    const es = elevPts.map((p) => p[1]);
    const emin = Math.min(...es), emax = Math.max(...es);
    const En = (e) => Y(((e - emin) / ((emax - emin) || 1)) * y1 * 0.42); // gentle lower-band terrain
    const pts = elevPts.map((p) => `${X(p[0])},${En(p[1])}`).join(" ");
    elev = `<polyline points="${pts}" style="fill:none;stroke:var(--faint);stroke-width:1.4;stroke-dasharray:5 4;opacity:0.65;pointer-events:none;"></polyline>`;
  }

  const spts = speedPts.map((p) => `${X(p[0])},${Y(p[1])}`).join(" ");
  const first = speedPts[0], last = speedPts[speedPts.length - 1];
  const area = `<polygon points="${X(first[0])},${bottom} ${spts} ${X(last[0])},${bottom}" style="fill:color-mix(in oklab, var(--accent) 10%, transparent);pointer-events:none;"></polygon>`;
  const line = `<polyline points="${spts}" style="fill:none;stroke:var(--accent);stroke-width:2.2;stroke-linejoin:round;stroke-linecap:round;pointer-events:none;"></polyline>`;

  const evColor = { brake: "var(--bad)", accel: "var(--warn)" };
  const evMarks = events
    .map((ev) => {
      const col = evColor[ev.type] || "var(--faint)";
      const g = ev.g != null ? `${ev.g > 0 ? "+" : ""}${ev.g.toFixed(2)}g` : "";
      const label = `${ev.type === "brake" ? "Hard brake" : "Hard accel"} ${g} · ${Math.round(ev.t)} min`;
      return `<circle cx="${X(ev.t)}" cy="${Y(ev.speed)}" r="4.5" style="fill:${col};stroke:var(--card);stroke-width:1.5;"><title>${esc(label)}</title></circle>`;
    })
    .join("");

  // Track-change markers: a "was this playing" timeline, not tied to speed,
  // so they sit as a fixed row near the top rather than on the speed curve —
  // a dashed guide down to the axis makes each one easy to line up by eye.
  const MEDIA_COLOR = "#8A63D2";
  const trackMarks = tracks
    .map((tr) => {
      const x = X(tr.t);
      const who = tr.artist ? `${tr.title} — ${tr.artist}` : tr.title;
      const label = `♪ ${who} · ${Math.round(tr.t)} min`;
      return `<line x1="${x}" x2="${x}" y1="${t + 10}" y2="${bottom}" style="stroke:${MEDIA_COLOR};stroke-width:1;stroke-dasharray:2 3;opacity:0.3;pointer-events:none;"></line>`
        + `<circle cx="${x}" cy="${t + 6}" r="3.5" style="fill:${MEDIA_COLOR};stroke:var(--card);stroke-width:1.2;"><title>${esc(label)}</title></circle>`;
    })
    .join("");

  const playhead = `<line id="tm-ph-line" x1="${l}" x2="${l}" y1="${t}" y2="${bottom}" style="stroke:var(--text);stroke-width:1.4;opacity:0;pointer-events:none;"></line>`
    + `<circle id="tm-ph-dot" cx="${l}" cy="${bottom}" r="5" style="fill:var(--accent);stroke:var(--card);stroke-width:2;opacity:0;pointer-events:none;"></circle>`;

  const html = `<svg viewBox="0 0 ${width} ${height}" class="tm-svg-block" style="touch-action:none;user-select:none;">${grid}${scrub}${elev}${area}${line}${evMarks}${trackMarks}${playhead}${xlabels}</svg>`;
  return { html, plot: { X, Y, l, r, t, b, x0, x1, y0, y1, width, height, bottom } };
}

/** Simple month/category bar chart. `bars`: [{label, value}]. */
export function svgBarChart({ width = 760, height = 230, bars, yMax, l = 46, r = 12, t = 12, b = 26 }) {
  if (!bars.length) return "";
  const max = yMax ?? Math.max(...bars.map((x) => x.value), 1);
  const plotW = width - l - r;
  const slot = plotW / bars.length;
  const bw = slot * 0.52;
  const Y = (v) => t + (1 - v / max) * (height - t - b);
  const baseline = height - b;
  const rects = bars
    .map((bar, i) => {
      const x = +(l + i * slot + (slot - bw) / 2).toFixed(1);
      const y = +Y(bar.value).toFixed(1);
      const h = +(baseline - y).toFixed(1);
      const lx = +(l + i * slot + slot / 2).toFixed(1);
      return `<rect x="${x}" y="${y}" width="${bw.toFixed(1)}" height="${Math.max(0, h)}" rx="3" style="fill:var(--accent); opacity:0.85;"></rect>
        <text x="${lx}" y="${height - 10}" text-anchor="middle" style="font:10.5px var(--mono); fill:var(--faint);">${esc(bar.label)}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" class="tm-svg-block"><line x1="${l}" x2="${width - r}" y1="${baseline}" y2="${baseline}" style="stroke:var(--line); stroke-width:1;"></line>${rects}</svg>`;
}

/** Battery-health style donut ring. */
export function svgDonut({ pct, size = 132, label, sublabel }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return `<svg viewBox="0 0 120 120" style="width:${size}px; height:${size}px;">
    <circle cx="60" cy="60" r="52" pathLength="100" style="fill:none; stroke:var(--chip); stroke-width:9;"></circle>
    <circle cx="60" cy="60" r="52" pathLength="100" transform="rotate(-90 60 60)" style="fill:none; stroke:var(--accent); stroke-width:9; stroke-linecap:round; stroke-dasharray:${clamped} 100;"></circle>
    <text x="60" y="57" text-anchor="middle" style="font:600 22px var(--mono); fill:var(--text);">${esc(label ?? clamped.toFixed(1) + "%")}</text>
    <text x="60" y="76" text-anchor="middle" style="font:11px var(--ui); fill:var(--sub);">${esc(sublabel ?? "health")}</text>
  </svg>`;
}

/** AC/DC or similar two-segment horizontal split bar. */
export function svgSplitBar(segments) {
  const total = segments.reduce((s, seg) => s + seg.value, 0) || 1;
  return segments
    .map((seg) => `<div style="width:${((seg.value / total) * 100).toFixed(2)}%; background:${seg.color};"></div>`)
    .join("");
}
