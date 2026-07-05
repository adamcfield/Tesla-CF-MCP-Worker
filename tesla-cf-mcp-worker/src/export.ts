/**
 * Data export: own-your-data escapes for the logger.
 *   GET /data/export/drives.csv?vin=   — all completed drives
 *   GET /data/export/charges.csv?vin=  — all charge sessions
 *   GET /data/export/drive.gpx?id=     — one drive's GPS path as GPX 1.1
 *
 * Token-gated like every /data route (read scope suffices). Streams-as-string
 * is fine at personal-logger scale (thousands of rows, not millions).
 */

import { ensureSchema } from "./store";
import { Env } from "./types";

/** RFC-4180 CSV escaping: quote when the value contains a comma/quote/newline. */
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines = [columns.join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

const iso = (ts: unknown): string | null =>
  typeof ts === "number" && Number.isFinite(ts) ? new Date(ts * 1000).toISOString() : null;

export async function exportDrivesCsv(env: Env, vin: string): Promise<Response> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT * FROM drives WHERE vin = ?1 AND status = 'complete' ORDER BY start_ts ASC`,
  )
    .bind(vin)
    .all<Record<string, unknown>>();
  const rows = (rs.results ?? []).map((r) => ({
    ...r,
    start_time_utc: iso(r.start_ts),
    end_time_utc: iso(r.end_ts),
  }));
  const columns = [
    "id", "start_time_utc", "end_time_utc", "start_address", "end_address",
    "driver", "suggested_driver", "distance_km", "duration_min", "energy_used_kwh",
    "efficiency_wh_km", "avg_speed", "max_speed", "start_soc", "end_soc",
    "start_odometer", "end_odometer", "outside_temp_avg", "behavior_score",
    "max_accel_ms2", "max_decel_ms2", "max_jerk_ms3",
    "harsh_accel_count", "harsh_brake_count", "harsh_turn_count",
    "over_limit_frac", "night_frac", "sample_count",
    "start_lat", "start_lon", "end_lat", "end_lon",
  ];
  return csvResponse(toCsv(rows, columns), `drives-${vin.slice(-6)}.csv`);
}

export async function exportChargesCsv(env: Env, vin: string): Promise<Response> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT * FROM charge_sessions WHERE vin = ?1 ORDER BY start_ts ASC`,
  )
    .bind(vin)
    .all<Record<string, unknown>>();
  const rows = (rs.results ?? []).map((r) => ({
    ...r,
    start_time_utc: iso(r.start_ts),
    end_time_utc: iso(r.end_ts),
  }));
  const columns = [
    "id", "start_time_utc", "end_time_utc", "charge_type", "energy_added_kwh",
    "cost", "currency", "site_name", "start_soc", "end_soc", "duration_min",
    "max_charger_power", "start_rated_range", "end_rated_range",
    "outside_temp_avg", "location_id", "source", "lat", "lon",
  ];
  return csvResponse(toCsv(rows, columns), `charges-${vin.slice(-6)}.csv`);
}

function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "access-control-allow-origin": "*",
    },
  });
}

const xml = (s: unknown): string =>
  String(s ?? "").replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&apos;" : "&quot;",
  );

export async function exportDriveGpx(env: Env, driveId: number): Promise<Response> {
  await ensureSchema(env);
  const drive = await env.DB.prepare(`SELECT * FROM drives WHERE id = ?1`)
    .bind(driveId)
    .first<Record<string, unknown>>();
  if (!drive) return new Response("drive not found", { status: 404 });
  const path = await env.DB.prepare(
    `SELECT ts, lat, lon, elevation, speed FROM positions
     WHERE drive_id = ?1 AND lat IS NOT NULL AND lon IS NOT NULL ORDER BY ts ASC`,
  )
    .bind(driveId)
    .all<{ ts: number; lat: number; lon: number; elevation: number | null; speed: number | null }>();

  const name = `${drive.start_address ?? "Unknown"} → ${drive.end_address ?? "Unknown"}`;
  const pts = (path.results ?? [])
    .map(
      (p) =>
        `      <trkpt lat="${p.lat}" lon="${p.lon}">` +
        (p.elevation != null ? `<ele>${p.elevation}</ele>` : "") +
        `<time>${new Date(p.ts * 1000).toISOString()}</time>` +
        (p.speed != null ? `<extensions><speed_kmh>${p.speed}</speed_kmh></extensions>` : "") +
        `</trkpt>`,
    )
    .join("\n");

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="tesla-cf-mcp-worker" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${xml(name)}</name><time>${new Date(Number(drive.start_ts) * 1000).toISOString()}</time></metadata>
  <trk>
    <name>${xml(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
  return new Response(gpx, {
    headers: {
      "content-type": "application/gpx+xml",
      "content-disposition": `attachment; filename="drive-${driveId}.gpx"`,
      "access-control-allow-origin": "*",
    },
  });
}
