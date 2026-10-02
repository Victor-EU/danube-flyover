// The modelling kit for the hero landmarks: faceted primitives (walls, caps, prisms, spires,
// domes, roofs, beams, tubes) built in a local frame and stored in world space, each face
// with its texture layer, tint and floodlight response. Texture coordinates are in tiles of
// the layer (HERO_LAYERS), and window layers fit a whole number of bays and storeys to every
// wall, so no window is ever cut by a corner.
//
// The local frame is three.js's own: x to the right of the heading, y up, and -z forward
// (along the heading); it is a rotation of the world (x east, z south), never a mirror.

import earcut from "earcut";
import { HERO_LAYER, HERO_LAYERS, HERO_UV_RANGE, type HeroLayer } from "../../src/config";
import { signedArea, type Polygon, type Pt, type Ring } from "../lib/geom";
import type { MeshDef } from "../lib/gltf";

export type V3 = [number, number, number];
export type UV = [number, number];

export interface Surface {
  layer: HeroLayer;
  /** sRGB tint, "#rrggbb": the layers are near-white detail. */
  tint: string;
  /** Floodlight response (1 = fully lit stone, 0 = none). */
  flood: number;
}

export const surf = (layer: HeroLayer, tint: string, flood = 1): Surface => ({ layer, tint, flood });

const hexRgb = (h: string): V3 => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const layerOf = (s: Surface) => HERO_LAYERS[HERO_LAYER[s.layer]];

/** Tiles across a span of `len` metres: whole bays for window layers, plain metres otherwise. */
export function fitU(s: Surface, len: number): number {
  const l = layerOf(s);
  if (!l.lit) return len / l.tile[0];
  return Math.max(1, Math.round((len * l.bays) / l.tile[0])) / l.bays;
}

export function fitV(s: Surface, h: number): number {
  const l = layerOf(s);
  if (!l.lit) return h / l.tile[1];
  return Math.max(1, Math.round((h * l.rows) / l.tile[1])) / l.rows;
}

export class Model {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly uv: number[] = [];
  private readonly hero: number[] = [];
  private readonly idx: number[] = [];
  /** Local → world: a rotation about y by `rot` and a translation. */
  private ox = 0;
  private oy = 0;
  private oz = 0;
  private cr = 1;
  private sr = 0;

  constructor(readonly name: string) {}

  /** Origin of the local frame, and the compass heading (degrees) that local -z points along. */
  frame(x: number, y: number, z: number, heading: number): this {
    const rot = (-heading * Math.PI) / 180;
    this.ox = x;
    this.oy = y;
    this.oz = z;
    this.cr = Math.cos(rot);
    this.sr = Math.sin(rot);
    return this;
  }

  /** Back to world coordinates (heading 0 is the identity). */
  identity(): this {
    return this.frame(0, 0, 0, 0);
  }

  /** Local point to world. */
  world(p: V3): V3 {
    return [this.ox + p[0] * this.cr + p[2] * this.sr, this.oy + p[1], this.oz - p[0] * this.sr + p[2] * this.cr];
  }

  /** World (x, z) to the local frame. */
  local(x: number, z: number): Pt {
    const dx = x - this.ox;
    const dz = z - this.oz;
    return [dx * this.cr - dz * this.sr, dx * this.sr + dz * this.cr];
  }

  get triangles(): number {
    return this.idx.length / 3;
  }

  /** A planar convex face, counter-clockwise seen from its front. */
  face(pts: V3[], uv: UV[], s: Surface): void {
    const w = pts.map((p) => this.world(p));
    // Newell's normal (robust for slightly non-planar quads).
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < w.length; i++) {
      const a = w[i];
      const b = w[(i + 1) % w.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    const first = this.pos.length / 3;
    const c = hexRgb(s.tint);
    const layer = HERO_LAYER[s.layer];
    // The layers tile, so a whole number of tiles can come off each face: that keeps every
    // coordinate small enough to quantise.
    const su = Math.floor(Math.min(...uv.map((t) => t[0])));
    const sv = Math.floor(Math.min(...uv.map((t) => t[1])));
    w.forEach((p, i) => {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx / l, ny / l, nz / l);
      this.col.push(c[0], c[1], c[2]);
      this.uv.push((uv[i][0] - su) / HERO_UV_RANGE + 0.5, (uv[i][1] - sv) / HERO_UV_RANGE + 0.5);
      this.hero.push(layer / 32, s.flood / 4);
    });
    for (let i = 1; i < w.length - 1; i++) this.idx.push(first, first + i, first + i + 1);
  }

