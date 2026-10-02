// Gellért Hill and its foot: the Liberty Statue (Zsigmond Kisfaludi Strobl, 1947) on its tall
// pedestal, the Citadella's walls on their OSM footprint, and the Gellért Hotel and Baths
// (1918) at the Buda end of Liberty Bridge, with its domes over the river front.

import type { HeroContext } from "./context";
import { insetPolygon, Model, ngon, surf, type V3 } from "./kit";

const PEDESTAL = surf("ashlar", "#ddd6c4");
const BRONZE = surf("metal", "#58665a", 1);

export function libertyStatue(ctx: HeroContext): Model[] {
  const c = ctx.centre("libertyStatue");
  // She faces the river and Pest, holding the palm frond across.
  const m = new Model("libertyStatue").frame(c.x, ctx.ground(c.x, c.z), c.z, 80);
  m.box(-8, 8, -8, 8, -2, 1.2, PEDESTAL);
  m.box(-6, 6, -6, 6, 1.2, 3.4, PEDESTAL);
  m.prism(0, 0, 4, 3.7, 3.4, 25.6, PEDESTAL, null, Math.PI / 4, 2.7);
  m.prism(0, 0, 4, 3.2, 25.6, 26.4, PEDESTAL, PEDESTAL, Math.PI / 4);
  // The figure: robe, shoulders and head, arms raised.
  m.lathe(0, 0, 8, [[1.3, 26.4], [1.15, 28.5], [0.88, 31.5], [0.72, 33.8], [0.66, 35.4], [0.42, 36.3], [0.18, 36.6]], BRONZE);
  m.lathe(0, 0, 8, [[0.01, 36.5], [0.3, 36.75], [0.34, 37.2], [0.28, 37.7], [0.01, 38.0]], BRONZE);
  for (const s of [-1, 1]) m.beam([s * 0.55, 35.7, 0], [s * 1.25, 39.2, -0.1], 0.3, 0.3, BRONZE);
  // The palm frond, across and above her head, drooping at the tips.
  const frond: V3[] = [];
  for (let i = 0; i <= 10; i++) {
    const u = i / 5 - 1;
    frond.push([u * 4.3, 39.75 + 0.45 * (1 - u * u) - 0.55 * u * u * u * u, -0.1 - 0.25 * (1 - u * u)]);
  }
  for (let i = 0; i < 10; i++) m.beam(frond[i], frond[i + 1], 0.95 * (1 - Math.abs(i - 4.5) / 6), 0.14, BRONZE);
  // The two figures at the foot of the pedestal.
  for (const s of [-1, 1]) {
    m.lathe(s * 4.6, -4.6, 6, [[0.9, 3.4], [0.8, 5], [0.55, 6.8], [0.32, 7.4], [0.01, 7.9]], BRONZE);
    m.beam([s * 4.6, 6.6, -4.6], [s * 4.6 + s * 0.8, 7.8, -5.2], 0.25, 0.25, BRONZE);
  }
  return [m];
}

const FORT = surf("ashlar", "#c8bc9f");
const FORT_TOP = surf("plain", "#b2a88f", 0.6);

export function citadella(ctx: HeroContext): Model[] {
  const m = new Model("citadella");
  const fp = ctx.footprint("relation/20421437", 0.5)[0];
  const [lo, hi] = ctx.groundRange(fp[0]);
  const top = hi + 9;
  m.walls(fp, lo - 3, top, FORT);
  m.cap(fp, top, FORT_TOP);
  // A parapet with embrasures round the outer wall.
  const outer = fp[0];
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % outer.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.floor(len / 3);
    const ux = (b[0] - a[0]) / len;
    const uz = (b[1] - a[1]) / len;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) * (len / n);
      m.orientedBox(a[0] + ux * t + uz * 0.4, a[1] + uz * t - ux * 0.4, 1.8, 0.8, Math.atan2(-uz, ux), top, top + 1.4, FORT);
    }
  }
  return [m];
}

const HOTEL = surf("secession", "#efe6d0");
const HOTEL_TRIM = surf("ashlar", "#f2ead8");
const HOTEL_ROOF = surf("copper", "#5d6a66", 0.35);
const HOTEL_DOME = surf("copper", "#6f8f86", 0.5);

export function gellertHotel(ctx: HeroContext): Model[] {
  const c = ctx.centre("gellertHotel");
  const g = ctx.ground(c.x, c.z);
  const m = new Model("gellertHotel").frame(c.x, g, c.z, 173.5);
  const world = ctx.footprint("way/46769968", 0.5)[0];
  const fp = world.map((r) => r.map(([x, z]) => m.local(x, z)));
  const [lo] = ctx.groundRange(world[0]);
  const H = 23;
  m.walls(fp, lo - g - 4, H, HOTEL);
  const cornice = insetPolygon(fp, -0.4);
  if (cornice) m.walls(cornice, H - 0.9, H, HOTEL_TRIM);
  m.mansard(fp, H, 4, 6, HOTEL_ROOF);
  // Domes: the baths' round corner to the north, the middle of the river front, its corners.
  const dome = (x: number, z: number, r: number, drum: number, lantern: boolean) => {
    m.prism(x, z, 12, r, H - 2, H + drum, HOTEL, null, Math.PI / 12);
    m.prism(x, z, 12, r + 0.5, H + drum, H + drum + 0.7, HOTEL_TRIM, HOTEL_TRIM, Math.PI / 12);
    const y = H + drum + 0.7;
    m.lathe(x, z, 12, [[r, y], [r * 0.96, y + r * 0.35], [r * 0.8, y + r * 0.7], [r * 0.52, y + r * 0.98], [r * 0.2, y + r * 1.15], [0.01, y + r * 1.2]], HOTEL_DOME, Math.PI / 12);
    if (lantern) {
      m.prism(x, z, 8, r * 0.18, y + r * 1.12, y + r * 1.12 + 2.2, HOTEL_TRIM, null, Math.PI / 8);
      m.pyramid(x, z, 8, r * 0.22, y + r * 1.12 + 2.2, 2.4, HOTEL_DOME, Math.PI / 8);
    }
  };
  dome(-21.7, 52.5, 7.5, 6, true);
  dome(-44, -7, 5.5, 7, true);
  dome(-41, 34, 3.6, 4.5, false);
  dome(-39.5, -51, 3.4, 4.5, false);
  for (const [x, z] of ngon(-44, -7, 4, 7.2, Math.PI / 4)) m.pyramid(x, z, 6, 0.6, H, 4, HOTEL_TRIM);
  return [m];
}
