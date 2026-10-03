// Roofs from straight skeletons. Buildings that touch are merged into blocks, and each block's
// skeleton (CGAL's, through the straight-skeleton package's WebAssembly build) gives the roof
// planes: every face rises from one stretch of the block's outline at the roof's pitch, so a
// roof runs on across party walls and slopes down only to the street and into courtyards. A
// profile caps the rise (a flat top over deep wings) or breaks it (a mansard's steep lower
// slope under a shallow upper one). Each building then takes the pieces of its block's roof
// over its own footprint, lifted to its own eaves.

import { cpus } from "node:os";
import { Worker } from "node:worker_threads";
import polygonClipping, { type MultiPolygon as PCMulti, type Polygon as PCPoly } from "polygon-clipping";
import { pointInRing, ringBox, signedArea, type Box, type Polygon, type Pt, type Ring } from "./geom";

interface Skeleton {
  vertices: [number, number, number][];
  polygons: number[][];
}
let builder: { buildFromPolygon(c: number[][][]): Skeleton | null } | null = null;

/** Loads the WebAssembly module (built for the web: it wants `self` and `window`). */
export async function initSkeleton(): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  g.self ??= globalThis;
  g.window ??= globalThis;
  const mod = (await import("straight-skeleton")) as unknown as { SkeletonBuilder: { init(): Promise<void>; buildFromPolygon(c: number[][][]): Skeleton | null } };
  await mod.SkeletonBuilder.init();
  builder = mod.SkeletonBuilder;
}

/**
 * A roof's section: height above the eaves as a function of the distance in from the eave
 * line, piecewise linear through `knots` ([distance, height], from [0, 0]), flat beyond the last.
 */
export interface Profile {
  key: string;
  knots: [number, number][];
}

export function pitched(pitchDeg: number, cap: number): Profile {
  const t = cap / Math.tan((pitchDeg * Math.PI) / 180);
  return { key: `p${pitchDeg}:${cap}`, knots: [[0, 0], [t, cap]] };
}

/** A mansard: a steep lower slope to `h1`, then a shallow one to `h2`. */
export function mansard(h1: number, h2: number): Profile {
  const t1 = h1 / Math.tan((72 * Math.PI) / 180);
  const t2 = t1 + (h2 - h1) / Math.tan((22 * Math.PI) / 180);
  return { key: `m${h1}:${h2}`, knots: [[0, 0], [t1, h1], [t2, h2]] };
}

export function profileHeight(p: Profile, t: number): number {
  const k = p.knots;
  for (let i = 0; i + 1 < k.length; i++) if (t <= k[i + 1][0]) return k[i][1] + ((t - k[i][0]) * (k[i + 1][1] - k[i][1])) / (k[i + 1][0] - k[i][0]);
  return k[k.length - 1][1];
}

/** One planar piece of a block's roof: a band of one skeleton face (or the flat top). */
export interface Piece {
  poly: Polygon;
  box: Box;
  /** Distance in from the face's eave line: t = a·x + b·z + c (|(a, b)| = 1). */
  a: number;
  b: number;
  c: number;
  /** Height above the eaves: h0 + (t - t0)·slope. */
  t0: number;
  h0: number;
  slope: number;
}

interface Face {
  ring: Ring;
  box: Box;
  a: number;
  b: number;
  c: number;
}

export interface Block {
  /** The merged outline (outer ring and courtyards). */
  outline: Polygon;
  box: Box;
  faces: Face[];
  /** Roof pieces by profile key, made on first use. */
  pieces: Map<string, Piece[]>;
}

const toPc = (p: Polygon): PCPoly => p.map((r) => r.map(([x, z]) => [x, z] as [number, number]));
const fromPc = (m: PCMulti): Polygon[] => m.map((poly) => poly.map((r) => r.slice(0, -1).map(([x, z]) => [x, z] as Pt)));

