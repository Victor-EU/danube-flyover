// Step 2: the Danube. Unions the OSM river areas, clips them to the world, simplifies to 2 m
// and writes
//   public/data/river.json  water polygons, bank polylines and the centreline (runtime queries)
//   public/data/water.glb   the river surface (UVs along and across the flow) and the quays.
// Usage: npm run build-water

import earcut from "earcut";
import polygonClipping, { type MultiPolygon as PCMulti } from "polygon-clipping";
import { WORLD } from "../src/config";
import { worldBounds } from "../src/world/bounds";
import { distToRing, pointInPolygon, projectPolygons, projectRing, round2, signedArea, simplifyLine, simplifyRing, type Polygon, type Pt, type Ring } from "./lib/geom";
import { writeGlb, type MeshDef } from "./lib/gltf";
import { kb, ODBL, readOsm, writeData } from "./lib/io";

const SIMPLIFY = 2;
const STEINER = 60;
const b = worldBounds();
const osm = readOsm("water");

// --- Water polygons -----------------------------------------------------------------------

const riverAreas = osm.filter((f) => f.properties.water === "river" || f.properties.waterway === "riverbank");
const asPC = (polys: Polygon[]): PCMulti => polys.map((p) => p.map((r) => [...r, r[0]] as [number, number][]));
let union: PCMulti = [];
for (const f of riverAreas) union = polygonClipping.union(union, asPC(projectPolygons(f.geometry)));
const rect: PCMulti = [[[[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1], [b.x0, b.z0]]]];
const clipped = polygonClipping.intersection(union, rect);

const onEdge = (p: Pt) => Math.abs(p[1] - b.z0) < 0.05 || Math.abs(p[1] - b.z1) < 0.05 || Math.abs(p[0] - b.x0) < 0.05 || Math.abs(p[0] - b.x1) < 0.05;

/** Simplify a ring but never move or drop points on the world edge (they bound the clip). */
function simplifyKeepingEdges(r: Ring): Ring {
  const edgeIdx = r.map((p, i) => (onEdge(p) ? i : -1)).filter((i) => i >= 0);
  if (edgeIdx.length === 0) return simplifyRing(r, SIMPLIFY);
  const out: Ring = [];
  for (let k = 0; k < edgeIdx.length; k++) {
    const a = edgeIdx[k];
    const c = edgeIdx[(k + 1) % edgeIdx.length];
    const run: Pt[] = [];
    for (let i = a; ; i = (i + 1) % r.length) {
      run.push(r[i]);
      if (i === c && run.length > 1) break;
      if (edgeIdx.length === 1 && run.length > r.length) break;
    }
    out.push(...simplifyLine(run, SIMPLIFY).slice(0, -1));
  }
  return out;
}

const water: Polygon[] = clipped
  .map((poly) => poly.map((ring) => simplifyKeepingEdges(ring.slice(0, -1) as Ring)))
  .map((poly) => {
    // Consistent winding: outer rings positive signed area, holes negative.
    const [outer, ...holes] = poly;
    if (signedArea(outer) < 0) outer.reverse();
    for (const h of holes) if (signedArea(h) > 0) h.reverse();
    return [outer, ...holes];
  });
const isWater = (x: number, z: number) => water.some((p) => pointInPolygon(p, x, z));

// --- Banks: every ring edge that is not on the world edge ---------------------------------

const banks: Pt[][] = [];
for (const poly of water)
  for (const ring of poly) {
    const n = ring.length;
    const isClip = (i: number) => onEdge(ring[i]) && onEdge(ring[(i + 1) % n]);
    const start = [...Array(n).keys()].find((i) => isClip(i));
    if (start === undefined) {
      banks.push([...ring, ring[0]]); // a closed bank (island)
      continue;
    }
    let line: Pt[] = [];
    for (let k = 1; k <= n; k++) {
      const i = (start + k) % n;
      line.push(ring[i]);
      if (isClip(i)) {
        if (line.length >= 2) banks.push(line);
        line = [];
      }
    }
    if (line.length >= 2) banks.push(line);
  }

// --- Centreline: the Danube waterway ways, joined end to end ------------------------------

