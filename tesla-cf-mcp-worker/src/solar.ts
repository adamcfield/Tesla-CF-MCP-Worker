/**
 * Astronomical night detection — replaces the fixed 22:00–06:00 window in the
 * driving-behaviour score. "Night driving" as a RISK factor means driving in
 * darkness, which in Tel Aviv shifts by >3 hours across the year; a fixed
 * clock window mislabels a summer 21:00 drive (still daylight) as risky and a
 * winter 06:30 drive (dark) as safe. This computes real sunset/sunrise for the
 * drive's own lat/lon and date — pure math, zero network, so it's free and
 * exact per sample.
 *
 * NOAA solar-position approximation (accurate to ~1 min for civil purposes).
 * Uses civil-twilight-ish threshold: we treat "night" as the sun being below
 * the horizon (elevation < -0.833°, the standard sunrise/sunset refraction
 * correction).
 */

const RAD = Math.PI / 180;

/** Solar elevation angle (degrees) at a given instant and location. */
export function solarElevationDeg(lat: number, lon: number, epochSec: number): number {
  // Julian day from unix epoch.
  const jd = epochSec / 86400 + 2440587.5;
  const n = jd - 2451545.0; // days since J2000.0
  // Mean longitude & anomaly of the sun.
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  // Ecliptic longitude.
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  // Obliquity of the ecliptic.
  const epsilon = (23.439 - 0.0000004 * n) * RAD;
  // Declination.
  const delta = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  // Right ascension (radians), kept in the same quadrant as lambda.
  const alpha = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda));
  // Greenwich mean sidereal time (degrees) → local hour angle.
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  const lst = (gmst + lon) * RAD;
  const ha = lst - alpha;
  // Elevation.
  const latR = lat * RAD;
  const sinEl = Math.sin(latR) * Math.sin(delta) + Math.cos(latR) * Math.cos(delta) * Math.cos(ha);
  return Math.asin(Math.max(-1, Math.min(1, sinEl))) / RAD;
}

/** True when the sun is below the horizon (standard −0.833° sunset threshold). */
export function isNight(lat: number, lon: number, epochSec: number): boolean {
  return solarElevationDeg(lat, lon, epochSec) < -0.833;
}
