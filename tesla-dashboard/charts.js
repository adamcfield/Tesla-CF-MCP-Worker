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
      return out;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" class="tm-svg-block">${grid}${xLabels}${seriesMarkup}</svg>`;
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
