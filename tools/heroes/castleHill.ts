// Castle Hill: Fisherman's Bastion (Frigyes Schulek, 1895–1902), Matthias Church (rebuilt by
// Schulek, 1874–96) and Buda Castle, the Royal Palace (its present form by Alajos Hauszmann
// and Miklós Ybl, 1890s–1912). Each sits on its OSM footprint, its walls reaching down to the
// lowest ground under it, since the hill falls away toward the river.

import type { Pt, Ring } from "../lib/geom";
import type { HeroContext } from "./context";
import { insetPolygon, Model, ngon, surf, type Surface } from "./kit";

// --- Fisherman's Bastion ------------------------------------------------------------------

const BASTION = surf("arcade", "#f2eee5");
const BASTION_TOP = surf("ashlar", "#ebe6dc");
const BASTION_CONE = surf("tiles", "#d7d1c5", 0.7);

/** The seven towers (world x, z, radius, height above the walk), for the seven Magyar tribes. */
const BASTION_TOWERS: [number, number, number, number][] = [
  [-673, -428, 6.2, 19],
  [-697, -429, 3.0, 10],
  [-663, -401, 3.4, 11],
  [-671, -382, 4.2, 14],
  [-662, -346, 3.4, 11],
  [-642, -317, 4.0, 12],
  [-660, -307, 4.4, 13],
];

export function bastion(ctx: HeroContext): Model[] {
  const m = new Model("bastion");
  const fp = ctx.footprint("relation/17948384", 0.35)[0];
  const [lo, hi] = ctx.groundRange(fp[0]);
  const walk = hi - 1.5;
  // Plain stone walls down the hillside; the cloisters' arches only along the top.
  m.walls(fp, lo - 3, walk - 0.6, BASTION_TOP);
  m.walls(fp, walk - 0.6, walk + 5.5, BASTION);
  m.cap(fp, walk + 5.5, BASTION_TOP);
  merlons(m, fp[0], walk + 5.5, 0.9, 1.7, BASTION_TOP);
  for (const [x, z, r, h] of BASTION_TOWERS) {
    const g = Math.min(lo, ctx.ground(x, z)) - 3;
    m.prism(x, z, 8, r, g, walk + 1, BASTION_TOP, null, Math.PI / 8);
    m.prism(x, z, 8, r, walk + 1, walk + h, BASTION, null, Math.PI / 8);
    m.prism(x, z, 8, r + 0.45, walk + h, walk + h + 0.8, BASTION_TOP, BASTION_TOP, Math.PI / 8);
    m.pyramid(x, z, 8, r + 0.3, walk + h + 0.8, r * 2.5, BASTION_CONE, Math.PI / 8);
    m.prism(x, z, 4, 0.12, walk + h + 0.8 + r * 2.5, walk + h + 1.6 + r * 2.5, BASTION_TOP, BASTION_TOP);
    // Small turrets round the biggest towers' feet.
    if (r > 4) for (const [px, pz] of ngon(x, z, 4, r + 0.6, Math.PI / 8)) m.pyramid(px, pz, 6, 0.9, walk + h - 1, 3.4, BASTION_CONE);
  }
  return [m];
}

/** Merlons along a ring's top edge: w wide, h high, every `step` metres. */
function merlons(m: Model, ring: Ring, y: number, h: number, step: number, s: Surface): void {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.floor(len / step);
    const ux = (b[0] - a[0]) / len;
    const uz = (b[1] - a[1]) / len;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) * (len / n);
      const cx = a[0] + ux * t + uz * 0.2;
      const cz = a[1] + uz * t - ux * 0.2;
      m.orientedBox(cx, cz, step * 0.45, 0.4, Math.atan2(-uz, ux), y, y + h, s);
    }
  }
}

// --- Matthias Church -----------------------------------------------------------------------

const CHURCH = surf("lancet", "#ebe5d7");
const CHURCH_STONE = surf("ashlar", "#e6dfd0");
const ZSOLNAY = surf("zsolnay", "#ffffff", 0.45);
const SPIRE = surf("ashlar", "#d9d1c0", 0.9);