const lines = osm.filter((f) => f.properties.waterway === "river" && f.geometry.type === "LineString").map((f) => projectRing(f.geometry.coordinates as number[][]));
const key = (p: Pt) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
const chains: Pt[][] = [];
{
  const pool = lines.map((l) => l.slice());
  while (pool.length) {
    let chain = pool.pop()!;
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const l = pool[i];
        if (key(l[0]) === key(chain[chain.length - 1])) chain = [...chain, ...l.slice(1)];
        else if (key(l[l.length - 1]) === key(chain[0])) chain = [...l, ...chain.slice(1)];
        else if (key(l[0]) === key(chain[0])) chain = [...l.slice().reverse(), ...chain.slice(1)];
        else if (key(l[l.length - 1]) === key(chain[chain.length - 1])) chain = [...chain, ...l.slice().reverse().slice(1)];
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    chains.push(chain);
  }
}
const lineLength = (l: Pt[]) => l.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - l[i][0], p[1] - l[i][1]), 0);
let centre = chains.sort((p, q) => lineLength(q) - lineLength(p))[0];
if (centre[0][1] > centre[centre.length - 1][1]) centre.reverse(); // north to south, with the flow
centre = simplifyLine(centre.filter((p) => p[1] > b.z0 - 600 && p[1] < b.z1 + 600), 5);

/** Arc length along the centreline (u, with the flow) and signed offset across it (v, east positive). */
const centreS = [0];
for (let i = 1; i < centre.length; i++) centreS.push(centreS[i - 1] + Math.hypot(centre[i][0] - centre[i - 1][0], centre[i][1] - centre[i - 1][1]));
function flowUV(x: number, z: number): [number, number] {
  let best = Infinity;
  let uv: [number, number] = [0, 0];
  for (let i = 0; i < centre.length - 1; i++) {
    const [ax, az] = centre[i];
    const ex = centre[i + 1][0] - ax;
    const ez = centre[i + 1][1] - az;
    const l2 = ex * ex + ez * ez;
    const t = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / l2));
    const d = Math.hypot(ax + ex * t - x, az + ez * t - z);
    if (d < best) {
      best = d;
      const l = Math.sqrt(l2);
      // The flow runs south, so east is on its left: v is positive east of the line.
      const side = Math.sign(ex * (z - az) - ez * (x - ax)) || 1;
      uv = [centreS[i] + t * l, -side * d];
    }
  }
  return uv;
}

// --- River surface mesh -------------------------------------------------------------------

