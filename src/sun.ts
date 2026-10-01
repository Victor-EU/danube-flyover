// Sun position for Budapest on 1 October 2026 (CEST, UTC+2), NOAA solar-position algorithm.
// Geometric elevation (no refraction): sunrise and sunset are where it crosses about -0.8°.

const LAT = 47.5;
const LON = 19.05;
const UTC_OFFSET = 2;
/** Julian day of 2026-10-01 00:00 UTC. */
const JD_DATE = 2461314.5;

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Elevation and azimuth (degrees; azimuth from north, clockwise) at a local clock time in hours. */
export function sunPosition(hours: number): { elevation: number; azimuth: number } {
  const ut = hours - UTC_OFFSET;
  const jd = JD_DATE + ut / 24;
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = rad(M);
  const C =
    Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mr) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda)));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const L0r = rad(L0);
  const eqTime =
    4 *
    deg(
      y * Math.sin(2 * L0r) -
        2 * e * Math.sin(Mr) +
        4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
        0.5 * y * y * Math.sin(4 * L0r) -
        1.25 * e * e * Math.sin(2 * Mr),
    );
  const trueSolarTime = (((ut * 60 + eqTime + 4 * LON) % 1440) + 1440) % 1440;
  const hourAngle = rad(trueSolarTime / 4 - 180);
  const lat = rad(LAT);
  const cosZen = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZen)));
  const azimuth =
    (deg(Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat))) + 180 + 360) % 360;
  return { elevation: 90 - deg(zenith), azimuth };
}
