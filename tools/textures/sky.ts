// The four painted sky panoramas (dawn, day, golden hour, night), equirectangular: u is the
// compass azimuth from north clockwise (u = 0 and 1 are north), v runs from the zenith at the
// top row to the nadir. Each is a soft gradient keyed on elevation, warmer toward the sun's
// azimuth, a glow around where the sun stands at that hour, and painted cumulus lit from the
// sun's side. The runtime mixes them with the three.js Sky shader, adds the sun disc, the moon
// and the stars, and blends them by weight as the sun moves.

import { sunPosition } from "../../src/sun";
import { fbm, smoothstep } from "./noise";

interface SkyStyle {
  /** Local clock time whose sun position the glow and the cloud lighting are painted for. */
  hour: number;
  zenith: string;
  upper: string;
  horizonSun: string;
  horizonAway: string;
  below: string;
  glow: string;
  glowStrength: number;
  cloudLit: string;
  cloudShadow: string;
  coverage: number;
  cloudScale: number;
  cloudOpacity: number;
  seed: number;
  /** Night: a warm band of city light along the horizon instead of a sun. */
  cityGlow?: string;
}

/** The locked sky palette (sRGB). */
export const SKIES: Record<string, SkyStyle> = {
  dawn: {
    hour: 6.85,
    zenith: "#56689c",
    upper: "#98a0c4",
    horizonSun: "#ffc89c",
    horizonAway: "#c2b4c8",
    below: "#a69ca6",
    glow: "#ffd7aa",
    glowStrength: 0.75,
    cloudLit: "#ffd2b4",
    cloudShadow: "#958eab",
    coverage: 0.3,
    cloudScale: 1.3,
    cloudOpacity: 0.9,
    seed: 101,
  },
  day: {
    hour: 13.0,
    zenith: "#3c74bd",
    upper: "#6aa0da",
    horizonSun: "#cddfea",
    horizonAway: "#c0d4e6",
    below: "#b8c3c9",
    glow: "#fff4dc",
    glowStrength: 0.22,
    cloudLit: "#ffffff",
    cloudShadow: "#aebed2",
    coverage: 0.3,
    cloudScale: 1.2,
    cloudOpacity: 0.95,
    seed: 202,
  },
  golden: {
    hour: 18.15,
    zenith: "#4a5a8c",
    upper: "#8e8cb3",
    horizonSun: "#ffb46f",
    horizonAway: "#d6a4a7",
    below: "#a68986",
    glow: "#ffcd85",
    glowStrength: 0.95,
    cloudLit: "#ffbf8a",
    cloudShadow: "#867493",
    coverage: 0.36,
    cloudScale: 1.25,
    cloudOpacity: 0.92,
    seed: 303,
  },
  night: {
    hour: 21.0,
    zenith: "#04081a",
    upper: "#0a1430",
    horizonSun: "#3a3346",
    horizonAway: "#2d2d42",
    below: "#1c1c27",
    glow: "#000000",
    glowStrength: 0,
    cloudLit: "#3a3240",
    cloudShadow: "#10162a",
    coverage: 0.3,
    cloudScale: 1.1,
    cloudOpacity: 0.75,
    seed: 404,
    cityGlow: "#5a4438",
  },
};

type RGB = [number, number, number];
const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const lin = (hex: string): RGB => [1, 3, 5].map((i) => toLin(parseInt(hex.slice(i, i + 2), 16) / 255)) as RGB;
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const DEG = Math.PI / 180;

