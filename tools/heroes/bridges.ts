// The Margaret, Elisabeth and Liberty Bridges (the Chain Bridge has its own file), on the
// decks, piers, towers and curves of bridges.json, as the runtime queries them.
//   Margaret  six steel arches under the deck between stone piers, bending at the island spur,
//             with sculpted pylons at deck level over each pier (Ernest Goüin, 1876).
//   Elisabeth a white suspension bridge on two portal pylons at the banks (1964).
//   Liberty   the green Gerber truss, its top chord peaking over the river piers, where four
//             masts carry the turul birds (1896).

import type { BridgeJson } from "../../src/world/bridges";
import type { HeroContext } from "./context";
import { alongAxis, deck, headingOf, lampPosts, pier, railing } from "./bridgeKit";
import { Model, surf, type Surface, type V3 } from "./kit";

const ROAD = surf("plain", "#55534e", 0.15);
const PIER_STONE = surf("ashlar", "#cdbf9f");
const LAMP = surf("metal", "#3c3f3b", 0.4);

/** Where along the axis (arc length) the deck leaves each bank, and each pier's position. */
function spans(ctx: HeroContext, def: BridgeJson): { banks: [number, number]; piers: number[] } {
  const pts = alongAxis(def, 2);
  const wet = pts.filter((p) => ctx.river.isWater(p.x, p.z));
  const proj = (x: number, z: number) => {
    let best = Infinity;
    let s = 0;
    for (const p of pts) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < best) (best = d), (s = p.s);
    }
    return s;
  };
  return { banks: [wet[0].s, wet[wet.length - 1].s], piers: def.piers.map((p) => proj(p.cx, p.cz)).sort((a, b) => a - b) };
}

/** A point at arc length s on the axis, offset across it (+ is to the right going Buda to Pest). */
function at(def: BridgeJson, s: number, across: number): { x: number; z: number; ux: number; uz: number } {
  let run = 0;
  for (let i = 0; i < def.axis.length / 2 - 1; i++) {
    const ax = def.axis[i * 2];
    const az = def.axis[i * 2 + 1];
    const ex = def.axis[i * 2 + 2] - ax;
    const ez = def.axis[i * 2 + 3] - az;
    const l = Math.hypot(ex, ez);
    if (s <= run + l || i === def.axis.length / 2 - 2) {
      const t = Math.min(1, Math.max(0, (s - run) / l));
      const ux = ex / l;
      const uz = ez / l;
      return { x: ax + ex * t - uz * across, z: az + ez * t + ux * across, ux, uz };
    }
    run += l;
  }
  throw new Error("unreachable");
}

// --- Margaret Bridge ------------------------------------------------------------------------

export function margaretBridge(ctx: HeroContext): Model[] {
  const def = ctx.bridge("Margaret Bridge");
  const STEEL = surf("iron", "#a39d6c", 0.7);
  const DECKSIDE = surf("iron", "#948e62", 0.4);
  const m = new Model("margaretBridge");
  deck(m, ctx, def, ROAD, DECKSIDE, surf("plain", "#6f6a4c", 0.2));
  railing(m, ctx, def, 1.2, 0.25, STEEL);
  lampPosts(m, ctx, def, LAMP, LAMP);
  for (const p of def.piers) pier(m, p, -3, 3, PIER_STONE);
  const { banks, piers } = spans(ctx, def);
  const stops = [banks[0], ...piers, banks[1]];
  const under = def.top - def.thickness;
  // An arch between each pair of stops: four ribs across the width, spandrel posts every 4.5 m.
  for (let k = 0; k < stops.length - 1; k++) {
    const s0 = stops[k] + (k === 0 ? 0 : 5);
    const s1 = stops[k + 1] - (k === stops.length - 2 ? 0 : 5);
    if (s1 - s0 < 20) continue;
    const rise = under - 2.5;
    for (const across of [-1, -0.45, 0.45, 1].map((f) => f * (def.width / 2 - 1.2))) {
      const N = 16;
      const pts: V3[] = [];
      for (let i = 0; i <= N; i++) {
        const s = s0 + ((s1 - s0) * i) / N;
        const u = (2 * i) / N - 1;
        const p = at(def, s, across);
        pts.push([p.x, 2.5 + rise * (1 - u * u) - 0.8, p.z]);
      }
      for (let i = 0; i < N; i++) m.beam(pts[i], pts[i + 1], 0.7, 1.6, STEEL);
      if (Math.abs(across) < def.width / 2 - 2) continue;
      for (let s = s0 + 4.5; s < s1 - 2; s += 4.5) {
        const u = (2 * (s - s0)) / (s1 - s0) - 1;
        const y = 2.5 + rise * (1 - u * u);
        if (under - y < 0.8) continue;
        const p = at(def, s, across);
        m.beam([p.x, y, p.z], [p.x, under, p.z], 0.3, 0.3, STEEL);
      }
    }
  }
  // Sculpted pylons at deck level over the river piers, both sides.
  for (const s of piers) {
    for (const side of [-1, 1]) {
      const p = at(def, s, side * (def.width / 2 + 0.8));
      const top = ctx.bridges.topAt(def, p.x, p.z);
      m.frame(p.x, top, p.z, headingOf(p.ux, p.uz));
      m.box(-1.2, 1.2, -1.6, 1.6, -def.thickness - 1, 3.2, PIER_STONE);
      m.prism(0, 0, 8, 0.75, 3.2, 5.6, surf("metal", "#6d7466", 0.9), null, 0, 0.5);
      m.pyramid(0, 0, 8, 0.6, 5.6, 1.4, surf("metal", "#6d7466", 0.9));
      m.identity();
    }
  }
  return [m];
}

