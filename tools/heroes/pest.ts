// The Pest bank: the Central Market Hall (Samu Pecz, 1897) with its Zsolnay roof and front
// towers, three floodlit palaces of the riverfront on their OSM footprints (the Academy of
// Sciences, Gresham Palace, the Vigadó), and the Shoes on the Danube (Can Togay and Gyula
// Pauer, 2005): sixty pairs of iron shoes along the quay edge.

import { HERO_LAYER, HERO_LAYERS, WORLD } from "../../src/config";
import { mulberry32, type Polygon, type Pt } from "../lib/geom";
import type { HeroContext } from "./context";
import { Facade, fitV, insetPolygon, Model, surf, type Surface, type UV } from "./kit";

const BRICK = surf("market", "#ffffff");
const ZSOLNAY = surf("zsolnay", "#ffffff", 0.45);
const STONE = surf("ashlar", "#e8dcc4");
/** Doorways and arches, dark; glass, dark from outside by day. */
const OPENING = surf("plain", "#2b2723", 0.15);
const GLASS = surf("metal", "#46525a", 0.25);

export function marketHall(ctx: HeroContext): Model[] {
  const c = ctx.centre("marketHall");
  const g = ctx.ground(c.x, c.z);
  const m = new Model("marketHall").frame(c.x, g, c.z, 141.5);
  const world = ctx.footprint("way/24323859", 0.5)[0];
  const fp = world.map((r) => r.map(([x, z]) => m.local(x, z)));
  const [lo] = ctx.groundRange(world[0]);
  const H = 14;
  const y0 = lo - g - 2;
  m.walls(fp, y0, H, BRICK);
  // Stone bands: the plinth, a course between the two rows of arched windows, the cornice.
  const V = fitV(BRICK, H - y0);
  m.band(fp, y0, lo - g + 0.9 - y0, 0.25, STONE);
  m.band(fp, y0 + (H - y0) / (V * 2) - 0.25, 0.5, 0.2, STONE);
  m.band(fp, H - 0.9, 0.9, 0.35, STONE);
  // Stone pilasters up the long walls, a tile of the brick apart, stopping under the eaves.
  fp[0].forEach((a, i) => {
    const f = new Facade(a, fp[0][(i + 1) % fp[0].length]);
    if (f.len < 30 || f.out[1] > 0.9) return;
    const bays = Math.round((f.len * 2) / 10);
    for (let k = 2; k < bays - 1; k += 2) {
      const s = (f.len * k) / bays;
      const r = f.block(s - 0.45, s + 0.45, 0, 0.45);
      m.walls(r, y0, H - 0.5, STONE);
      m.cap(r, H - 0.5, STONE);
    }
  });
  // The great roof: a gable from the front (z = +86, toward Fővám tér), hipped at the back.
  m.gable(-29.7, 28.4, -62, 86, H, 16, ZSOLNAY, BRICK, false, 0.6);
  m.hip(-29.2, 27.9, -91, -55, H, 14, ZSOLNAY);
  // A glazed lantern along the ridge.
  m.box(-2.2, 2.2, -58, 80, H + 14.6, H + 17.2, surf("iron", "#4b5550", 0.4), null);
  m.gable(-2.2, 2.2, -58, 80, H + 17.2, 1.2, surf("iron", "#4b5550", 0.4), surf("iron", "#4b5550", 0.4));
  // The front: the main gate and two side doors, the great arched window in the gable over
  // them, and the towers.
  const front = new Facade(fp[0][9], fp[0][0]);
  const at = (x: number) => (front.a[0] - x) / -front.u[0];
  const gate = (x: number, w: number, spring: number) => {
    const [wx, wz] = (([p, , q]) => [p, q])(m.world([x, 0, 86]));
    const gy = ctx.ground(wx, wz) - g;
    m.portal(front, at(x), w, gy - 0.2, gy + spring, OPENING, STONE, { band: w * 0.14, proud: 0.55 });
  };
  gate(-0.65, 6.4, 6.4);
  gate(-13.5, 3.2, 3.6);
  gate(12.2, 3.2, 3.6);
  const gableWall = new Facade([28.4, 86], [-29.7, 86]);
  m.portal(gableWall, 28.4 + 0.65, 8.4, H + 0.6, H + 6.2, GLASS, STONE, { band: 0.8, proud: 0.4 });
  for (const x of [-26.4, 25.1]) {
    m.box(x - 3.3, x + 3.3, 79.6, 86.2, y0, 27, BRICK, null);
    m.box(x - 3.6, x + 3.6, 79.3, 86.5, 25.8, 27, STONE, null);
    m.box(x - 3.7, x + 3.7, 79.2, 86.6, 27, 28, STONE);
    // Belfry arches on the front and the outer side.
    m.portal(new Facade([x + 3.3, 86.2], [x - 3.3, 86.2]), 3.3, 2.2, 19.6, 22.8, OPENING, STONE, { band: 0.35, proud: 0.2 });
    const side = x < 0 ? new Facade([x - 3.3, 86.2], [x - 3.3, 79.6]) : new Facade([x + 3.3, 79.6], [x + 3.3, 86.2]);
    m.portal(side, 3.3, 2.2, 19.6, 22.8, OPENING, STONE, { band: 0.35, proud: 0.2 });
    // A tiled spire with a gablet on each face, a pinnacle at each corner.
    m.pyramid(x, 82.9, 4, 4.6, 28, 14, ZSOLNAY, Math.PI / 4);
    m.prism(x, 82.9, 4, 0.12, 42, 44, STONE, STONE);
    const sq: Pt[] = [[x + 3.25, 86.15], [x - 3.25, 86.15], [x - 3.25, 79.65], [x + 3.25, 79.65]];
    for (let i = 0; i < 4; i++) m.dormer(new Facade(sq[i], sq[(i + 1) % 4]), 3.25, 1.7, 27.6, 2.2, 0.15, 1.7, BRICK, ZSOLNAY);
    for (const [px, pz] of sq) {
      m.prism(px, pz, 4, 0.45, 28, 29.4, STONE, null, Math.PI / 4);
      m.pyramid(px, pz, 4, 0.55, 29.4, 2.6, ZSOLNAY, Math.PI / 4);
    }
  }
  // Pinnacles along the front gable.
  for (let k = 1; k < 6; k++) {
    const x = -29.7 + (58.1 * k) / 6;
    const y = H + 16 * (1 - Math.abs(x - -0.65) / 29.05);
    m.prism(x, 86.3, 4, 0.5, y, y + 2.2, STONE, null, Math.PI / 4);
    m.pyramid(x, 86.3, 4, 0.55, y + 2.2, 1.6, ZSOLNAY, Math.PI / 4);
  }
  return [m];
}