  /** As `face`, flipped if needed so it faces along `toward` (local). */
  faceToward(pts: V3[], uv: UV[], s: Surface, toward: V3): void {
    const a = pts[0];
    const b = pts[1];
    const c = pts[2];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (n[0] * toward[0] + n[1] * toward[1] + n[2] * toward[2] < 0) this.face([...pts].reverse(), [...uv].reverse(), s);
    else this.face(pts, uv, s);
  }

  /**
   * A wall from a to b (local x, z), facing (ez, -ex): outward for a positive (counter-
   * clockwise in geom.ts terms) outer ring, and toward the courtyard for its holes. `v0` is
   * where the texture starts (tiles), so a wall can continue the one below it.
   */
  wall(a: Pt, b: Pt, y0: number, y1: number, s: Surface, opts: { v0?: number; u?: number } = {}): void {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.02 || y1 - y0 < 0.02) return;
    const U = opts.u ?? fitU(s, len);
    const v0 = opts.v0 ?? 0;
    const V = v0 + fitV(s, y1 - y0);
    // Seen from outside, b is on the left: u runs from b to a.
    this.face(
      [
        [a[0], y0, a[1]],
        [a[0], y1, a[1]],
        [b[0], y1, b[1]],
        [b[0], y0, b[1]],
      ],
      [
        [U, v0],
        [U, V],
        [0, V],
        [0, v0],
      ],
      s,
    );
  }

  /** Walls round every ring of a polygon (outer ring counter-clockwise, holes clockwise). */
  walls(poly: Polygon | Ring, y0: number, y1: number, s: Surface): void {
    const rings = isRing(poly) ? [poly] : poly;
    for (const r of rings) for (let i = 0; i < r.length; i++) this.wall(r[i], r[(i + 1) % r.length], y0, y1, s);
  }

  /** A horizontal polygon (with holes) at height y, facing up (or down). */
  cap(poly: Polygon | Ring, y: number, s: Surface, down = false): void {
    const rings = isRing(poly) ? [poly] : poly;
    const flat: number[] = [];
    const holes: number[] = [];
    rings.forEach((r, k) => {
      if (k > 0) holes.push(flat.length / 2);
      for (const p of r) flat.push(p[0], p[1]);
    });
    const tris = earcut(flat, holes, 2);
    const l = layerOf(s);
    // From the first corner, so the coordinates stay small (they quantise into a fixed range).
    const uv = (k: number): UV => [(flat[k * 2] - flat[0]) / l.tile[0], (flat[k * 2 + 1] - flat[1]) / l.tile[1]];
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
      const p = (k: number): V3 => [flat[k * 2], y, flat[k * 2 + 1]];
      this.faceToward([p(a), p(b), p(c)], [uv(a), uv(b), uv(c)], s, [0, down ? -1 : 1, 0]);
    }
  }

  /** An axis-aligned box in the local frame. */
  box(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, wall: Surface, top: Surface | null = wall): void {
    const ring: Ring = [
      [x0, z1],
      [x1, z1],
      [x1, z0],
      [x0, z0],
    ];
    this.walls(ensureCcw(ring), y0, y1, wall);
    if (top) this.cap(ring, y1, top);
  }

  /** A box centred at (cx, cz), w across and d along its own axis, turned by `rot` (radians). */
  orientedBox(cx: number, cz: number, w: number, d: number, rot: number, y0: number, y1: number, wall: Surface, top: Surface | null = wall): void {
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const ring: Ring = [
      [-w / 2, d / 2],
      [w / 2, d / 2],
      [w / 2, -d / 2],
      [-w / 2, -d / 2],
    ].map(([x, z]) => [cx + x * c + z * s, cz - x * s + z * c] as Pt);
    this.walls(ensureCcw(ring), y0, y1, wall);
    if (top) this.cap(ring, y1, top);
  }

  /** An n-sided prism (tapered if rTop is given), with an optional cap. */
  prism(cx: number, cz: number, n: number, r: number, y0: number, y1: number, wall: Surface, top: Surface | null = null, rot0 = 0, rTop = r): void {
    const ring = (rad: number) => ngon(cx, cz, n, rad, rot0);
    const a = ring(r);
    const b = ring(rTop);
    const side = 2 * r * Math.sin(Math.PI / n);
    const U = fitU(wall, side);
    const V = fitV(wall, y1 - y0);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.faceToward(
        [
          [a[i][0], y0, a[i][1]],
          [a[j][0], y0, a[j][1]],
          [b[j][0], y1, b[j][1]],
          [b[i][0], y1, b[i][1]],
        ],
        [
          [U, 0],
          [0, 0],
          [0, V],
          [U, V],
        ],
        wall,
        [(a[i][0] + a[j][0]) / 2 - cx, 0, (a[i][1] + a[j][1]) / 2 - cz],
      );
    }
    if (top) this.cap(b, y1, top);
  }

  /** An n-sided spire from radius r at y0 to a point h above. */
  pyramid(cx: number, cz: number, n: number, r: number, y0: number, h: number, s: Surface, rot0 = 0): void {
    const a = ngon(cx, cz, n, r, rot0);
    const side = 2 * r * Math.sin(Math.PI / n);
    const slant = Math.hypot(h, r * Math.cos(Math.PI / n));
    const l = layerOf(s);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.faceToward(
        [
          [a[i][0], y0, a[i][1]],
          [a[j][0], y0, a[j][1]],
          [cx, y0 + h, cz],
        ],
        [
          [side / l.tile[0], 0],
          [0, 0],
          [side / 2 / l.tile[0], slant / l.tile[1]],
        ],
        s,
        [(a[i][0] + a[j][0]) / 2 - cx, 0, (a[i][1] + a[j][1]) / 2 - cz],
      );
    }
  }

  /**
   * A surface of revolution through profile points [radius, y] (bottom to top); a final
   * radius of 0 closes it to a point. Texture runs round in metres and up the slant.
   */
  lathe(cx: number, cz: number, n: number, profile: [number, number][], s: Surface, rot0 = 0): void {
    const l = layerOf(s);
    let v = 0;
    for (let k = 0; k < profile.length - 1; k++) {
      const [r0, y0] = profile[k];
      const [r1, y1] = profile[k + 1];
      const a = ngon(cx, cz, n, r0, rot0);
      const b = ngon(cx, cz, n, r1, rot0);
      const slant = Math.hypot(r1 - r0, y1 - y0);
      const v1 = v + slant / l.tile[1];
      const s0 = (2 * r0 * Math.sin(Math.PI / n)) / l.tile[0];
      const s1 = (2 * r1 * Math.sin(Math.PI / n)) / l.tile[0];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const out: V3 = [(a[i][0] + a[j][0]) / 2 - cx, 0, (a[i][1] + a[j][1]) / 2 - cz];
        if (r1 < 1e-6)
          this.faceToward([[a[i][0], y0, a[i][1]], [a[j][0], y0, a[j][1]], [cx, y1, cz]], [[s0, v], [0, v], [s0 / 2, v1]], s, out);
        else if (r0 < 1e-6)
          this.faceToward([[cx, y0, cz], [b[j][0], y1, b[j][1]], [b[i][0], y1, b[i][1]]], [[s1 / 2, v], [0, v1], [s1, v1]], s, out);
        else
          this.faceToward(
            [[a[i][0], y0, a[i][1]], [a[j][0], y0, a[j][1]], [b[j][0], y1, b[j][1]], [b[i][0], y1, b[i][1]]],
            [[s0, v], [0, v], [0, v1], [s1, v1]],
            s,
            out,
          );
      }
      v = v1;
    }
  }

  /** A box beam from a to b with a w × h cross-section (h in the vertical plane through a, b). */
  beam(a: V3, b: V3, w: number, h: number, s: Surface): void {
    const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...d);
    if (len < 1e-6) return;
    const t: V3 = [d[0] / len, d[1] / len, d[2] / len];
    // Side axis: horizontal, perpendicular to the beam (x for a vertical beam).
    let side: V3 = [-t[2], 0, t[0]];
    const sl = Math.hypot(side[0], side[2]);
    side = sl < 1e-6 ? [1, 0, 0] : [side[0] / sl, 0, side[2] / sl];
    const up: V3 = [t[1] * side[2] - t[2] * side[1], t[2] * side[0] - t[0] * side[2], t[0] * side[1] - t[1] * side[0]];
    const corner = (p: V3, i: number): V3 => {
      const sx = i === 0 || i === 3 ? -w / 2 : w / 2;
      const sy = i < 2 ? -h / 2 : h / 2;
      return [p[0] + side[0] * sx + up[0] * sy, p[1] + side[1] * sx + up[1] * sy, p[2] + side[2] * sx + up[2] * sy];
    };
    const ca = [0, 1, 2, 3].map((i) => corner(a, i));
    const cb = [0, 1, 2, 3].map((i) => corner(b, i));
    const l = layerOf(s);
    const U = len / l.tile[0];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const mid: V3 = [(ca[i][0] + ca[j][0]) / 2 - a[0], (ca[i][1] + ca[j][1]) / 2 - a[1], (ca[i][2] + ca[j][2]) / 2 - a[2]];
      const wv = (i % 2 === 0 ? w : h) / l.tile[1];
      this.faceToward([ca[i], ca[j], cb[j], cb[i]], [[0, 0], [0, wv], [U, wv], [U, 0]], s, mid);
    }
    const tn: V3 = [-t[0], -t[1], -t[2]];
    this.faceToward([ca[0], ca[1], ca[2], ca[3]], [[0, 0], [w / l.tile[0], 0], [w / l.tile[0], h / l.tile[1]], [0, h / l.tile[1]]], s, tn);
    this.faceToward([cb[0], cb[1], cb[2], cb[3]], [[0, 0], [w / l.tile[0], 0], [w / l.tile[0], h / l.tile[1]], [0, h / l.tile[1]]], s, t);
  }

  /** A tube of n sides along a path (chains, cables), open at the ends. */
  tube(path: V3[], r: number, n: number, s: Surface): void {
    const rings = sections(path, () => [r, r], n);
    const l = layerOf(s);
    let along = 0;
    const circ = (2 * Math.PI * r) / l.tile[1];
    for (let k = 0; k < rings.length - 1; k++) {
      const seg = Math.hypot(path[k + 1][0] - path[k][0], path[k + 1][1] - path[k][1], path[k + 1][2] - path[k][2]);
      const u0 = along / l.tile[0];
      const u1 = (along + seg) / l.tile[0];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const mid: V3 = [
          (rings[k][i][0] + rings[k][j][0]) / 2 - path[k][0],
          (rings[k][i][1] + rings[k][j][1]) / 2 - path[k][1],
          (rings[k][i][2] + rings[k][j][2]) / 2 - path[k][2],
        ];
        this.faceToward(
          [rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]],
          [[u0, (circ * i) / n], [u0, (circ * (i + 1)) / n], [u1, (circ * (i + 1)) / n], [u1, (circ * i) / n]],
          s,
          mid,
        );
      }
      along += seg;
    }
  }

  /**
   * A closed body along a path (in the local frame): an elliptical section of n sides at each
   * point, `radii[k]` across and up, capped at both ends. For sculpture: the lions. With a
   * `patch` (tiles), every vertex takes the layer's texture from that one point, inside a
   * block, so no joint runs across the carving.
   */
  loft(path: V3[], radii: [number, number][], n: number, s: Surface, patch?: UV): void {
    if (patch) {
      const at = (pts: V3[], uv: UV[], out: V3) => this.faceToward(pts, uv.map(() => patch), s, out);
      return this.loftFaces(path, radii, n, s, at);
    }
    this.loftFaces(path, radii, n, s, (pts, uv, out) => this.faceToward(pts, uv, s, out));
  }

  private loftFaces(path: V3[], radii: [number, number][], n: number, s: Surface, emit: (pts: V3[], uv: UV[], out: V3) => void): void {
    const rings = sections(path, (k) => radii[k], n);
    const l = layerOf(s);
    let along = 0;
    for (let k = 0; k < rings.length - 1; k++) {
      const seg = Math.hypot(path[k + 1][0] - path[k][0], path[k + 1][1] - path[k][1], path[k + 1][2] - path[k][2]);
      const [u0, u1] = [along / l.tile[0], (along + seg) / l.tile[0]];
      const circ = (2 * Math.PI * Math.max(...radii[k])) / l.tile[1];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const a = rings[k][i];
        const b = rings[k][j];
        const out: V3 = [(a[0] + b[0]) / 2 - path[k][0], (a[1] + b[1]) / 2 - path[k][1], (a[2] + b[2]) / 2 - path[k][2]];
        emit([a, b, rings[k + 1][j], rings[k + 1][i]], [[u0, (circ * i) / n], [u0, (circ * (i + 1)) / n], [u1, (circ * (i + 1)) / n], [u1, (circ * i) / n]], out);
      }
      along += seg;
    }
    // The ends: a fan round each end point, facing away along the path.
    for (const [k, k2] of [[0, 1], [path.length - 1, path.length - 2]]) {
      const c = path[k];
      const away: V3 = [c[0] - path[k2][0], c[1] - path[k2][1], c[2] - path[k2][2]];
      const ring = rings[k];
      const r = Math.max(...radii[k]) / l.tile[0];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        emit([c, ring[i], ring[j]], [[r, r], [r + Math.cos((i / n) * 2 * Math.PI) * r, r + Math.sin((i / n) * 2 * Math.PI) * r], [r + Math.cos((j / n) * 2 * Math.PI) * r, r + Math.sin((j / n) * 2 * Math.PI) * r]], away);
      }
    }
  }

  /**
   * A mansard over a polygon: every ring inset by `inset` and raised by `rise`, then a flat
   * top. Falls back to a smaller inset (and finally a flat roof) where the inset would fold
   * over. Returns the top polygon.
   */
  mansard(poly: Polygon, y: number, inset: number, rise: number, roof: Surface, top: Surface = roof): Polygon {
    for (const k of [1, 0.75, 0.5, 0.3]) {
      const inner = insetPolygon(poly, inset * k);
      if (!inner) continue;
      const r = rise * k;
      const l = layerOf(roof);
      poly.forEach((ring, ri) => {
        const inn = inner[ri];
        for (let i = 0; i < ring.length; i++) {
          const j = (i + 1) % ring.length;
          const a = ring[i];
          const b = ring[j];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const slant = Math.hypot(inset * k, r);
          const out: V3 = [b[1] - a[1], 0, -(b[0] - a[0])];
          this.faceToward(
            [[a[0], y, a[1]], [b[0], y, b[1]], [inn[j][0], y + r, inn[j][1]], [inn[i][0], y + r, inn[i][1]]],
            [[len / l.tile[0], 0], [0, 0], [0, slant / l.tile[1]], [len / l.tile[0], slant / l.tile[1]]],
            roof,
            [out[0], Math.hypot(out[0], out[2]) * (inset * k / Math.max(r, 1e-6)), out[2]],
          );
        }
      });
      this.cap(inner, y + r, top);
      return inner;
    }
    this.cap(poly, y, top);
    return poly;
  }

  /** A gabled roof over an axis-aligned rectangle, ridge along z (or x), with gable walls. */
  gable(x0: number, x1: number, z0: number, z1: number, y: number, rise: number, roof: Surface, end: Surface, ridgeAlongX = false, overhang = 0): void {
    const l = layerOf(roof);
    if (!ridgeAlongX) {
      const xm = (x0 + x1) / 2;
      const slant = Math.hypot(xm - x0 + overhang, rise);
      const len = z1 - z0;
      const U = len / l.tile[0];
      const V = slant / l.tile[1];
      const ey = y - (overhang * rise) / (xm - x0);
      this.faceToward([[x0 - overhang, ey, z0], [x0 - overhang, ey, z1], [xm, y + rise, z1], [xm, y + rise, z0]], [[0, 0], [U, 0], [U, V], [0, V]], roof, [-rise, xm - x0, 0]);
      this.faceToward([[x1 + overhang, ey, z0], [x1 + overhang, ey, z1], [xm, y + rise, z1], [xm, y + rise, z0]], [[U, 0], [0, 0], [0, V], [U, V]], roof, [rise, xm - x0, 0]);
      const g = (z: number, dir: number) =>
        this.faceToward([[x0, y, z], [x1, y, z], [xm, y + rise, z]], [[0, 0], [fitU(end, x1 - x0), 0], [fitU(end, x1 - x0) / 2, rise / layerOf(end).tile[1]]], end, [0, 0, dir]);
      g(z0, -1);
      g(z1, 1);
    } else {
      const zm = (z0 + z1) / 2;
      const slant = Math.hypot(zm - z0 + overhang, rise);
      const len = x1 - x0;
      const U = len / l.tile[0];
      const V = slant / l.tile[1];
      const ey = y - (overhang * rise) / (zm - z0);
      this.faceToward([[x0, ey, z0 - overhang], [x1, ey, z0 - overhang], [x1, y + rise, zm], [x0, y + rise, zm]], [[0, 0], [U, 0], [U, V], [0, V]], roof, [0, zm - z0, -rise]);
      this.faceToward([[x0, ey, z1 + overhang], [x1, ey, z1 + overhang], [x1, y + rise, zm], [x0, y + rise, zm]], [[U, 0], [0, 0], [0, V], [U, V]], roof, [0, zm - z0, rise]);
      const g = (x: number, dir: number) =>
        this.faceToward([[x, y, z0], [x, y, z1], [x, y + rise, zm]], [[0, 0], [fitU(end, z1 - z0), 0], [fitU(end, z1 - z0) / 2, rise / layerOf(end).tile[1]]], end, [dir, 0, 0]);
      g(x0, -1);
      g(x1, 1);
    }
  }

  /** A hipped roof over an axis-aligned rectangle (a pyramid when it is square). */
  hip(x0: number, x1: number, z0: number, z1: number, y: number, rise: number, roof: Surface): void {
    const w = x1 - x0;
    const d = z1 - z0;
    const h = Math.min(w, d) / 2;
    const xm = (x0 + x1) / 2;
    const zm = (z0 + z1) / 2;
    // Ridge from (xm, zm ± (d/2 - h)) or (xm ± (w/2 - h), zm).
    const ra: V3 = w >= d ? [x0 + h, y + rise, zm] : [xm, y + rise, z0 + h];
    const rb: V3 = w >= d ? [x1 - h, y + rise, zm] : [xm, y + rise, z1 - h];
    const c = [
      [x0, y, z0],
      [x1, y, z0],
      [x1, y, z1],
      [x0, y, z1],
    ] as V3[];
    const l = layerOf(roof);
    const slant = Math.hypot(h, rise) / l.tile[1];
    const quad = (p: V3, q: V3, r1: V3, r2: V3, out: V3) => {
      const len = Math.hypot(q[0] - p[0], q[2] - p[2]) / l.tile[0];
      this.faceToward([p, q, r1, r2], [[0, 0], [len, 0], [len, slant], [0, slant]], roof, out);
    };
    const tri = (p: V3, q: V3, r: V3, out: V3) => {
      const len = Math.hypot(q[0] - p[0], q[2] - p[2]) / l.tile[0];
      this.faceToward([p, q, r], [[0, 0], [len, 0], [len / 2, slant]], roof, out);
    };
    if (w >= d) {
      quad(c[0], c[1], rb, ra, [0, h, -rise]);
      quad(c[2], c[3], ra, rb, [0, h, rise]);
      tri(c[3], c[0], ra, [-rise, h, 0]);
      tri(c[1], c[2], rb, [rise, h, 0]);
    } else {
      quad(c[1], c[2], rb, ra, [rise, h, 0]);
      quad(c[3], c[0], ra, rb, [-rise, h, 0]);
      tri(c[0], c[1], ra, [0, h, -rise]);
      tri(c[2], c[3], rb, [0, h, rise]);
    }
  }

  /** World-space triangles, for the floor grid. */
  worldTriangles(): Float32Array {
    const out = new Float32Array(this.idx.length * 3);
    this.idx.forEach((v, i) => out.set([this.pos[v * 3], this.pos[v * 3 + 1], this.pos[v * 3 + 2]], i * 3));
    return out;
  }

  toMesh(material = "hero"): MeshDef {
    return {
      name: this.name,
      material: { name: material, roughness: 0.85 },
      position: new Float32Array(this.pos),
      normal: new Float32Array(this.nor),
      color: new Float32Array(this.col),
      uv: new Float32Array(this.uv),
      index: new Uint32Array(this.idx),
      extra: { _HERO: { array: new Float32Array(this.hero), size: 2 } },
    };
  }
}