// --- Elisabeth Bridge -----------------------------------------------------------------------

export function elisabethBridge(ctx: HeroContext): Model[] {
  const def = ctx.bridge("Elisabeth Bridge");
  const WHITE = surf("plain", "#eeede8", 0.9);
  const CABLE = surf("metal", "#e9e8e2", 0.8);
  const m = new Model("elisabethBridge");
  deck(m, ctx, def, ROAD, WHITE, surf("plain", "#c9c8c2", 0.3));
  railing(m, ctx, def, 1.15, 0.22, WHITE);
  lampPosts(m, ctx, def, surf("metal", "#d8d8d2", 0.5), surf("metal", "#d8d8d2", 0.5));
  const tw = def.tower!;
  for (const t of ctx.bridges.towers(def)) {
    const g = Math.min(ctx.ground(t.x, t.z), def.top - 2);
    m.frame(t.x, 0, t.z, headingOf(t.ux, t.uz));
    const off = def.width / 2 + tw.thick / 2;
    // Two tapering legs on stone footings, each under the saddle its cable runs over; an
    // arched crossbeam at the top, and a plain one under the deck.
    const top = tw.height;
    for (const sx of [-off, off]) {
      if (g < def.top - 6) m.box(sx - tw.thick / 2 - 0.8, sx + tw.thick / 2 + 0.8, -tw.along / 2 - 0.8, tw.along / 2 + 0.8, g - 2, g + 2.5, PIER_STONE);
      m.orientedBox(sx, 0, tw.thick, tw.along, 0, g - 2, def.top + 2, WHITE, null);
      m.prism(sx, 0, 4, tw.thick * 0.62, def.top + 2, top, WHITE, WHITE, Math.PI / 4, tw.thick * 0.45);
      m.box(sx - 1.9, sx + 1.9, -tw.along * 0.42, tw.along * 0.42, top, top + 0.9, WHITE);
      m.lathe(sx, 0, 8, [[1.75, top + 0.9], [1.5, top + 1.7], [0.9, top + 2.3], [0.2, top + 2.5]], WHITE, Math.PI / 8);
    }
    // Into the legs a little, which taper.
    const inner = off - tw.thick * 0.3;
    archBeam(m, inner, top - 0.6, top - 7.5, top - 3.4, tw.along * 0.32, WHITE);
    m.box(-off, off, -tw.along * 0.36, tw.along * 0.36, def.top - def.thickness - 2.2, def.top - def.thickness, WHITE);
    m.identity();
  }
  // Main cables on the runtime's curves, hangers every 8 m.
  for (const pts of ctx.bridges.cables(def)) {
    const c: V3[] = pts.map((p) => [p.x, p.y, p.z]);
    m.tube(c, 0.45, 6, CABLE);
    hangers(m, ctx, def, c, 8, 0.1, CABLE);
  }
  return [m];
}

/**
 * A crossbeam between two legs at ±x (local frame, across x), its top level at `top`, its
 * soffit an arch from `foot` at the legs up to `crown` in the middle; `half` deep either side
 * of z = 0. Built from a quad per arch segment, so no face is concave.
 */
function archBeam(m: Model, x: number, top: number, foot: number, crown: number, half: number, s: Surface): void {
  const n = 10;
  const soffit = (k: number): [number, number] => {
    const t = k / n;
    const u = -x + 2 * x * t;
    // A segmental arch: a circle's arc through both feet and the crown.
    const rise = crown - foot;
    const r = (x * x + rise * rise) / (2 * rise);
    return [u, crown - r + Math.sqrt(Math.max(0, r * r - u * u))];
  };
  for (let k = 0; k < n; k++) {
    const [u0, y0] = soffit(k);
    const [u1, y1] = soffit(k + 1);
    for (const z of [-half, half])
      m.faceToward([[u0, y0, z], [u1, y1, z], [u1, top, z], [u0, top, z]], [[0, 0], [(u1 - u0) / 8, 0], [(u1 - u0) / 8, (top - y1) / 8], [0, (top - y0) / 8]], s, [0, 0, z]);
    m.faceToward([[u0, y0, -half], [u1, y1, -half], [u1, y1, half], [u0, y0, half]], [[0, 0], [(u1 - u0) / 8, 0], [(u1 - u0) / 8, (2 * half) / 8], [0, (2 * half) / 8]], s, [0, -1, 0]);
  }
  m.faceToward([[-x, top, -half], [x, top, -half], [x, top, half], [-x, top, half]], [[0, 0], [(2 * x) / 8, 0], [(2 * x) / 8, (2 * half) / 8], [0, (2 * half) / 8]], s, [0, 1, 0]);
}