export function matthias(ctx: HeroContext): Model[] {
  const c = ctx.centre("matthias");
  const g = ctx.ground(c.x, c.z);
  const m = new Model("matthias").frame(c.x, g, c.z, 69);
  const [lo] = ctx.groundRange(ctx.footprint("way/37135081", 0.4)[0][0]);
  const y0 = lo - g - 3;
  // The hall: one big roof over nave and aisles (z runs west to east as -along).
  const [hx0, hx1, hz0, hz1] = [-17.4, 16.8, -20.5, 28.2];
  m.box(hx0, hx1, hz0, hz1, y0, 17, CHURCH, null);
  m.gable(hx0, hx1, hz0, hz1, 17, 19, ZSOLNAY, CHURCH, false, 0.5);
  // The chancel and its polygonal apse to the east.
  m.box(-3.4, 15.7, -26.4, -14.7, y0, 16, CHURCH, null);
  m.gable(-3.4, 15.7, -26.4, -14.7, 16, 12, ZSOLNAY, CHURCH, false, 0.4);
  apse(m, 6.15, -26.4, 9.5, y0, 16, 9);
  // The Matthias tower, south-west: square, then two octagonal stages and the spire.
  const [tx, tz] = [19.2, 17.6];
  m.box(tx - 4.3, tx + 4.3, tz - 4.3, tz + 4.3, y0, 34, CHURCH, CHURCH_STONE);
  for (const [px, pz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) m.pyramid(tx + px * 3.9, tz + pz * 3.9, 4, 0.75, 34, 5.5, SPIRE, Math.PI / 4);
  m.prism(tx, tz, 8, 4.0, 34, 51, CHURCH, null, Math.PI / 8);
  m.prism(tx, tz, 8, 4.6, 51, 52.2, CHURCH_STONE, CHURCH_STONE, Math.PI / 8);
  for (const [px, pz] of ngon(tx, tz, 8, 4.1, Math.PI / 8)) m.pyramid(px, pz, 4, 0.45, 52.2, 3.5, SPIRE, Math.PI / 4);
  m.prism(tx, tz, 8, 3.2, 52.2, 59, CHURCH, null, Math.PI / 8);
  m.pyramid(tx, tz, 8, 3.5, 59, 20, SPIRE, Math.PI / 8);
  m.prism(tx, tz, 4, 0.15, 79, 81, SPIRE, SPIRE);
  // The Béla tower, north-west, under a tiled spire.
  m.box(-13.3, -9.9, 19.2, 23.3, y0, 24, CHURCH_STONE, null);
  m.pyramid(-11.6, 21.25, 8, 2.6, 24, 8, ZSOLNAY, Math.PI / 8);
  return [m];
}

/** A half-octagon apse at the end of a chancel (open toward +z), with a half-pyramid roof. */
function apse(m: Model, cx: number, cz: number, r: number, y0: number, y1: number, rise: number): void {
  const pts: Pt[] = [];
  for (let i = 0; i <= 4; i++) {
    const a = Math.PI + (i / 4) * Math.PI;
    pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r * 0.62]);
  }
  for (let i = 0; i < 4; i++) m.faceToward([[pts[i][0], y0, pts[i][1]], [pts[i + 1][0], y0, pts[i + 1][1]], [pts[i + 1][0], y1, pts[i + 1][1]], [pts[i][0], y1, pts[i][1]]], [[0, 0], [0.5, 0], [0.5, 1], [0, 1]], CHURCH, [(pts[i][0] + pts[i + 1][0]) / 2 - cx, 0, (pts[i][1] + pts[i + 1][1]) / 2 - cz]);
  const apex: [number, number, number] = [cx, y1 + rise, cz];
  for (let i = 0; i < 4; i++) m.faceToward([[pts[i][0], y1, pts[i][1]], [pts[i + 1][0], y1, pts[i + 1][1]], apex], [[0, 0], [1.2, 0], [0.6, 1.6]], ZSOLNAY, [(pts[i][0] + pts[i + 1][0]) / 2 - cx, 2, (pts[i][1] + pts[i + 1][1]) / 2 - cz]);
}

// --- Buda Castle --------------------------------------------------------------------------

const PALACE = surf("palace", "#e4d6b8");
const PALACE_TRIM = surf("ashlar", "#ebe0c8");
const PALACE_ROOF = surf("copper", "#5f766b", 0.35);
const PALACE_DOME = surf("copper", "#73a08c", 0.9);

export function palace(ctx: HeroContext): Model[] {
  const c = ctx.centre("palace");
  const g = ctx.ground(c.x, c.z);
  const m = new Model("palace").frame(c.x, g, c.z, 139);
  const world = ctx.footprint("relation/6486918", 0.8, 300)[0];
  const fp = world.map((r) => r.map(([x, z]) => m.local(x, z)));
  const [lo] = ctx.groundRange(world[0]);
  const H = 26;
  m.walls(fp, lo - g - 5, H, PALACE);
  const cornice = insetPolygon(fp, -0.45);
  if (cornice) m.walls(cornice, H - 1.1, H, PALACE_TRIM);
  m.mansard(fp, H, 5, 6.5, PALACE_ROOF);
  // The dome over the middle of the river front: drum, a ring of columns, the copper dome,
  // the lantern.
  const [dx, dz] = [-33, 31];
  const n = 16;
  m.prism(dx, dz, n, 12.2, H - 2, H + 12, PALACE, null, Math.PI / n);
  for (const [px, pz] of ngon(dx, dz, n, 13.4, 0)) m.prism(px, pz, 6, 0.55, H + 1, H + 10.6, PALACE_TRIM, null);
  m.prism(dx, dz, n, 14.1, H + 10.6, H + 12, PALACE_TRIM, PALACE_TRIM, Math.PI / n);
  m.prism(dx, dz, n, 13.4, H, H + 1, PALACE_TRIM, PALACE_TRIM, Math.PI / n);
  m.lathe(dx, dz, n, [[12.6, H + 12], [12.3, H + 16], [11.2, H + 20], [9.2, H + 24], [6.4, H + 27.4], [3.4, H + 29.5], [2.2, H + 30.1]], PALACE_DOME, Math.PI / n);
  m.prism(dx, dz, 8, 2.2, H + 30, H + 34.5, PALACE_TRIM, null, Math.PI / 8);
  m.lathe(dx, dz, 8, [[2.6, H + 34.5], [2.2, H + 36], [1.0, H + 37.4], [0.3, H + 38.2]], PALACE_DOME, Math.PI / 8);
  m.prism(dx, dz, 4, 0.14, H + 38.2, H + 40.5, PALACE_TRIM, PALACE_TRIM);
  return [m];
}
