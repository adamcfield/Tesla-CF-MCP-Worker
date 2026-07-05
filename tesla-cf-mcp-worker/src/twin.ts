/**
 * Digital Twin — answers "what should I expect for THIS trip?" from your OWN
 * k-nearest historical drives, not a black-box coefficient. For a candidate
 * trip (distance, ambient temp, driver, day/night) it finds the most similar
 * real drives you've logged and reports what actually happened on them
 * (efficiency, energy, SoC used) with a provenance trail — the interpretable
 * complement to the OLS range model in forecast.ts.
 *
 * k-NN in plain SQL + JS over this one car's modest drive count — no Vectorize,
 * no new binding, $0. Features are normalized to comparable scales; driver
 * mismatch is a soft penalty, not a hard filter, so it still answers when a
 * driver has few drives.
 */

import { ensureSchema } from "./store";
import { Env } from "./types";

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export interface TripQuery {
  distance_km?: number | null;
  temp_c?: number | null;
  driver?: string | null;
  night?: boolean | null;
  avg_speed?: number | null;
}

// Feature scales for normalization (span of each dimension in the metric).
const SCALE = { distance: 200, temp: 30, speed: 60, night: 1 };

interface DriveRow {
  id: number; start_ts: number; distance_km: number | null; outside_temp_avg: number | null;
  avg_speed: number | null; night_frac: number | null; efficiency_wh_km: number | null;
  energy_used_kwh: number | null; start_soc: number | null; end_soc: number | null;
  driver: string | null; start_address: string | null; end_address: string | null;
}

/**
 * Returns the k most similar completed (non-synthetic) drives to `q`, each with
 * a similarity 0-100 and its real outcome. Missing query dims are ignored in
 * the distance so a partial query still works.
 */
export async function findSimilarDrives(env: Env, vin: string, q: TripQuery, k = 5): Promise<unknown> {
  await ensureSchema(env);
  const rs = await env.DB.prepare(
    `SELECT id, start_ts, distance_km, outside_temp_avg, avg_speed, night_frac,
            efficiency_wh_km, energy_used_kwh, start_soc, end_soc, driver, start_address, end_address
     FROM drives
     WHERE vin = ?1 AND status = 'complete' AND (synthetic IS NULL OR synthetic = 0)
       AND distance_km IS NOT NULL AND efficiency_wh_km IS NOT NULL`,
  )
    .bind(vin)
    .all<DriveRow>();
  const rows = rs.results ?? [];
  if (rows.length === 0) return { vin, query: q, matches: [], note: "No completed drives with efficiency yet — the twin learns as you drive." };

  const scored = rows.map((d) => {
    let sumSq = 0;
    let dims = 0;
    if (q.distance_km != null && d.distance_km != null) { sumSq += ((q.distance_km - d.distance_km) / SCALE.distance) ** 2; dims++; }
    if (q.temp_c != null && d.outside_temp_avg != null) { sumSq += ((q.temp_c - d.outside_temp_avg) / SCALE.temp) ** 2; dims++; }
    if (q.avg_speed != null && d.avg_speed != null) { sumSq += ((q.avg_speed - d.avg_speed) / SCALE.speed) ** 2; dims++; }
    if (q.night != null && d.night_frac != null) { sumSq += ((Number(q.night) - (d.night_frac >= 0.5 ? 1 : 0)) / SCALE.night) ** 2; dims++; }
    // Driver: soft penalty for a mismatch (equivalent to ~0.4 of a full dim).
    if (q.driver && d.driver) { if (q.driver.toLowerCase() !== d.driver.toLowerCase()) sumSq += 0.16; dims++; }
    const dist = dims > 0 ? Math.sqrt(sumSq / dims) : 1;
    const similarity = Math.max(0, Math.round((1 - Math.min(1, dist)) * 100));
    return { d, similarity };
  });
  scored.sort((a, b) => b.similarity - a.similarity);
  const top = scored.slice(0, k);

  const matches = top.map(({ d, similarity }) => ({
    similarity_pct: similarity,
    drive_id: d.id,
    when: d.start_ts,
    route: `${d.start_address ?? "?"} → ${d.end_address ?? "?"}`,
    distance_km: d.distance_km != null ? round(d.distance_km, 1) : null,
    outside_temp_c: d.outside_temp_avg != null ? round(d.outside_temp_avg, 0) : null,
    efficiency_wh_km: d.efficiency_wh_km != null ? round(d.efficiency_wh_km, 0) : null,
    soc_used_pct: d.start_soc != null && d.end_soc != null ? round(d.start_soc - d.end_soc, 0) : null,
    avg_speed_kmh: d.avg_speed != null ? round(d.avg_speed, 0) : null,
    driver: d.driver,
  }));

  // Blended prediction: similarity-weighted efficiency of the matches.
  const wsum = top.reduce((s, t) => s + t.similarity, 0);
  const predEff = wsum > 0
    ? top.reduce((s, t) => s + t.similarity * (t.d.efficiency_wh_km ?? 0), 0) / wsum
    : null;
  const prediction: Record<string, unknown> = { basis: `${top.length} nearest of ${rows.length} logged drives` };
  if (predEff != null) {
    prediction.efficiency_wh_km = round(predEff, 0);
    if (q.distance_km != null && q.distance_km > 0) {
      const kwh = (predEff * q.distance_km) / 1000;
      prediction.energy_kwh = round(kwh, 1);
      const pack = Number((await env.TESLA_KV.get(`pack_kwh:${vin}`).catch(() => null)) ?? "");
      if (Number.isFinite(pack) && pack > 0) prediction.soc_used_pct = round((kwh / pack) * 100, 0);
    }
  }

  return { vin, query: q, prediction, matches };
}
