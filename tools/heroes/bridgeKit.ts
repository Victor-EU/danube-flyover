// Shared parts of the hero bridges: the deck slab on its OSM outline (the same geometry the
// runtime queries), railings along the deck edges, cutwater piers, lamp posts at the night
// lights' lamp positions, and sampling along the deck axis.

import { HERO_LAYER, HERO_LAYERS } from "../../src/config";
import type { BridgeJson } from "../../src/world/bridges";
import type { HeroContext } from "./context";
import { ensureCcw, type Model, type Surface, type V3 } from "./kit";

/** Compass heading of a direction (ux, uz) in the world's x east, z south. */
export const headingOf = (ux: number, uz: number) => (Math.atan2(ux, -uz) * 180) / Math.PI;

/**
 * The deck slab: road on top, girder faces on the sides, the soffit underneath. The
 * triangulation has long slivers, so the road and soffit want a layer with a large tile.
 */
export function deck(m: Model, ctx: HeroContext, def: BridgeJson, road: Surface, side: Surface, under: Surface): void {
  const pos = ctx.bridges.deckGeometry(def).attributes.position.array as Float32Array;
  const [ax, az] = axisDir(def);
  // Texture coordinates from the bridge's middle, so they stay small enough to quantise.
  const n = def.axis.length;
  const cx = (def.axis[0] + def.axis[n - 2]) / 2;
  const cz = (def.axis[1] + def.axis[n - 1]) / 2;
  const tile = (s: Surface) => HERO_LAYERS[HERO_LAYER[s.layer]].tile;
  for (let k = 0; k < pos.length; k += 9) {
    const p: V3[] = [0, 1, 2].map((i) => [pos[k + i * 3], pos[k + i * 3 + 1], pos[k + i * 3 + 2]] as V3);
    const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nl = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], ny, e1[0] * e2[1] - e1[1] * e2[0]);
    // Skip the triangulation's degenerate slivers (thinner than 10 cm).
    const maxEdge = Math.max(Math.hypot(...e1), Math.hypot(...e2), Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1], p[2][2] - p[1][2]));
    if (nl / maxEdge < 0.2) continue;
    const up = ny / (nl || 1);
    // Girder faces are short (the outline is cut every 4 m); anything longer is a sliver of
    // the road or the soffit, tilted by the ramp.
    const s = up > 0.6 || (maxEdge > 30 && up >= 0) ? road : up < -0.6 || maxEdge > 30 ? under : side;
    const [tw, th] = tile(s);
    const uv = p.map(([x, y, z]) => (s !== side ? [(x - cx) / tw, (z - cz) / th] : [((x - cx) * ax + (z - cz) * az) / tw, y / th]) as [number, number]);
    m.face(p, uv, s);
  }
}

/** The deck axis's overall direction (Buda to Pest). */
export function axisDir(def: BridgeJson): [number, number] {
  const n = def.axis.length;
  const dx = def.axis[n - 2] - def.axis[0];
  const dz = def.axis[n - 1] - def.axis[1];
  const l = Math.hypot(dx, dz);
  return [dx / l, dz / l];
}

/** Points every ~step metres along the axis, with the local direction there. */
export function alongAxis(def: BridgeJson, step: number): { x: number; z: number; ux: number; uz: number; s: number }[] {
  const out: { x: number; z: number; ux: number; uz: number; s: number }[] = [];
  let run = 0;
  for (let i = 0; i < def.axis.length / 2 - 1; i++) {
    const ax = def.axis[i * 2];
    const az = def.axis[i * 2 + 1];
    const ex = def.axis[i * 2 + 2] - ax;
    const ez = def.axis[i * 2 + 3] - az;
    const l = Math.hypot(ex, ez);
    const n = Math.max(1, Math.round(l / step));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) out.push({ x: ax + (ex * k) / n, z: az + (ez * k) / n, ux: ex / l, uz: ez / l, s: run + (l * k) / n });
    run += l;
  }
  return out;
}

/**
 * Railings (or parapets) along both deck edges where the deck is over the water or the quays,
 * h metres high, `inset` in from the edge.
 */
export function railing(m: Model, ctx: HeroContext, def: BridgeJson, h: number, thick: number, s: Surface, inset = 0.3, minTop = def.top - 4): void {
  const pts = alongAxis(def, 5);
  for (const side of [-1, 1]) {
    const off = def.width / 2 - inset;
    let prev: V3 | null = null;
    for (const p of pts) {
      const x = p.x - p.uz * off * side;
      const z = p.z + p.ux * off * side;
      const top = ctx.bridges.topAt(def, x, z);
      const cur: V3 = [x, top + h / 2, z];
      if (prev && top > minTop) m.beam(prev, cur, thick, h, s);
      prev = top > minTop ? cur : null;
    }
  }
}

/** A pier with pointed cutwaters at both ends (u is its long axis, along the flow). */
export function pier(m: Model, p: BridgeJson["piers"][number], y0: number, y1: number, s: Surface, top: Surface = s): void {
  const { cx, cz, ux, uz, halfU, halfV } = p;
  const vx = -uz;
  const vz = ux;
  const point = Math.min(halfV * 1.4, halfU * 0.4);
  const ring = ensureCcw(
    [
      [halfU, 0],
      [halfU - point, halfV],
      [-halfU + point, halfV],
      [-halfU, 0],
      [-halfU + point, -halfV],
      [halfU - point, -halfV],
    ].map(([a, b]) => [cx + ux * a + vx * b, cz + uz * a + vz * b] as [number, number]),
  );
  m.walls(ring, y0, y1, s);
  m.cap(ring, y1, top);
}

/** A lamp post under each of the night lights' deck lamps (5 m above the deck). */
export function lampPosts(m: Model, ctx: HeroContext, def: BridgeJson, s: Surface, lantern: Surface): void {
  for (const l of ctx.bridges.deckLamps(def)) {
    const base = l.y - 5;
    m.prism(l.x, l.z, 6, 0.12, base, l.y - 0.35, s, null);
    m.prism(l.x, l.z, 6, 0.28, l.y - 0.35, l.y + 0.35, lantern, lantern);
  }
}