/** Least-squares plane t = a x + b z + c through a face's skeleton vertices. */
function fitPlane(pts: [number, number, number][]): { a: number; b: number; c: number } | null {
  let sx = 0, sz = 0, st = 0, sxx = 0, sxz = 0, szz = 0, sxt = 0, szt = 0;
  const n = pts.length;
  for (const [x, z, t] of pts) {
    sx += x; sz += z; st += t; sxx += x * x; sxz += x * z; szz += z * z; sxt += x * t; szt += z * t;
  }
  // Centre for conditioning.
  const mx = sx / n, mz = sz / n, mt = st / n;
  const cxx = sxx / n - mx * mx, cxz = sxz / n - mx * mz, czz = szz / n - mz * mz;
  const cxt = sxt / n - mx * mt, czt = szt / n - mz * mt;
  const det = cxx * czz - cxz * cxz;
  if (Math.abs(det) < 1e-9) return null;
  let a = (cxt * czz - czt * cxz) / det;
  let b = (czt * cxx - cxt * cxz) / det;
  const g = Math.hypot(a, b);
  if (g < 0.2) return null;
  // The skeleton's time is a distance, so the gradient is a unit vector: normalise away noise.
  a /= g;
  b /= g;
  return { a, b, c: mt - a * mx - b * mz };
}

/** Drops near-duplicate and collinear points (within 2 cm of the line through their neighbours). */
function cleanRing(r: Ring): Ring {
  let ring = r.filter((p, i) => {
    const q = r[(i + 1) % r.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.03;
  });
  for (let pass = 0; pass < 3 && ring.length > 3; pass++) {
    const keep = ring.filter((p, i) => {
      const a = ring[(i - 1 + ring.length) % ring.length];
      const b = ring[(i + 1) % ring.length];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l < 1e-6) return false;
      return Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / l > 0.02;
    });
    if (keep.length === ring.length) break;
    ring = keep;
  }
  return ring;
}

/** True if no two edges of the polygon's rings cross or touch, other than neighbours at their shared point. */
function isSimple(rings: Ring[]): boolean {
  const segs: [number, number, number, number, number, number][] = [];
  rings.forEach((r, k) => r.forEach((p, i) => {
    const q = r[(i + 1) % r.length];
    segs.push([p[0], p[1], q[0], q[1], k, i]);
  }));
  const orient = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  for (let i = 0; i < segs.length; i++) {
    const [ax, az, bx, bz, ka, ia] = segs[i];
    const minX = Math.min(ax, bx), maxX = Math.max(ax, bx), minZ = Math.min(az, bz), maxZ = Math.max(az, bz);
    for (let j = i + 1; j < segs.length; j++) {
      const [cx, cz, dx, dz, kc, ic] = segs[j];
      if (Math.max(cx, dx) < minX - 1e-3 || Math.min(cx, dx) > maxX + 1e-3 || Math.max(cz, dz) < minZ - 1e-3 || Math.min(cz, dz) > maxZ + 1e-3) continue;
      const n = rings[ka].length;
      const neighbours = ka === kc && (ic === (ia + 1) % n || ia === (ic + 1) % n);
      if (neighbours) continue;
      const d1 = orient(ax, az, bx, bz, cx, cz);
      const d2 = orient(ax, az, bx, bz, dx, dz);
      const d3 = orient(cx, cz, dx, dz, ax, az);
      const d4 = orient(cx, cz, dx, dz, bx, bz);
      if (d1 * d2 <= 0 && d3 * d4 <= 0) return false;
    }
  }
  return true;
}

/**
 * A polygon's skeleton faces, or null if the outline isn't simple or CGAL rejects it. The
 * library takes 32-bit floats, so the outline goes in about its own corner.
 */