const isRing = (p: Polygon | Ring): p is Ring => typeof p[0][0] === "number";

/**
 * Rings of n points round a path, `radii(k)` across and up at point k: each ring square to the
 * path, its side vector kept as horizontal as possible so the facets don't twist.
 */
function sections(path: V3[], radii: (k: number) => [number, number], n: number): V3[][] {
  let prevSide: V3 | null = null;
  const rings: V3[][] = [];
  for (let k = 0; k < path.length; k++) {
    const p = path[k];
    const q = path[Math.min(path.length - 1, k + 1)];
    const o = path[Math.max(0, k - 1)];
    let t: V3 = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
    const tl = Math.hypot(...t) || 1;
    t = [t[0] / tl, t[1] / tl, t[2] / tl];
    let side: V3 = prevSide ?? [-t[2], 0, t[0]];
    const dot = side[0] * t[0] + side[1] * t[1] + side[2] * t[2];
    side = [side[0] - t[0] * dot, side[1] - t[1] * dot, side[2] - t[2] * dot];
    const sl = Math.hypot(...side) || 1;
    side = [side[0] / sl, side[1] / sl, side[2] / sl];
    prevSide = side;
    const up: V3 = [t[1] * side[2] - t[2] * side[1], t[2] * side[0] - t[0] * side[2], t[0] * side[1] - t[1] * side[0]];
    const [rx, ry] = radii(k);
    const ring: V3[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const c = Math.cos(a) * rx;
      const sn = Math.sin(a) * ry;
      ring.push([p[0] + side[0] * c + up[0] * sn, p[1] + side[1] * c + up[1] * sn, p[2] + side[2] * c + up[2] * sn]);
    }
    rings.push(ring);
  }
  return rings;
}

