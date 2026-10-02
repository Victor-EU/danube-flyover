// The Pest bank: the Central Market Hall (Samu Pecz, 1897) with its Zsolnay roof and front
// towers, three floodlit palaces of the riverfront on their OSM footprints (the Academy of
// Sciences, Gresham Palace, the Vigadó), and the Shoes on the Danube (Can Togay and Gyula
// Pauer, 2005): sixty pairs of iron shoes along the quay edge.

import { WORLD } from "../../src/config";
import { mulberry32 } from "../lib/geom";
import type { HeroContext } from "./context";
import { insetPolygon, Model, surf, type Surface } from "./kit";

const BRICK = surf("market", "#ffffff");
const ZSOLNAY = surf("zsolnay", "#ffffff", 0.45);
const STONE = surf("ashlar", "#e8dcc4");

export function marketHall(ctx: HeroContext): Model[] {
  const c = ctx.centre("marketHall");
  const g = ctx.ground(c.x, c.z);
  const m = new Model("marketHall").frame(c.x, g, c.z, 141.5);
  const world = ctx.footprint("way/24323859", 0.5)[0];
  const fp = world.map((r) => r.map(([x, z]) => m.local(x, z)));
  const [lo] = ctx.groundRange(world[0]);
  const H = 14;
  m.walls(fp, lo - g - 2, H, BRICK);
  // The great roof: a gable from the front (z = +86, toward Fővám tér), hipped at the back.
  m.gable(-29.7, 28.4, -62, 86, H, 16, ZSOLNAY, BRICK, false, 0.6);
  m.hip(-29.2, 27.9, -91, -55, H, 14, ZSOLNAY);
  // A glazed lantern along the ridge.
  m.box(-2.2, 2.2, -58, 80, H + 14.6, H + 17.2, surf("iron", "#4b5550", 0.4), null);
  m.gable(-2.2, 2.2, -58, 80, H + 17.2, 1.2, surf("iron", "#4b5550", 0.4), surf("iron", "#4b5550", 0.4));
  // The front towers, with tiled spires.
  for (const x of [-26.4, 25.1]) {
    m.box(x - 3.3, x + 3.3, 79.6, 86.2, lo - g - 2, 27, BRICK, null);
    m.box(x - 3.7, x + 3.7, 79.2, 86.6, 27, 28, STONE);
    m.pyramid(x, 82.9, 4, 4.6, 28, 10, ZSOLNAY, Math.PI / 4);
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

/** A riverfront palace on its footprint: facade walls, a cornice, a mansard roof. */
function palazzo(ctx: HeroContext, id: string, osm: string, wall: Surface, h: number, roof: Surface, inset: number, rise: number): Model[] {
  const m = new Model(id);
  const fp = ctx.footprint(osm, 0.4, 60)[0];
  const [lo, hi] = ctx.groundRange(fp[0]);
  const top = (lo + hi) / 2 + h;
  m.walls(fp, lo - 2, top, wall);
  const cornice = insetPolygon(fp, -0.4);
  if (cornice) m.walls(cornice, top - 1, top, surf("ashlar", wall.tint));
  m.mansard(fp, top, inset, rise, roof);
  return [m];
}

export const academy = (ctx: HeroContext) => palazzo(ctx, "academy", "relation/11772", surf("palace", "#e6d5b2"), 22, surf("copper", "#62706b", 0.3), 3.5, 4.5);
export const gresham = (ctx: HeroContext) => palazzo(ctx, "gresham", "relation/11847", surf("secession", "#e4d6ba"), 26, surf("copper", "#5c6965", 0.3), 3, 6);
export const vigado = (ctx: HeroContext) => palazzo(ctx, "vigado", "way/24038230", surf("secession", "#e6d2ac"), 24, surf("copper", "#606b67", 0.3), 4, 8);

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