export function skeletonFaces(outline: Polygon): Face[] | null {
  const rings0 = outline.map(cleanRing).filter((r, k) => r.length >= 3 && (k === 0 || Math.abs(signedArea(r)) > 0.5));
  if (!rings0.length || rings0[0].length < 3 || Math.abs(signedArea(rings0[0])) < 1) return null;
  if (!isSimple(rings0)) return null;
  const ox = rings0[0][0][0];
  const oz = rings0[0][0][1];
  const rings = rings0.map((r, k) => {
    const ring = r.map(([x, z]) => [x - ox, z - oz]);
    if ((signedArea(ring as Ring) > 0) !== (k === 0)) ring.reverse();
    return [...ring, ring[0]];
  });
  let sk: Skeleton | null = null;
  try {
    sk = builder!.buildFromPolygon(rings);
  } catch {
    sk = null;
  }
  if (!sk) return null;
  const faces: Face[] = [];
  for (const poly of sk.polygons) {
    const pts = poly.map((i) => {
      const [x, z, t] = sk!.vertices[i];
      return [x + ox, z + oz, t] as [number, number, number];
    });
    const plane = fitPlane(pts);
    if (!plane) continue;
    const ring = pts.map(([x, z]) => [x, z] as Pt);
    if (Math.abs(signedArea(ring)) < 0.01) continue;
    faces.push({ ring, box: ringBox(ring), ...plane });
  }
  return faces;
}

/**
 * Merges touching footprints into blocks and builds each block's skeleton. `polys[i]` is a
 * building's footprint; the result maps every building to its block.
 */
export async function buildBlocks(polys: Polygon[]): Promise<{ blocks: Block[]; blockOf: number[]; failed: number }> {
  const n = polys.length;
  const boxes = polys.map((p) => ringBox(p[0]));
  // Union-find over overlapping boxes (within 5 cm), through a 40 m grid.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const CELL = 40;
  const grid = new Map<string, number[]>();
  boxes.forEach((bx, i) => {
    for (let gx = Math.floor(bx.minX / CELL); gx <= Math.floor(bx.maxX / CELL); gx++)
      for (let gz = Math.floor(bx.minZ / CELL); gz <= Math.floor(bx.maxZ / CELL); gz++) {
        const key = `${gx},${gz}`;
        const list = grid.get(key);
        if (list) list.push(i);
        else grid.set(key, [i]);
      }
  });
  const E = 0.05;
  const touches = (i: number, j: number) => {
    const a = boxes[i];
    const b = boxes[j];
    if (a.minX > b.maxX + E || b.minX > a.maxX + E || a.minZ > b.maxZ + E || b.minZ > a.maxZ + E) return false;
    // Boxes overlap: do the rings come within E of each other (a shared wall or a corner)?
    for (const [x, z] of polys[i][0]) if (nearRing(polys[j][0], x, z, E)) return true;
    for (const [x, z] of polys[j][0]) if (nearRing(polys[i][0], x, z, E)) return true;
    return false;
  };
  for (const list of grid.values())
    for (let p = 0; p < list.length; p++)
      for (let q = p + 1; q < list.length; q++) {
        const i = list[p];
        const j = list[q];
        if (find(i) !== find(j) && touches(i, j)) parent[find(i)] = find(j);
      }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }

  // Merge each group into its outlines, and note which buildings each one holds.
  const outlines: { outline: Polygon; inside: number[] }[] = [];
  const taken = new Uint8Array(n);
  for (const members of groups.values()) {
    let merged: Polygon[];
    if (members.length === 1) merged = [polys[members[0]]];
    else {
      try {
        merged = fromPc(polygonClipping.union(toPc(polys[members[0]]), ...members.slice(1).map((i) => toPc(polys[i]))));
      } catch {
        merged = members.map((i) => polys[i]);
      }
    }
    for (const outline of merged) {
      if (!outline.length || outline[0].length < 3) continue;
      const inside = members.filter((i) => {
        if (taken[i]) return false;
        const [x, z] = interiorPoint(polys[i]);
        return pointInRing(outline[0], x, z);
      });
      for (const i of inside) taken[i] = 1;
      outlines.push({ outline, inside });
    }
  }

  const blocks: Block[] = [];
  const blockOf = new Array<number>(n).fill(-1);
  const results = await skeletonsInParallel(outlines.map((o) => o.outline));
  const retry: number[] = [];
  outlines.forEach(({ outline, inside }, k) => {
    const faces = results[k];
    if (!faces) {
      retry.push(...inside);
      return;
    }
    blocks.push({ outline, box: ringBox(outline[0]), faces, pieces: new Map() });
    for (const i of inside) blockOf[i] = blocks.length - 1;
  });
  // A merged outline that failed: each of its buildings gets a skeleton of its own.
  const own = await skeletonsInParallel(retry.map((i) => polys[i]));
  retry.forEach((i, k) => {
    if (!own[k]) return;
    blocks.push({ outline: polys[i], box: ringBox(polys[i][0]), faces: own[k]!, pieces: new Map() });
    blockOf[i] = blocks.length - 1;
  });
  return { blocks, blockOf, failed: outlines.length - results.filter(Boolean).length };
}