// --- The riverfront palaces --------------------------------------------------------------


/** A palace's body and what its fronts are built against. */
interface Body {
  fp: Polygon;
  lo: number;
  base: number;
  /** The top of the cornice. */
  top: number;
  /** Tiles the walls' texture takes from base to top (bays rise on from there). */
  V: number;
  storey: number;
  wall: Surface;
  trim: Surface;
  roof: Surface;
}

/**
 * A riverfront palace on its footprint: facade walls with a stone plinth, a string course
 * over the ground floor and a cornice, a parapet, and a mansard roof behind it.
 */
function palazzo(ctx: HeroContext, m: Model, osm: string, wall: Surface, trim: Surface, roof: Surface, h: number, inset: number, rise: number): Body {
  const fp = ctx.footprint(osm, 0.4, 60)[0];
  const [lo, hi] = ctx.groundRange(fp[0]);
  const base = lo - 2;
  const top = (lo + hi) / 2 + h;
  const V = fitV(wall, top - base);
  const storey = (top - base) / (V * HERO_LAYERS[HERO_LAYER[wall.layer]].rows);
  m.walls(fp, base, top, wall);
  m.band(fp, base, lo + 0.9 - base, 0.25, trim);
  const course = base + storey * Math.ceil((lo + 3.5 - base) / storey);
  m.band(fp, course - 0.4, 0.4, 0.2, trim);
  m.band(fp, top - 1, 1, 0.45, trim);
  m.parapet(fp[0], top, 1, 0.35, trim);
  m.mansard(insetPolygon(fp, 0.35) ?? fp, top, inset, rise, roof);
  return { fp, lo, base, top, V, storey, wall, trim, roof };
}

