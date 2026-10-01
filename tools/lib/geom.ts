// 2D geometry for the pipeline, in local metres. A ring is a closed loop of [x, z] points
// without a repeated last point; a polygon is an outer ring followed by its holes.

import { lonLatToLocal } from "../../src/geo";

export type Pt = [number, number];
export type Ring = Pt[];
export type Polygon = Ring[];

/** GeoJSON [lon, lat] ring (closed or not) to a local ring without the closing point. */
export function projectRing(coords: number[][]): Ring {
  const ring = coords.map(([lon, lat]): Pt => {
    const p = lonLatToLocal(lon, lat);
    return [p.x, p.z];
  });
  if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
  return ring;
}

/** Polygons of a GeoJSON Polygon or MultiPolygon geometry, projected. */
export function projectPolygons(geometry: { type: string; coordinates: unknown }): Polygon[] {
  if (geometry.type === "Polygon") return [(geometry.coordinates as number[][][]).map(projectRing)];
  if (geometry.type === "MultiPolygon") return (geometry.coordinates as number[][][][]).map((p) => p.map(projectRing));
  return [];
}

/** Signed area; positive when the ring runs counter-clockwise in (x, z) axes. */
export function signedArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return a / 2;
}

export function polygonArea(p: Polygon): number {
  return Math.abs(signedArea(p[0])) - p.slice(1).reduce((s, h) => s + Math.abs(signedArea(h)), 0);
}

export function centroid(r: Ring): Pt {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    a += f;
    cx += (r[j][0] + r[i][0]) * f;
    cz += (r[j][1] + r[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) return [r.reduce((s, p) => s + p[0], 0) / r.length, r.reduce((s, p) => s + p[1], 0) / r.length];
  return [cx / (3 * a), cz / (3 * a)];
}

export function pointInRing(r: Ring, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if (zi <= z !== zj <= z && x < xi + ((z - zi) / (zj - zi)) * (xj - xi)) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(p: Polygon, x: number, z: number): boolean {
  if (!pointInRing(p[0], x, z)) return false;
  for (let k = 1; k < p.length; k++) if (pointInRing(p[k], x, z)) return false;
  return true;
}

export function distToSegment(x: number, z: number, a: Pt, b: Pt): number {
  const ex = b[0] - a[0];
  const ez = b[1] - a[1];
  const u = Math.min(1, Math.max(0, ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez || 1)));
  return Math.hypot(a[0] + ex * u - x, a[1] + ez * u - z);
}

export function distToRing(r: Ring, x: number, z: number): number {
  let d = Infinity;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) d = Math.min(d, distToSegment(x, z, r[j], r[i]));
  return d;
}

export interface Box {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function ringBox(r: Ring): Box {
  const b = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const [x, z] of r) {
    b.minX = Math.min(b.minX, x);
    b.maxX = Math.max(b.maxX, x);
    b.minZ = Math.min(b.minZ, z);
    b.maxZ = Math.max(b.maxZ, z);
  }
  return b;
}

/** Douglas–Peucker on an open polyline. */
export function simplifyLine(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let worstD = tol;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i][0], pts[i][1], pts[a], pts[b]);
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Douglas–Peucker on a closed ring: split at the point farthest from the first, simplify both halves. */
export function simplifyRing(r: Ring, tol: number): Ring {
  if (r.length <= 4) return r.slice();
  let far = 0;
  let farD = -1;
  for (let i = 1; i < r.length; i++) {
    const d = Math.hypot(r[i][0] - r[0][0], r[i][1] - r[0][1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = simplifyLine(r.slice(0, far + 1), tol);
  const b = simplifyLine([...r.slice(far), r[0]], tol);
  const out = [...a, ...b.slice(1, -1)];
  return out.length >= 3 ? out : r.slice();
}

/** Minimum-area oriented rectangle (rotating calipers over the hull edges). */
export function minAreaRect(points: Pt[]): { cx: number; cz: number; ux: number; uz: number; halfU: number; halfV: number } {
  const hull = convexHull(points);
  let best = { area: Infinity, cx: 0, cz: 0, ux: 1, uz: 0, halfU: 0, halfV: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-9) continue;
    const ux = (b[0] - a[0]) / l;
    const uz = (b[1] - a[1]) / l;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uz;
      const v = -p[0] * uz + p[1] * ux;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best.area) {
      const um = (u0 + u1) / 2;
      const vm = (v0 + v1) / 2;
      best = { area, cx: um * ux - vm * uz, cz: um * uz + vm * ux, ux, uz, halfU: (u1 - u0) / 2, halfV: (v1 - v0) / 2 };
    }
  }
  return best;
}

export function convexHull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Small deterministic PRNG (same as the M0 grey box). */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable hash of a string to [0, 1), for per-building jitter that survives re-runs. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000003) / 1000003;
}

export const round2 = (v: number) => Math.round(v * 100) / 100;