/**
 * Skeletons on every core: CGAL's exact construction takes 10-20 ms for a block of a few dozen
 * corners. Workers each load their own WebAssembly module and take batches, largest first.
 */
async function skeletonsInParallel(outlines: Polygon[]): Promise<(Face[] | null)[]> {
  const out: (Face[] | null)[] = new Array(outlines.length).fill(null);
  if (!outlines.length) return out;
  const order = outlines.map((o, i) => [i, o.reduce((s, r) => s + r.length, 0)] as const).sort((a, b) => b[1] - a[1]).map(([i]) => i);
  const threads = Math.max(1, Math.min(cpus().length, Math.ceil(outlines.length / 40)));
  const BATCH = 24;
  let next = 0;
  await Promise.all(
    Array.from({ length: threads }, async () => {
      const worker = new Worker(new URL("./skeletonWorker.ts", import.meta.url));
      let fail: (e: Error) => void = () => {};
      worker.on("error", (e: Error) => fail(e));
      const reply = <T>(send?: () => void) =>
        new Promise<T>((res, rej) => {
          fail = rej;
          worker.once("message", res);
          send?.();
        });
      try {
        await reply<string>();
        while (next < order.length) {
          const batch = order.slice(next, next + BATCH);
          next += BATCH;
          const faces = await reply<(Face[] | null)[]>(() => worker.postMessage(batch.map((i) => outlines[i])));
          batch.forEach((i, k) => (out[i] = faces[k]));
        }
      } finally {
        await worker.terminate();
      }
    }),
  );
  return out;
}

function nearRing(r: Ring, x: number, z: number, e: number): boolean {
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [ax, az] = r[j];
    const [bx, bz] = r[i];
    const ex = bx - ax;
    const ez = bz - az;
    const u = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
    if (Math.hypot(ax + ex * u - x, az + ez * u - z) < e) return true;
  }
  return false;
}

/** A point inside a polygon: the centre of its widest horizontal span through the middle. */
export function interiorPoint(p: Polygon): Pt {
  const box = ringBox(p[0]);
  for (const f of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const z = box.minZ + (box.maxZ - box.minZ) * f;
    const xs: number[] = [];
    for (const r of p)
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [x1, z1] = r[j];
        const [x2, z2] = r[i];
        if (z1 <= z !== z2 <= z) xs.push(x1 + ((z - z1) / (z2 - z1)) * (x2 - x1));
      }
    xs.sort((a, b) => a - b);
    let best = -1;
    let at = 0;
    for (let k = 0; k + 1 < xs.length; k += 2)
      if (xs[k + 1] - xs[k] > best) {
        best = xs[k + 1] - xs[k];
        at = (xs[k] + xs[k + 1]) / 2;
      }
    if (best > 0) return [at, z];
  }
  return p[0][0];
}

/** The half-plane t ≤ limit (or t ≥ limit) of a face's plane, as a big quad. */
function halfPlane(f: { a: number; b: number; c: number }, limit: number, below: boolean, cx: number, cz: number): PCPoly {
  const L = 3000;
  const t = f.a * cx + f.b * cz + f.c;
  // The point on the line t = limit nearest the centre, the line's direction, and the side.
  const px = cx + f.a * (limit - t);
  const pz = cz + f.b * (limit - t);
  const dx = -f.b;
  const dz = f.a;
  const s = below ? -1 : 1;
  const ring: [number, number][] = [
    [px + dx * L, pz + dz * L],
    [px - dx * L, pz - dz * L],
    [px - dx * L + s * f.a * L, pz - dz * L + s * f.b * L],
    [px + dx * L + s * f.a * L, pz + dz * L + s * f.b * L],
  ];
  return [ring];
}