/** The front along an edge of the footprint's outer ring. */
const front = (b: Body, edge: number) => new Facade(b.fp[0][edge], b.fp[0][(edge + 1) % b.fp[0].length]);

type Crown = "mansard" | "gable" | "turrets" | "statues";

/**
 * A bay standing `proud` out of a front, from s0 to s1 along it and reaching `back` into the
 * building, its facade rising `rise` over the cornice (the next storey's windows), under its
 * own cornice and crown: a pavilion roof, a curved gable, a crenellated parapet between two
 * domed turrets, or a parapet with statues. Returns the bay's front, measured from s0.
 */
function bay(m: Model, b: Body, f: Facade, s0: number, s1: number, proud: number, back: number, rise: number, crown: Crown): Facade {
  const ring = f.block(s0, s1, -back, proud);
  const y = b.top + rise;
  for (let i = 0; i < 4; i++) {
    const [p, q] = [ring[i], ring[(i + 1) % 4]];
    m.wall(p, q, b.base, b.top, b.wall);
    m.wall(p, q, b.top, y, b.wall, { v0: b.V });
  }
  m.band([ring], b.base, b.lo + 0.9 - b.base, 0.25, b.trim);
  m.band([ring], b.top - 1, 1, 0.45, b.trim);
  m.band([ring], y - 0.8, 0.8, 0.45, b.trim);
  const face = f.offset(proud);
  const own = new Facade(face.pt(s0), face.pt(s1));
  const w = s1 - s0;
  if (crown === "mansard") {
    m.mansard([ring], y, Math.min(w, back + proud) * 0.32, 4, b.roof);
    return own;
  }
  m.cap(ring, y, b.roof);
  if (crown === "gable") {
    // A segmental gable, 0.8 m thick, over the bay's front.
    const n = 10;
    const crest = Math.min(7, w * 0.33);
    const arc = Array.from({ length: n + 1 }, (_, k) => {
      const t = k / n;
      return [s0 + w * t, y + crest * Math.sin(Math.PI * t)] as UV;
    });
    const at = (p: UV, d: number) => face.at(p[0], p[1], d);
    const l = HERO_LAYERS[HERO_LAYER[b.wall.layer]];
    m.faceToward(arc.map((p) => at(p, 0)), arc.map(([x, yy]) => [(x - s0) / l.tile[0], (yy - y) / l.tile[1]]), b.wall, face.toward);
    m.faceToward(arc.map((p) => at(p, -0.8)), arc.map(([x, yy]) => [(x - s0) / l.tile[0], (yy - y) / l.tile[1]]), b.trim, [-face.toward[0], 0, -face.toward[2]]);
    for (let k = 0; k < n; k++) {
      const [p, q] = [arc[k], arc[k + 1]];
      m.faceToward([at(p, 0.2), at(q, 0.2), at(q, -0.9), at(p, -0.9)], [[0, 0], [0.3, 0], [0.3, 0.2], [0, 0.2]], b.trim, [0, 1, 0]);
    }
    // A great arched window in the gable.
    m.portal(face, (s0 + s1) / 2, w * 0.36, y + 0.6, y + crest - w * 0.18 - 0.4, GLASS, b.trim, { band: 0.45, proud: 0.25 });
    return own;
  }
  m.parapet(ring, y, 1, 0.3, b.trim);
  if (crown === "statues") {
    // One at each front corner, and two between on a wide bay.
    const n = w < 12 ? 2 : 4;
    for (let k = 0; k < n; k++) {
      const p = face.pt(s0 + 0.6 + ((w - 1.2) * k) / (n - 1), -0.15);
      m.statue(p[0], p[1], y + 1, 2.9, b.trim);
    }
    return own;
  }
  // Turrets: merlons along the parapet, and an octagonal turret at each front corner under an
  // onion dome.
  const merlon = 1.3;
  for (let x = s0 + 1.6; x < s1 - 1.6; x += merlon * 2) {
    const r = face.block(x, x + merlon, -0.3, 0);
    m.walls(r, y + 1, y + 2, b.trim);
    m.cap(r, y + 2, b.trim);
  }
  for (const x of [s0, s1]) {
    const [cx, cz] = face.pt(x, -0.4);
    m.prism(cx, cz, 8, 1.5, y - 3, y + 4.5, b.trim, null, Math.PI / 8);
    m.prism(cx, cz, 8, 1.75, y + 4.5, y + 5.1, b.trim, b.trim, Math.PI / 8);
    m.lathe(cx, cz, 8, [[1.5, y + 5.1], [1.95, y + 6.1], [1.6, y + 7.2], [0.6, y + 8.3], [0.12, y + 9.4], [0, y + 9.9]], b.roof, Math.PI / 8);
  }
  return own;
}