export function ngon(cx: number, cz: number, n: number, r: number, rot0 = 0): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot0 + (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return ensureCcw(out);
}

/** Positive signed area (geom.ts): the orientation `walls` takes as an outer ring. */
export function ensureCcw(r: Ring): Ring {
  return signedArea(r) < 0 ? [...r].reverse() : r;
}

export function ensureCw(r: Ring): Ring {
  return signedArea(r) > 0 ? [...r].reverse() : r;
}

/** Outer ring counter-clockwise, holes clockwise. */
export function orient(poly: Polygon): Polygon {
  return poly.map((r, k) => (k === 0 ? ensureCcw(r) : ensureCw(r)));
}

/**
 * Every ring moved inward (into the solid) by d, mitred at the corners; null where the
 * result would fold over (an edge reversing, rings crossing).
 */
export function insetPolygon(poly: Polygon, d: number): Polygon | null {
  const out: Polygon = [];
  for (const r of poly) {
    const n = r.length;
    const ring: Ring = [];
    for (let i = 0; i < n; i++) {
      const p = r[(i + n - 1) % n];
      const q = r[i];
      const s = r[(i + 1) % n];
      // Inward normals of the two edges (the solid is on the left: (-ez, ex)).
      const n1 = inward(p, q);
      const n2 = inward(q, s);
      // Mitre: the point d from both offset edges, d (n1 + n2) / (1 + n1·n2).
      const den = Math.max(0.3, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
      ring.push([q[0] + (d * (n1[0] + n2[0])) / den, q[1] + (d * (n1[1] + n2[1])) / den]);
    }
    // No edge may reverse or vanish.
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ex = r[j][0] - r[i][0];
      const ez = r[j][1] - r[i][1];
      const fx = ring[j][0] - ring[i][0];
      const fz = ring[j][1] - ring[i][1];
      if (ex * fx + ez * fz <= 0.05 * Math.hypot(ex, ez)) return null;
    }
    out.push(ring);
  }
  // No crossings within or between rings.
  const segs: [Pt, Pt][] = out.flatMap((r) => r.map((p, i) => [p, r[(i + 1) % r.length]] as [Pt, Pt]));
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const [a, b] = segs[i];
      const [c, e] = segs[j];
      if (a === c || a === e || b === c || b === e) continue;
      if (crosses(a, b, c, e)) return null;
    }
  for (let k = 0; k < out.length; k++) if (Math.sign(signedArea(out[k])) !== Math.sign(signedArea(poly[k]))) return null;
  return out;
}

function inward(a: Pt, b: Pt): Pt {
  const ex = b[0] - a[0];
  const ez = b[1] - a[1];
  const l = Math.hypot(ex, ez) || 1;
  return [-ez / l, ex / l];
}

function crosses(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Points every `step` metres along a ring's edges (offset half a step from each corner). */
export function alongRing(r: Ring, step: number, skipShorterThan = 0): { p: Pt; out: Pt; edge: number }[] {
  const res: { p: Pt; out: Pt; edge: number }[] = [];
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < skipShorterThan) continue;
    const n = Math.max(1, Math.round(len / step));
    const ux = (b[0] - a[0]) / len;
    const uz = (b[1] - a[1]) / len;
    for (let k = 0; k <= n; k++) res.push({ p: [a[0] + ux * (len * k) / n, a[1] + uz * (len * k) / n], out: [uz, -ux], edge: i });
  }
  return res;
}