/** Vertical hangers from a cable down to the deck, every `step` metres. */
function hangers(m: Model, ctx: HeroContext, def: BridgeJson, cable: V3[], step: number, r: number, s: Surface): void {
  let next = step / 2;
  let run = 0;
  for (let k = 0; k < cable.length - 1; k++) {
    const a = cable[k];
    const b = cable[k + 1];
    const l = Math.hypot(b[0] - a[0], b[2] - a[2]);
    while (next <= run + l) {
      const t = (next - run) / l;
      next += step;
      const x = a[0] + (b[0] - a[0]) * t;
      const y = a[1] + (b[1] - a[1]) * t;
      const z = a[2] + (b[2] - a[2]) * t;
      const top = ctx.bridges.topAt(def, x, z);
      if (y - top > 1.2) m.beam([x, top, z], [x, y - 0.3, z], r * 2, r * 2, s);
    }
    run += l;
  }
}

// --- Liberty Bridge ---------------------------------------------------------------------------

export function libertyBridge(ctx: HeroContext): Model[] {
  const def = ctx.bridge("Liberty Bridge");
  const GREEN = surf("iron", "#4f8160", 0.85);
  const DARK = surf("iron", "#3f6a4e", 0.5);
  const m = new Model("libertyBridge");
  deck(m, ctx, def, ROAD, GREEN, surf("plain", "#3f6a4e", 0.5));
  railing(m, ctx, def, 1.15, 0.2, GREEN);
  lampPosts(m, ctx, def, LAMP, LAMP);
  for (const p of def.piers) pier(m, p, -3, 3.5, PIER_STONE);
  // The trusses: top chord on the runtime's curve, bottom chord at the deck, verticals and
  // diagonals every ~6 m.
  for (const pts of ctx.bridges.cables(def)) {
    const top: V3[] = pts.map((p) => [p.x, p.y, p.z]);
    const bottom: V3[] = pts.map((p) => [p.x, ctx.bridges.topAt(def, p.x, p.z) + 0.6, p.z]);
    // Resample both chords evenly by horizontal distance.
    const even = (c: V3[], step: number) => {
      const out: V3[] = [c[0]];
      let carry = 0;
      for (let k = 0; k < c.length - 1; k++) {
        const a = c[k];
        const b = c[k + 1];
        const l = Math.hypot(b[0] - a[0], b[2] - a[2]);
        let d = step - carry;
        while (d <= l) {
          const t = d / l;
          out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
          d += step;
        }
        carry = l - (d - step);
      }
      out.push(c[c.length - 1]);
      return out;
    };
    const T = even(top, 6);
    const B = even(bottom, 6);
    const n = Math.min(T.length, B.length);
    for (let i = 0; i < n - 1; i++) {
      m.beam(T[i], T[i + 1], 0.55, 0.9, GREEN);
      m.beam(B[i], B[i + 1], 0.55, 1.1, GREEN);
      if (T[i][1] - B[i][1] > 1.2) m.beam(B[i], T[i], 0.4, 0.4, GREEN);
      if (T[i + 1][1] - B[i + 1][1] > 1.2 || T[i][1] - B[i][1] > 1.2) m.beam(i % 2 ? B[i] : T[i], i % 2 ? T[i + 1] : B[i + 1], 0.3, 0.3, GREEN);
    }
  }
  // Over each pier: a portal between the trusses and two masts with a turul on each.
  for (const t of ctx.bridges.towers(def)) {
    m.frame(t.x, 0, t.z, headingOf(t.ux, t.uz));
    const off = def.width / 2 + 0.6;
    const peak = def.top + 14;
    for (const sx of [-off, off]) {
      m.prism(sx, 0, 4, 0.9, def.top, peak + 5.5, GREEN, null, Math.PI / 4, 0.55);
      m.prism(sx, 0, 8, 0.75, peak + 5.5, peak + 6.6, DARK, DARK);
      turul(m, sx, peak + 6.6);
    }
    m.box(-off, off, -0.4, 0.4, peak - 1.4, peak - 0.2, GREEN);
    m.box(-off, off, -0.3, 0.3, peak - 5, peak - 4.2, GREEN);
    m.identity();
  }
  return [m];
}

/** The turul: a mythical falcon with wings spread, perched on a ball. */
function turul(m: Model, x: number, y: number): void {
  const BRONZE = surf("metal", "#4a4a3c", 0.6);
  m.lathe(x, 0, 6, [[0.01, y], [0.45, y + 0.15], [0.5, y + 0.45], [0.35, y + 0.8], [0.01, y + 0.9]], BRONZE);
  m.box(x - 0.25, x + 0.25, -0.5, 0.5, y + 0.9, y + 1.5, BRONZE);
  // Wings, raised and spread across the bridge's axis.
  for (const s of [-1, 1]) m.beam([x, y + 1.35, 0], [x + s * 1.6, y + 2.3, 0.2], 0.2, 0.6, BRONZE);
  m.box(x - 0.15, x + 0.15, -0.75, -0.45, y + 1.4, y + 1.75, BRONZE);
}