/** Arched doorways on a front, w wide, centred at each s, their arches springing `spring` above the ground. */
function doors(ctx: HeroContext, m: Model, b: Body, f: Facade, at: number[], w: number, spring: number): void {
  for (const s of at) {
    const [x, z] = f.pt(s);
    const g = ctx.ground(x, z);
    m.portal(f, s, w, g - 0.2, g + spring, OPENING, b.trim, { band: Math.min(0.7, w * 0.16), proud: 0.35 });
  }
}

/** Dormers on the mansard behind a front, every `step` metres from s0 to s1. */
function dormers(m: Model, b: Body, f: Facade, s0: number, s1: number, step: number, inset: number, rise: number): void {
  const n = Math.max(1, Math.round((s1 - s0) / step));
  for (let k = 0; k < n; k++) {
    const s = s0 + ((s1 - s0) * (k + 0.5)) / n;
    // The window wall stands a third of the way up the slope.
    m.dormer(f, s, 1.8, b.top + rise * 0.3 - 0.4, 2.2, 0.35 + inset * 0.3, inset * 0.7, b.wall, b.roof);
  }
}

/**
 * The Hungarian Academy of Sciences (Friedrich August Stüler, 1865), neo-Renaissance: corner
 * pavilions on the Danube front and statues of six scholars at the corners, the main hall's
 * bay in the middle, and the entrance front on Roosevelt tér with its three arched doorways.
 */
export function academy(ctx: HeroContext): Model[] {
  const m = new Model("academy");
  const STONE = surf("ashlar", "#e2d4b6");
  const b = palazzo(ctx, m, "relation/11772", surf("palace", "#e6d5b2"), STONE, surf("copper", "#62706b", 0.3), 22, 3.5, 4.5);
  const river = front(b, 6);
  bay(m, b, river, 0, 9.5, 0.7, 8, b.storey, "statues");
  bay(m, b, river, river.len - 9.5, river.len, 0.7, 8, b.storey, "statues");
  bay(m, b, river, river.len / 2 - 9, river.len / 2 + 9, 0.9, 10, b.storey, "mansard");
  dormers(m, b, river, 11, river.len / 2 - 10, 5.5, 3.5, 4.5);
  dormers(m, b, river, river.len / 2 + 10, river.len - 11, 5.5, 3.5, 4.5);
  const square = front(b, 3);
  const entrance = bay(m, b, square, square.len / 2 - 8, square.len / 2 + 8, 0.6, 6, b.storey, "mansard");
  doors(ctx, m, b, entrance, [5, 8, 11], 2.2, 3.4);
  const north = front(b, 7);
  bay(m, b, north, north.len - 9.5, north.len, 0.7, 8, b.storey, "statues");
  return [m];
}