const surfPos: number[] = [];
const surfUV: number[] = [];
const surfIdx: number[] = [];
for (const poly of water) {
  const flat: number[] = [];
  const holes: number[] = [];
  for (let k = 0; k < poly.length; k++) {
    if (k > 0) holes.push(flat.length / 2);
    for (const p of poly[k]) flat.push(p[0], p[1]);
  }
  // Interior Steiner points as single-point holes keep the triangles even, for M3's water shader.
  const pb = poly[0].reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]), Math.max(a[2], p[0]), Math.max(a[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
  for (let z = Math.ceil(pb[1] / STEINER) * STEINER; z < pb[3]; z += STEINER)
    for (let x = Math.ceil(pb[0] / STEINER) * STEINER; x < pb[2]; x += STEINER) {
      if (!pointInPolygon(poly, x, z)) continue;
      if (poly.some((r) => distToRing(r, x, z) < 20)) continue;
      holes.push(flat.length / 2);
      flat.push(x, z);
    }
  const tris = earcut(flat, holes, 2);
  const base = surfPos.length / 3;
  for (let i = 0; i < flat.length; i += 2) {
    surfPos.push(flat[i], 0, flat[i + 1]);
    surfUV.push(...flowUV(flat[i], flat[i + 1]));
  }
  // earcut winds triangles to match the input; flip any facing down so the surface faces up.
  for (let t = 0; t < tris.length; t += 3) {
    const [a, c, d] = [tris[t], tris[t + 1], tris[t + 2]];
    const cross = (flat[c * 2] - flat[a * 2]) * (flat[d * 2 + 1] - flat[a * 2 + 1]) - (flat[c * 2 + 1] - flat[a * 2 + 1]) * (flat[d * 2] - flat[a * 2]);
    // The face normal's y is -cross, so cross < 0 already faces up.
    if (cross < 0) surfIdx.push(base + a, base + c, base + d);
    else surfIdx.push(base + a, base + d, base + c);
  }
}
const surfNormal = new Float32Array(surfPos.length);
for (let i = 1; i < surfNormal.length; i += 3) surfNormal[i] = 1;

// --- Quays: a wall at the waterline, a stone strip on the land side, an inner face ------------

const H = WORLD.quayHeight;
const W = WORLD.quayWidth;
const qPos: number[] = [];
const qCol: number[] = [];
const WALL = [0.659, 0.612, 0.502];
const TOP = [0.796, 0.749, 0.624];
const quad = (a: number[], c: number[], d: number[], e: number[], col: number[]) => {
  qPos.push(...a, ...c, ...d, ...a, ...d, ...e);
  for (let i = 0; i < 6; i++) qCol.push(...col);
};
for (const line of banks) {
  const closed = key(line[0]) === key(line[line.length - 1]);
  const p = closed ? line.slice(0, -1) : line;
  const n = p.length;
  const normals: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
    const c = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    const tx = p[c][0] - p[a][0];
    const tz = p[c][1] - p[a][1];
    const l = Math.hypot(tx, tz) || 1;
    let nx = -tz / l;
    let nz = tx / l;
    if (isWater(p[i][0] + nx * 6, p[i][1] + nz * 6)) {
      nx = -nx;
      nz = -nz;
    }
    normals.push([nx, nz]);
  }
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % n;
    const [ax, az] = p[i];
    const [bx, bz] = p[j];
    const ia = [ax + normals[i][0] * W, az + normals[i][1] * W];
    const ib = [bx + normals[j][0] * W, bz + normals[j][1] * W];
    quad([ax, H, az], [bx, H, bz], [ib[0], H, ib[1]], [ia[0], H, ia[1]], TOP);
    quad([ax, -3, az], [bx, -3, bz], [bx, H, bz], [ax, H, az], WALL);
    quad([ia[0], H, ia[1]], [ib[0], H, ib[1]], [ib[0], -3, ib[1]], [ia[0], -3, ia[1]], WALL);
  }
}
// Flat normals per triangle (the material is double-sided: land can lie on either side of a bank).
const qNormal = new Float32Array(qPos.length);
for (let t = 0; t < qPos.length; t += 9) {
  const ux = qPos[t + 3] - qPos[t];
  const uy = qPos[t + 4] - qPos[t + 1];
  const uz = qPos[t + 5] - qPos[t + 2];
  const vx = qPos[t + 6] - qPos[t];
  const vy = qPos[t + 7] - qPos[t + 1];
  const vz = qPos[t + 8] - qPos[t + 2];
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l;
  ny /= l;
  nz /= l;
  if (ny < -0.5) (nx = -nx), (ny = -ny), (nz = -nz);
  for (let k = 0; k < 3; k++) qNormal.set([nx, ny, nz], t + k * 3);
}

const meshes: MeshDef[] = [
  {
    name: "river",
    material: { name: "water", color: [0.231, 0.463, 0.502], roughness: 0.55 },
    position: new Float32Array(surfPos),
    normal: surfNormal,
    uv: new Float32Array(surfUV),
    index: new Uint32Array(surfIdx),
  },
  {
    name: "quays",
    material: { name: "quay", roughness: 0.9, doubleSided: true },
    position: new Float32Array(qPos),
    normal: qNormal,
    color: new Float32Array(qCol),
  },
];
const glbSize = await writeGlb("water.glb", meshes, { license: ODBL });

const flat = (r: Pt[]) => r.flatMap((p) => [round2(p[0]), round2(p[1])]);
const jsonSize = writeData("river.json", {
  license: ODBL,
  note: "Local metres (+X east, +Z south, origin at the Chain Bridge). water: polygons as [outer, ...holes], each ring a flat [x, z, ...] list. banks: the real bank lines (ring edges on the world edge removed); a closed bank repeats its first point.",
  water: water.map((p) => p.map(flat)),
  banks: banks.map(flat),
  centreline: flat(centre),
});

console.log(`river: ${water.length} polygon(s), rings ${water.map((p) => p.map((r) => r.length).join("+")).join(", ")}; ${banks.length} bank lines; centreline ${(lineLength(centre) / 1000).toFixed(2)} km from ${chains.length} chain(s)`);
console.log(`water.glb ${kb(glbSize)} (river ${surfIdx.length / 3} tris, quays ${qPos.length / 9} tris); river.json ${kb(jsonSize)}`);
