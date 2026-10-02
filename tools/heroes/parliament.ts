// The Hungarian Parliament (Imre Steindl, 1885–1904), on its OSM footprint: the long river
// wing, the central block round the dome and the east wing to Kossuth tér. Raised above it:
// the river pavilion in front of the dome, the two chamber blocks with steep roofs and four
// spired towers each, the end pavilions with corner turrets, the east entrance, and the
// 16-sided drum with its ribbed dome, lantern and spire, 96 m up. Every buttress on the
// outer walls carries a pinnacle. Local frame: origin at the dome, -z along the river wing
// (heading 6.5°, so north), +x east, toward the city.

import type { Ring } from "../lib/geom";
import type { HeroContext } from "./context";
import { ensureCcw, Model, ngon, surf, type Surface, type V3 } from "./kit";

const WALL = surf("gothic", "#eddcbd");
const PLINTH = surf("ashlar", "#d9caa9");
const STONE = surf("ashlar", "#efe2c6");
const ROOF = surf("tiles", "#97402f", 0.3);
const DOME = surf("tiles", "#8d3b2e", 0.8);
const RIB = surf("ashlar", "#f1e5cb", 0.9);

const BASE_H = 24;
const PLINTH_H = 1.2;
/** Pinnacles every bay of the facade texture (HERO_LAYERS gothic: 2 bays per 8.8 m tile). */
const BAY = 4.4;

export function parliament(ctx: HeroContext): Model[] {
  const c = ctx.centre("parliament");
  const m = new Model("parliament").frame(c.x, ctx.ground(c.x, c.z), c.z, 6.5);
  const fp = ctx.footprint("relation/3199085", 0.6, 300)[0].map((r) => r.map(([x, z]) => m.local(x, z)));

  // The base mass: plinth, four storeys of tracery windows, a steep roof with a flat top.
  m.walls(fp, -4, PLINTH_H, PLINTH);
  m.walls(fp, PLINTH_H, BASE_H, WALL);
  m.mansard(fp, BASE_H, 6.5, 9.5, ROOF);
  crown(m, fp[0], BASE_H);

  // Raised blocks, each 0.3 m proud of the facade below.
  const block = (x0: number, x1: number, z0: number, z1: number, h: number, rise: number, turrets?: { r: number; h: number; spire: number }) => {
    m.box(x0, x1, z0, z1, -4, PLINTH_H, PLINTH, null);
    m.box(x0, x1, z0, z1, PLINTH_H, h, WALL, null);
    m.hip(x0, x1, z0, z1, h, rise, ROOF);
    crown(m, ensureCcw([[x0, z1], [x1, z1], [x1, z0], [x0, z0]]), h);
    if (turrets) for (const x of [x0, x1]) for (const z of [z0, z1]) turret(m, x, z, h - 6, turrets.r, turrets.h, turrets.spire);
  };
  // The river pavilion in front of the dome.
  block(-47.4, -30, -26.2, 25.6, 30, 10, { r: 1.6, h: 35, spire: 8 });
  // The two chambers, north and south of the dome.
  for (const s of [-1, 1]) {
    const [z0, z1] = s < 0 ? [-80.5, -43.5] : [43.5, 80.5];
    block(-33, 13.3, z0, z1, 31, 15, { r: 1.9, h: 41, spire: 15 });
  }
  // The end pavilions.
  block(-42.8, 22.9, -127.3, -102.8, 28, 11, { r: 1.7, h: 34, spire: 9 });
  block(-42.3, 23.1, 102.4, 126.5, 28, 11, { r: 1.7, h: 34, spire: 9 });
  // The east entrance on Kossuth tér.
  block(47.5, 71.9, -15.4, 14.1, 29, 9, { r: 1.5, h: 34, spire: 7 });

  dome(m);
  return [m];
}

/**
 * A corner turret: an octagonal shaft rising from the cornice, a gallery, a slim spire, and
 * four pinnacles round its foot.
 */