/**
 * Gresham Palace (Zsigmond Quittner and the Vágó brothers, 1906), Art Nouveau, facing the
 * Chain Bridge: the arched gateway to its arcade in the middle under a curved gable, and a
 * pavilion at either end.
 */
export function gresham(ctx: HeroContext): Model[] {
  const m = new Model("gresham");
  const b = palazzo(ctx, m, "relation/11847", surf("secession", "#e4d6ba"), surf("ashlar", "#e0d3b8"), surf("copper", "#5c6965", 0.3), 26, 3, 6);
  const f = front(b, 4);
  const mid = bay(m, b, f, f.len / 2 - 9, f.len / 2 + 9, 1, 9, b.storey, "gable");
  doors(ctx, m, b, mid, [9], 6, 6.5);
  bay(m, b, f, 0, 10, 0.6, 8, b.storey, "mansard");
  bay(m, b, f, f.len - 10, f.len, 0.6, 8, b.storey, "mansard");
  dormers(m, b, f, 11.5, f.len / 2 - 10.5, 5, 3, 6);
  dormers(m, b, f, f.len / 2 + 10.5, f.len - 11.5, 5, 3, 6);
  return [m];
}

/**
 * The Vigadó (Frigyes Feszl, 1865), Hungarian Romantic, on the Danube promenade: an arcade of
 * five arches under the concert hall's tall windows, crowned by a crenellated attic between two
 * turrets, and a pavilion at either end.
 */
export function vigado(ctx: HeroContext): Model[] {
  const m = new Model("vigado");
  const b = palazzo(ctx, m, "way/24038230", surf("secession", "#e6d2ac"), surf("ashlar", "#e4d2b0"), surf("copper", "#606b67", 0.3), 24, 4, 8);
  const f = front(b, 6);
  const mid = bay(m, b, f, f.len / 2 - 11, f.len / 2 + 11, 1.2, 10, 2.4, "turrets");
  doors(ctx, m, b, mid, [3, 7, 11, 15, 19], 2.8, 3.6);
  bay(m, b, f, 0, 7.5, 0.6, 8, b.storey, "mansard");
  bay(m, b, f, f.len - 7.5, f.len, 0.6, 8, b.storey, "mansard");
  dormers(m, b, f, 9, f.len / 2 - 12.5, 5, 4, 8);
  dormers(m, b, f, f.len / 2 + 12.5, f.len - 9, 5, 4, 8);
  return [m];
}

const IRON = surf("metal", "#2f2b27", 0.3);

export function shoes(ctx: HeroContext): Model[] {
  const c = ctx.centre("shoes");
  const m = new Model("shoes").frame(c.x, WORLD.quayHeight, c.z, 173);
  const r = mulberry32(1944);
  for (let k = 0; k < 60; k++) {
    const z = -20 + (40 * (k + 0.5)) / 60 + (r() - 0.5) * 0.3;
    const x = (r() - 0.5) * 0.7;
    const yaw = (r() - 0.5) * 1.2 + (r() < 0.2 ? Math.PI : 0);
    // A pair: two low boxes side by side, turned together (men's, women's, children's sizes).
    const size = r() < 0.15 ? 0.7 : r() < 0.5 ? 0.85 : 1;
    for (const s of [-1, 1]) {
      const sx = x + Math.cos(yaw) * s * 0.09 * size;
      const sz = z - Math.sin(yaw) * s * 0.09 * size;
      m.orientedBox(sx, sz, 0.11 * size, 0.29 * size, yaw, 0, 0.11 * size, IRON);
    }
  }
  return [m];
}