/** Paints one panorama, returning sRGB bytes (RGB, row 0 at the zenith). */
export function paintSky(name: string, width: number, height: number): Uint8Array {
  const S = SKIES[name];
  const sun = sunPosition(S.hour);
  const sunAz = sun.azimuth * DEG;
  const sunEl = Math.max(sun.elevation, -2) * DEG;
  const sd: RGB = [Math.sin(sunAz) * Math.cos(sunEl), Math.sin(sunEl), -Math.cos(sunAz) * Math.cos(sunEl)];
  // In the cloud plane, toward the sun.
  const lx = Math.sin(sunAz);
  const lz = -Math.cos(sunAz);
  const c = {
    zenith: lin(S.zenith),
    upper: lin(S.upper),
    hs: lin(S.horizonSun),
    ha: lin(S.horizonAway),
    below: lin(S.below),
    glow: lin(S.glow),
    lit: lin(S.cloudLit),
    shadow: lin(S.cloudShadow),
    city: S.cityGlow ? lin(S.cityGlow) : null,
  };
  const out = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const E = (0.5 - (y + 0.5) / height) * Math.PI;
    const cosE = Math.cos(E);
    const sinE = Math.sin(E);
    const eDeg = E / DEG;
    for (let x = 0; x < width; x++) {
      const A = ((x + 0.5) / width) * Math.PI * 2;
      const dx = Math.sin(A) * cosE;
      const dz = -Math.cos(A) * cosE;
      // Warmer toward the sun's azimuth.
      const sunward = ((Math.cos(A - sunAz) + 1) / 2) ** 2;
      const horizon = mix(c.ha, c.hs, sunward);
      let col: RGB;
      if (eDeg >= 0) {
        col = mix(horizon, c.upper, smoothstep(0, 28, eDeg) ** 0.8);
        col = mix(col, c.zenith, smoothstep(22, 90, eDeg));
      } else col = mix(horizon, c.below, smoothstep(0, -7, eDeg));
      if (c.city) col = mix(col, c.city, (1 - smoothstep(-3, 16, eDeg)) * 0.75 * (eDeg > -6 ? 1 : 0.6));
      // Glow around the sun, a tight core and a wide halo.
      const cosT = Math.min(1, Math.max(-1, dx * sd[0] + sinE * sd[1] + dz * sd[2]));
      const theta = Math.acos(cosT);
      const g = S.glowStrength * (Math.exp(-theta / 0.1) * 0.7 + Math.exp(-theta / 0.4) * 0.35);
      col = [col[0] + c.glow[0] * g, col[1] + c.glow[1] * g, col[2] + c.glow[2] * g];

      if (eDeg > 0.3) {
        // Clouds on a plane overhead: flatter and denser toward the horizon.
        const k = S.cloudScale / (sinE + 0.12);
        const px = dx * k;
        const pz = dz * k;
        const region = fbm(px * 0.18, pz * 0.18, 2, S.seed + 5) * 0.5 + 0.5;
        const cov = S.coverage + (region - 0.5) * 0.6;
        const d = fbm(px, pz, 5, S.seed) * 0.5 + 0.5;
        // fbm clusters round 0.5 (σ about 0.1), so coverage maps onto a narrow threshold band.
        const th = 0.5 + (0.5 - cov) * 0.45;
        const mask = smoothstep(th, th + 0.06, d) * smoothstep(0.3, 4, eDeg);
        if (mask > 0.001) {
          // Lit where the density falls off toward the sun.
          const d2 = fbm(px + lx * 0.06, pz + lz * 0.06, 5, S.seed) * 0.5 + 0.5;
          const lit = Math.min(1, Math.max(0, 0.55 + (d - d2) * 9 + (sunward - 0.5) * 0.5));
          let cc = mix(c.shadow, c.lit, smoothstep(0.15, 0.85, lit));
          if (c.city) cc = mix(c.shadow, c.lit, 1 - smoothstep(2, 30, eDeg) * 0.8);
          // Distant clouds sink into the horizon haze.
          cc = mix(cc, horizon, (1 - smoothstep(0, 14, eDeg)) * 0.55);
          col = mix(col, cc, mask * S.cloudOpacity);
        }
      }
      const i = (y * width + x) * 3;
      for (let k = 0; k < 3; k++) out[i + k] = Math.round(Math.min(1, toSrgb(Math.max(0, col[k]))) * 255);
    }
  }
  return out;
}
