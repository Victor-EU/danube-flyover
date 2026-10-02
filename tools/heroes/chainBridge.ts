// The Széchenyi Chain Bridge (William Tierney Clark, Adam Clark, 1839–49): two stone towers
// like triumphal arches standing on cutwater piers, two iron chains on each side hung over
// them on the runtime's own curves (so the night bulbs sit on them), hangers down to the deck
// every 5.5 m, the deck girders and railings, the anchorages at both ends, and the four lions.

import type { BridgeJson } from "../../src/world/bridges";
import type { HeroContext } from "./context";
import { alongAxis, deck, headingOf, lampPosts, pier, railing } from "./bridgeKit";
import { Model, surf, type UV, type V3 } from "./kit";

const LIMESTONE = surf("ashlar", "#dccfb0");
const PIER = surf("ashlar", "#c9bc9e");
const IRON = surf("iron", "#5d655c", 0.8);
const CHAIN = surf("metal", "#4f564f", 1.1);
const ROAD = surf("plain", "#55534e", 0.15);
const SOFFIT = surf("plain", "#4a4f49", 0.3);
const LAMP = surf("metal", "#3c3f3b", 0.4);
const LION = surf("plain", "#d6cbb0");
/** Where in the plain layer the lions take their stone: inside one block, clear of the joints. */
const CARVED: UV = [0.4, 0.55];

export function chainBridge(ctx: HeroContext): Model[] {
  const def = ctx.bridge("Chain Bridge");
  const m = new Model("chainBridge");
  deck(m, ctx, def, ROAD, IRON, SOFFIT);
  railing(m, ctx, def, 1.25, 0.3, IRON);
  lampPosts(m, ctx, def, LAMP, LAMP);
  for (const p of def.piers) pier(m, p, -3, 3.5, PIER);
  for (const t of ctx.bridges.towers(def)) tower(m, def, t);
  m.identity();
  chains(m, ctx, def);
  return [m];
}

/** A tower: two legs, a round arch over the road, a cornice and the attic. */
function tower(m: Model, def: BridgeJson, t: BridgeJson["towers"][number]): void {
  const tw = def.tower!;
  m.frame(t.x, 0, t.z, headingOf(t.ux, t.uz));
  const W = def.width / 2; // half the opening
  const T = tw.thick;
  const A = tw.along / 2;
  const H = tw.height;
  const spring = def.top + 13.5;
  const corn = H - 10;
  for (const s of [-1, 1]) {
    const [x0, x1] = s < 0 ? [-W - T, -W] : [W, W + T];
    // Rusticated base, the leg, and a pilaster on the outer face.
    m.box(x0 - 0.4, x1 + 0.4, -A - 0.4, A + 0.4, 2, def.top + 1, PIER, PIER);
    m.box(x0, x1, -A, A, def.top + 1, corn, LIMESTONE, null);
    const xo = s < 0 ? x0 : x1;
    m.box(Math.min(xo, xo + s * 0.6), Math.max(xo, xo + s * 0.6), -A + 1.2, A - 1.2, def.top + 1, corn, LIMESTONE, null);
  }
  // The arch: intrados and the spandrels on both faces.
  const N = 12;
  const arc = Array.from({ length: N + 1 }, (_, k) => {
    const a = (Math.PI * k) / N;
    return [W * Math.cos(a), spring + W * Math.sin(a)] as [number, number];
  });
  for (let k = 0; k < N; k++) {
    const [xa, ya] = arc[k];
    const [xb, yb] = arc[k + 1];
    const mx = (xa + xb) / 2;
    const my = (ya + yb) / 2 - spring;
    m.faceToward([[xa, ya, -A], [xb, yb, -A], [xb, yb, A], [xa, ya, A]], [[0, 0], [1, 0], [1, 3], [0, 3]], LIMESTONE, [-mx, -my, 0]);
    for (const z of [-A, A]) m.faceToward([[xa, ya, z], [xb, yb, z], [xb, corn, z], [xa, corn, z]], [[xa / 4, ya / 4], [xb / 4, yb / 4], [xb / 4, corn / 4], [xa / 4, corn / 4]], LIMESTONE, [0, 0, z]);
  }
  // Inner faces of the legs, up to the springing.
  for (const s of [-1, 1]) m.wall(s < 0 ? [-W, -A] : [W, A], s < 0 ? [-W, A] : [W, -A], def.top + 1, spring, LIMESTONE);
  // Cornice, attic and a crowning band.
  m.box(-W - T - 0.7, W + T + 0.7, -A - 0.7, A + 0.7, corn, corn + 1.2, LIMESTONE);
  m.box(-W - T, W + T, -A, A, corn + 1.2, H - 1.4, LIMESTONE, null);
  m.box(-W - T - 0.4, W + T + 0.4, -A - 0.4, A + 0.4, H - 1.4, H, LIMESTONE);
  // A shallow attic panel on each face.
  for (const z of [-A - 0.25, A]) m.box(-W + 1, W - 1, z, z + 0.25, corn + 2.6, H - 2.8, LIMESTONE, null);
}

