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

  return `<svg viewBox="0 0 ${width} ${height}" class="tm-svg-block">${grid}${xLabels}${seriesMarkup}</svg>`;
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
export function svgDriveChart({ speedPts, elevPts = [], events = [], durationMin = 0, width = 760, height = 240 }) {
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

  const playhead = `<line id="tm-ph-line" x1="${l}" x2="${l}" y1="${t}" y2="${bottom}" style="stroke:var(--text);stroke-width:1.4;opacity:0;pointer-events:none;"></line>`
    + `<circle id="tm-ph-dot" cx="${l}" cy="${bottom}" r="5" style="fill:var(--accent);stroke:var(--card);stroke-width:2;opacity:0;pointer-events:none;"></circle>`;

  const html = `<svg viewBox="0 0 ${width} ${height}" class="tm-svg-block" style="touch-action:none;user-select:none;">${grid}${scrub}${elev}${area}${line}${evMarks}${playhead}${xlabels}</svg>`;
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