function turret(m: Model, x: number, z: number, y0: number, r: number, top: number, spire: number): void {
  const rot = Math.PI / 8;
  m.prism(x, z, 8, r, y0, top, STONE, null, rot, r * 0.9);
  m.prism(x, z, 8, r * 1.25, top, top + 0.9, STONE, STONE, rot);
  for (const [px, pz] of ngon(x, z, 4, r * 1.1, Math.PI / 4)) m.pyramid(px, pz, 4, r * 0.24, top + 0.9, spire * 0.28, STONE, Math.PI / 4);
  m.prism(x, z, 8, r * 0.78, top + 0.9, top + 3.2, STONE, null, rot);
  m.pyramid(x, z, 8, r * 0.85, top + 3.2, spire, STONE, rot);
}

/** The drum, the ribbed dome, the lantern and the spire. */
function dome(m: Model): void {
  const n = 16;
  const rot = -Math.PI / n; // a flat face toward the river
  m.prism(0, 0, n, 15.5, 18, 50, WALL, null, rot);
  m.prism(0, 0, n, 16.4, 50, 51.4, STONE, STONE, rot);
  // A pinnacle at every corner of the drum, round the foot of the dome.
  for (const [x, z] of ngon(0, 0, n, 16.1, rot)) {
    m.prism(x, z, 4, 0.75, 51.4, 54.5, STONE, null, Math.PI / 4);
    m.pyramid(x, z, 4, 0.85, 54.5, 5.5, STONE, Math.PI / 4);
  }
  const profile: [number, number][] = [
    [15.2, 51.4],
    [14.9, 56],
    [13.9, 61],
    [12.1, 66],
    [9.6, 70.5],
    [6.6, 74.5],
    [3.6, 77.8],
    [2.5, 79],
  ];
  m.lathe(0, 0, n, profile, DOME, rot);
  // Ribs up every corner of the dome.
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    const pts: V3[] = profile.map(([r, y]) => [Math.cos(a) * (r + 0.25), y, Math.sin(a) * (r + 0.25)]);
    for (let k = 0; k < pts.length - 1; k++) m.beam(pts[k], pts[k + 1], 0.75, 0.55, RIB);
  }
  m.prism(0, 0, 8, 2.6, 79, 85, STONE, null, Math.PI / 8);
  m.prism(0, 0, 8, 3.0, 85, 86, STONE, STONE, Math.PI / 8);
  m.pyramid(0, 0, 8, 2.2, 86, 12.5, DOME, Math.PI / 8);
  m.prism(0, 0, 4, 0.18, 98.5, 100.5, STONE, STONE);
}

/** Buttress strips up the outer walls, one per bay, each with a pinnacle above the parapet. */
function crown(m: Model, ring: Ring, top: number, s: Surface = STONE): void {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 2.5) continue;
    const ux = (b[0] - a[0]) / len;
    const uz = (b[1] - a[1]) / len;
    const nx = uz; // outward for a counter-clockwise ring
    const nz = -ux;
    const bays = Math.max(1, Math.round(len / BAY));
    for (let k = 0; k < bays; k++) {
      const t = (len * k) / bays;
      const px = a[0] + ux * t;
      const pz = a[1] + uz * t;
      const w = k === 0 ? 1.3 : 0.9;
      const d = 0.75;
      const strip = ensureCcw([
        [px - ux * (w / 2), pz - uz * (w / 2)],
        [px + ux * (w / 2), pz + uz * (w / 2)],
        [px + ux * (w / 2) + nx * d, pz + uz * (w / 2) + nz * d],
        [px - ux * (w / 2) + nx * d, pz - uz * (w / 2) + nz * d],
      ]);
      m.walls(strip, -4, top + 1.4, s);
      m.cap(strip, top + 1.4, s);
      const cx = px + nx * (d / 2);
      const cz = pz + nz * (d / 2);
      m.pyramid(cx, cz, 4, k === 0 ? 0.95 : 0.65, top + 1.4, k === 0 ? 5.5 : 4.2, s, Math.atan2(uz, ux) + Math.PI / 4);
    }
  }
}