/** Two chains a side on the runtime's curves, the hangers, the anchorages, the lions. */
function chains(m: Model, ctx: HeroContext, def: BridgeJson): void {
  const curves = ctx.bridges.cables(def);
  for (const pts of curves) {
    const upper: V3[] = pts.map((p) => [p.x, p.y, p.z]);
    const lower: V3[] = pts.map((p) => [p.x, p.y - 1.5, p.z]);
    for (const c of [upper, lower]) for (let k = 0; k < c.length - 1; k++) m.beam(c[k], c[k + 1], 0.45, 0.85, CHAIN);
    // Hangers every 5.5 m from the lower chain to the deck edge.
    let next = 0;
    let run = 0;
    for (let k = 0; k < lower.length - 1; k++) {
      const a = lower[k];
      const b = lower[k + 1];
      const l = Math.hypot(b[0] - a[0], b[2] - a[2]);
      while (next <= run + l) {
        const t = (next - run) / l;
        next += 5.5;
        const x = a[0] + (b[0] - a[0]) * t;
        const y = a[1] + (b[1] - a[1]) * t;
        const z = a[2] + (b[2] - a[2]) * t;
        const top = ctx.bridges.topAt(def, x, z);
        if (y - top > 1.5) m.beam([x, top, z], [x, y, z], 0.16, 0.16, CHAIN);
      }
      run += l;
    }
    // The anchorage where the chains come down at each end.
    for (const p of [pts[0], pts[pts.length - 1]]) {
      const top = ctx.bridges.topAt(def, p.x, p.z);
      m.prism(p.x, p.z, 4, 2.6, top - 1, top + 2.2, LIMESTONE, LIMESTONE, Math.PI / 4);
    }
  }
  // The lions, one each side of the road at both ends, facing along the bridge.
  const pts = alongAxis(def, 4);
  const full = pts.filter((p) => ctx.bridges.topAt(def, p.x, p.z) > def.top - 0.5);
  for (const [p, dir] of [[full[0], -1], [full[full.length - 1], 1]] as const)
    for (const side of [-1, 1]) {
      const x = p.x - p.uz * (def.width / 2 + 4.5) * side + p.ux * dir * 6;
      const z = p.z + p.ux * (def.width / 2 + 4.5) * side + p.uz * dir * 6;
      lion(m, ctx, x, z, headingOf(-p.ux * dir, -p.uz * dir));
    }
  m.identity();
}

/**
 * A couchant lion on its plinth (János Marschalkó, 1852), facing local -z: the body lying low,
 * the haunches, the head raised in its mane, the forepaws stretched out in front and the tail
 * along the side. Lofted from a few sections each: it is read from the water, 100 m off.
 */
function lion(m: Model, ctx: HeroContext, x: number, z: number, heading: number): void {
  const g = ctx.ground(x, z);
  m.frame(x, g, z, heading);
  // The plinth: base, die and cornice.
  m.box(-2.2, 2.2, -3.8, 3.8, -1, 0.5, LIMESTONE);
  m.box(-1.95, 1.95, -3.55, 3.55, 0.5, 2.2, LIMESTONE);
  m.box(-2.15, 2.15, -3.75, 3.75, 2.2, 2.6, LIMESTONE);
  const y = 2.6;
  // The body, from the rump to the chest.
  m.loft([[0, y + 0.75, 2.75], [0, y + 0.85, 2.2], [0, y + 0.9, 1.0], [0, y + 1.0, -0.3], [0, y + 1.1, -1.3]], [[0.45, 0.4], [0.95, 0.8], [1.0, 0.85], [1.05, 0.95], [1.1, 1.05]], 8, LION, CARVED);
  // The mane, rising from the shoulders round the back of the head.
  m.loft([[0, y + 1.1, -0.6], [0, y + 1.65, -1.6], [0, y + 2.0, -2.3], [0, y + 2.05, -2.6]], [[1.15, 1.1], [1.35, 1.3], [1.15, 1.15], [0.8, 0.85]], 10, LION, CARVED);
  // The face and muzzle, out of the mane.
  m.loft([[0, y + 2.05, -2.4], [0, y + 2.0, -3.0], [0, y + 1.82, -3.45], [0, y + 1.7, -3.62]], [[0.72, 0.75], [0.62, 0.6], [0.45, 0.4], [0.22, 0.2]], 8, LION, CARVED);
  for (const sx of [-1, 1]) {
    // A foreleg stretched out along the plinth, the paw at its end.
    m.loft([[sx * 0.55, y + 0.55, -1.0], [sx * 0.55, y + 0.36, -2.4], [sx * 0.55, y + 0.34, -3.55]], [[0.36, 0.4], [0.3, 0.3], [0.36, 0.32]], 6, LION, CARVED);
    // A haunch.
    m.loft([[sx * 0.72, y + 0.95, 2.45], [sx * 0.88, y + 0.7, 1.6], [sx * 0.84, y + 0.45, 0.8]], [[0.42, 0.5], [0.5, 0.62], [0.32, 0.36]], 6, LION, CARVED);
  }
  // The tail, curled forward along the right flank.
  m.loft([[0.5, y + 0.6, 2.75], [0.95, y + 0.3, 2.0], [1.1, y + 0.22, 0.8], [1.0, y + 0.25, -0.2]], [[0.14, 0.14], [0.13, 0.13], [0.12, 0.12], [0.16, 0.14]], 5, LION, CARVED);
}