/** The block's roof cut into planar pieces for a profile: each face split at the knots. */
export function blockPieces(block: Block, profile: Profile): Piece[] {
  const cached = block.pieces.get(profile.key);
  if (cached) return cached;
  const pieces: Piece[] = [];
  const k = profile.knots;
  for (const f of block.faces) {
    const [cx, cz] = [(f.box.minX + f.box.maxX) / 2, (f.box.minZ + f.box.maxZ) / 2];
    let tMax = 0;
    for (const [x, z] of f.ring) tMax = Math.max(tMax, f.a * x + f.b * z + f.c);
    const face: PCPoly = [f.ring.map(([x, z]) => [x, z] as [number, number])];
    for (let i = 0; i < k.length; i++) {
      const t0 = k[i][0];
      const t1 = i + 1 < k.length ? k[i + 1][0] : Infinity;
      if (t0 >= tMax - 1e-6) break;
      const slope = i + 1 < k.length ? (k[i + 1][1] - k[i][1]) / (t1 - t0) : 0;
      let parts: Polygon[];
      if (t0 <= 1e-6 && t1 >= tMax) parts = [[f.ring]];
      else {
        try {
          let band: PCMulti = [face];
          if (t0 > 1e-6) band = polygonClipping.intersection(band, halfPlane(f, t0, false, cx, cz));
          if (t1 < tMax) band = polygonClipping.intersection(band, halfPlane(f, t1, true, cx, cz));
          parts = fromPc(band);
        } catch {
          parts = [];
        }
      }
      for (const poly of parts) {
        if (!poly.length || Math.abs(signedArea(poly[0])) < 0.02) continue;
        pieces.push({ poly, box: ringBox(poly[0]), a: f.a, b: f.b, c: f.c, t0, h0: k[i][1], slope });
      }
    }
  }
  block.pieces.set(profile.key, pieces);
  return pieces;
}

export function pieceHeight(p: Piece, x: number, z: number): number {
  return p.h0 + (p.a * x + p.b * z + p.c - p.t0) * p.slope;
}

/** The roof height above the eaves at (x, z), from the piece containing it (0 outside the block). */
export function roofHeightAt(pieces: Piece[], x: number, z: number): number {
  for (const p of pieces) {
    const b = p.box;
    if (x < b.minX - 1e-3 || x > b.maxX + 1e-3 || z < b.minZ - 1e-3 || z > b.maxZ + 1e-3) continue;
    if (!pointInRing(p.poly[0], x, z)) continue;
    let hole = false;
    for (let h = 1; h < p.poly.length; h++) if (pointInRing(p.poly[h], x, z)) hole = true;
    if (!hole) return Math.max(0, pieceHeight(p, x, z));
  }
  return -1;
}

/** A building's share of its block's roof: the pieces clipped to its footprint. */
export function clipPieces(pieces: Piece[], footprint: Polygon): { poly: Polygon; piece: Piece }[] {
  const fb = ringBox(footprint[0]);
  const out: { poly: Polygon; piece: Piece }[] = [];
  const fp = toPc(footprint);
  for (const p of pieces) {
    const b = p.box;
    if (b.minX > fb.maxX || b.maxX < fb.minX || b.minZ > fb.maxZ || b.maxZ < fb.minZ) continue;
    let parts: Polygon[];
    try {
      parts = fromPc(polygonClipping.intersection(toPc(p.poly), fp));
    } catch {
      continue;
    }
    for (const poly of parts) if (poly.length && Math.abs(signedArea(poly[0])) > 0.01) out.push({ poly, piece: p });
  }
  return out;
}
