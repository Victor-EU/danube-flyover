// Step 7b: the ground. Bakes what the terrain's shader paints the city's ground with, at 1 m,
// from the OpenStreetMap roads and landcover:
//   ground/mask.bin  RGBA: the carriageways' signed distance (asphalt inside, the kerb at the
//                    edge; ±8 m), grass (parks, gardens, lawns, pitches), unpaved paths, and
//                    cobbles (sett streets, mostly on Castle Hill); everything else is paving
//   ground/ao.bin    ambient occlusion at 2 m from the buildings and landmarks around each
//                    point (the open sky it sees), so streets and courtyards darken
//   ground/marks.glb lane lines (dashed, the centre line solid on the big two-way roads),
//                    zebra crossings, and the tram rails, draped on the terrain
// Usage: npm run build-ground (after build-city, which writes tools/out/buildings.json)

import { readFileSync, mkdirSync } from "node:fs";
import { worldBounds } from "../src/world/bounds";
import { Bridges, type BridgesJson } from "../src/world/bridges";
import { decodeGrid, encodeGrid } from "../src/world/gridFile";
import { River, type RiverJson } from "../src/world/river";
import { Terrain } from "../src/world/terrain";
import { distToSegment, projectPolygons, ringBox, type Polygon, type Pt } from "./lib/geom";
import { writeGlb, type MeshDef } from "./lib/gltf";
import { DATA_DIR, kb, ODBL, readData, readDataBytes, readOsm, writeDataBytes } from "./lib/io";
import { Raster } from "./lib/raster";

const b = worldBounds();
const river = new River(readData<RiverJson>("river.json"));
const terrain = new Terrain(decodeGrid(readDataBytes("terrain.bin")));
const bridges = new Bridges(readData<BridgesJson>("bridges.json"), river, terrain, false);
mkdirSync(new URL("ground/", DATA_DIR), { recursive: true });

const CELL = 1;
const nx = Math.ceil((b.x1 - b.x0) / CELL);
const nz = Math.ceil((b.z1 - b.z0) / CELL);
/** Sample (i, j) is the centre of cell (i, j). */
const X = (i: number) => b.x0 + (i + 0.5) * CELL;
const Z = (j: number) => b.z0 + (j + 0.5) * CELL;
const SDF_RANGE = 8;

// --- Roads ------------------------------------------------------------------------------------

/** Carriageway width (kerb to kerb, parking lanes included) by class, when untagged. */
const WIDTH: Record<string, number> = {
  motorway: 14, trunk: 14, primary: 15, secondary: 12, tertiary: 9.5, unclassified: 7, residential: 7.5, living_street: 5.5,
  service: 4.5, primary_link: 7, secondary_link: 6.5, tertiary_link: 6, motorway_link: 7, trunk_link: 7, road: 6, busway: 7,
};
const BIG = new Set(["motorway", "trunk", "primary", "secondary"]);
const SETT = new Set(["sett", "cobblestone", "unhewn_cobblestone", "pebblestone", "stone"]);
const UNPAVED = new Set(["gravel", "fine_gravel", "compacted", "dirt", "ground", "unpaved", "earth", "pebblestone", "woodchips", "grass"]);
const num = (v: string | undefined) => {
  const n = v ? Number(String(v).replace(",", ".").replace(/\s*m$/, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : NaN;
};

interface Road {
  line: Pt[];
  halfWidth: number;
  lanes: number;
  oneway: boolean;
  big: boolean;
  sett: boolean;
  highway: string;
}
interface Path {
  line: Pt[];
  halfWidth: number;
  unpaved: boolean;
}
const roads: Road[] = [];
const paths: Path[] = [];
const crossings: Pt[][] = [];
const parking: Polygon[] = [];
const lineOf = (coords: number[][]): Pt[] => projectPolygons({ type: "Polygon", coordinates: [coords] })[0][0];
const onBridge = (line: Pt[]) => line.every(([x, z]) => bridges.onFootprint(x, z, 1) || river.isWater(x, z));

for (const f of readOsm("roads")) {
  const p = f.properties as Record<string, string | undefined>;
  if (p.tunnel && p.tunnel !== "no") continue;
  if (p.covered === "yes" || p.indoor === "yes") continue;
  const layer = Number(p.layer ?? 0);
  if (layer < 0 || (p.bridge && p.bridge !== "no")) continue;
  if (p.amenity === "parking" && (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")) {
    if (p.parking === "underground" || p.parking === "multi-storey") continue;
    parking.push(...projectPolygons(f.geometry));
    continue;
  }
  if (f.geometry.type !== "LineString" || !p.highway) continue;
  const line = lineOf(f.geometry.coordinates as number[][]);
  if (line.length < 2 || onBridge(line)) continue;
  const h = p.highway;
  if (WIDTH[h] !== undefined) {
    const lanes = num(p.lanes) || (BIG.has(h) ? 4 : h === "tertiary" ? 2 : 1);
    const width = num(p.width) || Math.max(WIDTH[h], Math.min(24, lanes * 3.1 + (h === "residential" || h === "tertiary" ? 3 : 1)));
    roads.push({ line, halfWidth: width / 2, lanes, oneway: p.oneway === "yes" || p.junction === "roundabout", big: BIG.has(h), sett: SETT.has(p.surface ?? ""), highway: h });
  } else if (h === "footway" && p.footway === "crossing") crossings.push(line);
  else if (h === "footway" || h === "path" || h === "cycleway" || h === "bridleway" || h === "track" || h === "pedestrian") {
    const w = num(p.width) || { footway: 2.2, path: 1.6, cycleway: 2.2, bridleway: 2, track: 3, pedestrian: 5 }[h]!;
    paths.push({ line, halfWidth: w / 2, unpaved: UNPAVED.has(p.surface ?? "") || ((h === "path" || h === "track") && !p.surface) });
  }
}
console.log(`roads: ${roads.length} carriageways, ${paths.length} paths, ${crossings.length} crossings, ${parking.length} car parks`);

// --- Carriageway distance field ------------------------------------------------------------------

/** Signed distance to the carriageways' edge, negative inside; junctions filleted by a smooth min. */
const sdf = new Float32Array(nx * nz).fill(SDF_RANGE);
const settD = new Float32Array(nx * nz).fill(SDF_RANGE);
const FILLET = 3;
const smin = (a: number, c: number) => {
  const h = Math.max(FILLET - Math.abs(a - c), 0) / FILLET;
  return Math.min(a, c) - h * h * FILLET * 0.25;
};
function stampSegment(field: Float32Array, a: Pt, c: Pt, hw: number, smooth: boolean): void {
  const pad = hw + SDF_RANGE;
  const i0 = Math.max(0, Math.floor((Math.min(a[0], c[0]) - pad - b.x0) / CELL));
  const i1 = Math.min(nx - 1, Math.ceil((Math.max(a[0], c[0]) + pad - b.x0) / CELL));
  const j0 = Math.max(0, Math.floor((Math.min(a[1], c[1]) - pad - b.z0) / CELL));
  const j1 = Math.min(nz - 1, Math.ceil((Math.max(a[1], c[1]) + pad - b.z0) / CELL));
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const d = distToSegment(X(i), Z(j), a, c) - hw;
      if (d > SDF_RANGE) continue;
      const k = j * nx + i;
      field[k] = smooth ? smin(field[k], d) : Math.min(field[k], d);
    }
}
const t0 = performance.now();
for (const r of roads)
  for (let s = 0; s + 1 < r.line.length; s++) {
    stampSegment(sdf, r.line[s], r.line[s + 1], r.halfWidth, true);
    if (r.sett) stampSegment(settD, r.line[s], r.line[s + 1], r.halfWidth, false);
  }
// Car parks: the polygon's own signed distance.
{
  const field = new Raster(X(0), Z(0), CELL, nx, nz, 0);
  for (const poly of parking) {
    const box = ringBox(poly[0]);
    const inside = new Set<number>();
    field.forEachInside(poly, (k) => inside.add(k));
    const i0 = Math.max(0, Math.floor((box.minX - SDF_RANGE - b.x0) / CELL));
    const i1 = Math.min(nx - 1, Math.ceil((box.maxX + SDF_RANGE - b.x0) / CELL));
    const j0 = Math.max(0, Math.floor((box.minZ - SDF_RANGE - b.z0) / CELL));
    const j1 = Math.min(nz - 1, Math.ceil((box.maxZ + SDF_RANGE - b.z0) / CELL));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        let d = Infinity;
        for (const r of poly) for (let a = 0, c = r.length - 1; a < r.length; c = a++) d = Math.min(d, distToSegment(X(i), Z(j), r[c], r[a]));
        const k = j * nx + i;
        sdf[k] = smin(sdf[k], inside.has(k) ? -d : d);
      }
  }
}
console.log(`carriageways stamped in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

// --- Grass and paths ---------------------------------------------------------------------------

const GRASS = new Set(["park", "garden", "grass", "meadow", "village_green", "recreation_ground", "pitch", "cemetery", "grassland", "golf_course", "allotments", "orchard", "flowerbed", "stadium"]);
const grassBin = new Raster(X(0), Z(0), CELL, nx, nz, 0);
for (const f of readOsm("landcover")) {
  const p = f.properties as Record<string, string | undefined>;
  const kind = p.leisure ?? p.landuse ?? p.natural ?? "";
  if (!GRASS.has(kind)) continue;
  if (p.surface && !UNPAVED.has(p.surface) && p.surface !== "grass") continue; // paved squares and courts
  for (const poly of projectPolygons(f.geometry)) grassBin.fillPolygon(poly, 1, "max");
}
const grass = grassBin.blur(0.8);
// Paths: punched out of the grass (paved), or gravel where unpaved; only in green areas, where a
// footway isn't simply a pavement beside a street.
const pathW = new Float32Array(nx * nz);
for (const pth of paths)
  for (let s = 0; s + 1 < pth.line.length; s++) {
    const a = pth.line[s];
    const c = pth.line[s + 1];
    const pad = pth.halfWidth + 1.5;
    const i0 = Math.max(0, Math.floor((Math.min(a[0], c[0]) - pad - b.x0) / CELL));
    const i1 = Math.min(nx - 1, Math.ceil((Math.max(a[0], c[0]) + pad - b.x0) / CELL));
    const j0 = Math.max(0, Math.floor((Math.min(a[1], c[1]) - pad - b.z0) / CELL));
    const j1 = Math.min(nz - 1, Math.ceil((Math.max(a[1], c[1]) + pad - b.z0) / CELL));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i;
        if (grassBin.data[k] < 0.5 && !pth.unpaved) continue;
        const d = distToSegment(X(i), Z(j), a, c) - pth.halfWidth;
        const w = Math.min(1, Math.max(0, 0.5 - d / 0.8));
        if (w <= 0) continue;
        if (pth.unpaved) pathW[k] = Math.max(pathW[k], w);
        grass.data[k] *= 1 - w;
      }
  }

// --- Ground occlusion ----------------------------------------------------------------------------

const AO_CELL = 2;
const anx = Math.ceil(nx / AO_CELL);
const anz = Math.ceil(nz / AO_CELL);
/** Building and landmark tops (world y) on the AO grid, -Infinity where open. */
const tops = new Raster(b.x0 + AO_CELL / 2, b.z0 + AO_CELL / 2, AO_CELL, anx, anz, -Infinity);
const footprints = JSON.parse(readFileSync(new URL("./out/buildings.json", import.meta.url), "utf8")) as { top: number; ring: number[] }[];
for (const fp of footprints) {
  const ring: Pt[] = [];
  for (let k = 0; k < fp.ring.length; k += 2) ring.push([fp.ring[k], fp.ring[k + 1]]);
  tops.fillPolygon([ring], fp.top, "max");
}
const heroOut = JSON.parse(readFileSync(new URL("./out/heroes.json", import.meta.url), "utf8")) as { cell: number; heroes: Record<string, { cells: number[] }> };
for (const h of Object.values(heroOut.heroes))
  for (let k = 0; k < h.cells.length; k += 3) {
    const cx = b.x0 + (h.cells[k] + 0.5) * heroOut.cell;
    const cz = b.z0 + (h.cells[k + 1] + 0.5) * heroOut.cell;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const i = Math.floor((cx + dx * 1.6 - b.x0) / AO_CELL);
        const j = Math.floor((cz + dz * 1.6 - b.z0) / AO_CELL);
        if (i >= 0 && j >= 0 && i < anx && j < anz) tops.data[j * anx + i] = Math.max(tops.data[j * anx + i], h.cells[k + 2]);
      }
  }
const ao = new Uint8Array(anx * anz);
{
  const DIRS = 12;
  const STEPS = [2, 3, 4.5, 6.5, 9, 12, 16, 21, 28, 36];
  const dirs = Array.from({ length: DIRS }, (_, k) => [Math.cos((k * 2 * Math.PI) / DIRS), Math.sin((k * 2 * Math.PI) / DIRS)]);
  for (let j = 0; j < anz; j++)
    for (let i = 0; i < anx; i++) {
      const k = j * anx + i;
      if (tops.data[k] > -Infinity) {
        ao[k] = 255;
        continue;
      }
      const x = tops.x(i);
      const z = tops.z(j);
      const g = terrain.heightAt(x, z);
      let occ = 0;
      for (const [dx, dz] of dirs) {
        let best = 0;
        for (const s of STEPS) {
          const ii = Math.round((x + dx * s - tops.x0) / AO_CELL);
          const jj = Math.round((z + dz * s - tops.z0) / AO_CELL);
          if (ii < 0 || jj < 0 || ii >= anx || jj >= anz) break;
          const t = tops.data[jj * anx + ii];
          if (t > g) best = Math.max(best, (t - g) / Math.hypot(s, t - g));
        }
        occ += best;
      }
      // Sky seen: 1 in the open, about 0.45 at the foot of a wall in a narrow street.
      const open = 1 - 0.8 * (occ / DIRS);
      ao[k] = Math.round(Math.min(1, Math.max(0, open)) * 255);
    }
}

// --- Pack ------------------------------------------------------------------------------------------

const rgba = new Uint8Array(nx * nz * 4);
for (let k = 0; k < nx * nz; k++) {
  const d = Math.min(SDF_RANGE, Math.max(-SDF_RANGE, sdf[k]));
  rgba[k * 4] = Math.round((0.5 - d / (2 * SDF_RANGE)) * 255); // > 127.5 inside a carriageway
  rgba[k * 4 + 1] = Math.round(Math.min(1, grass.data[k]) * 255);
  rgba[k * 4 + 2] = Math.round(pathW[k] * 255);
  rgba[k * 4 + 3] = Math.round(Math.min(1, Math.max(0, 0.5 - settD[k] / 1.0)) * 255);
}
const header = { kind: "ground", license: ODBL, x0: b.x0, z0: b.z0, cell: CELL, nx, nz, sdfRange: SDF_RANGE };
const maskSize = writeDataBytes("ground/mask.bin", encodeGrid({ ...header, layers: [{ name: "rgba", type: "uint8", channels: 4 }] }, [rgba]));
const aoSize = writeDataBytes("ground/ao.bin", encodeGrid({ kind: "groundAo", license: ODBL, x0: b.x0, z0: b.z0, cell: AO_CELL, nx: anx, nz: anz, layers: [{ name: "ao", type: "uint8" }] }, [ao]));

// --- Markings and rails ----------------------------------------------------------------------------

/** Every road vertex shared by two or more carriageways: a junction, where markings stop. */
const junctionCount = new Map<string, number>();
const keyOf = (p: Pt) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
for (const r of roads) for (const p of r.line) junctionCount.set(keyOf(p), (junctionCount.get(keyOf(p)) ?? 0) + 1);
for (const r of roads) for (const p of [r.line[0], r.line[r.line.length - 1]]) junctionCount.set(keyOf(p), (junctionCount.get(keyOf(p)) ?? 0) + 1);
const junctions: Pt[] = [...junctionCount.entries()].filter(([, n]) => n >= 2).map(([k]) => k.split(",").map(Number) as Pt);
const JCELL = 25;
const jgrid = new Map<string, Pt[]>();
for (const p of junctions) {
  const key = `${Math.floor(p[0] / JCELL)},${Math.floor(p[1] / JCELL)}`;
  (jgrid.get(key) ?? jgrid.set(key, []).get(key)!).push(p);
}
const nearJunction = (x: number, z: number, r: number) => {
  for (let gx = Math.floor((x - r) / JCELL); gx <= Math.floor((x + r) / JCELL); gx++)
    for (let gz = Math.floor((z - r) / JCELL); gz <= Math.floor((z + r) / JCELL); gz++)
      for (const p of jgrid.get(`${gx},${gz}`) ?? []) if (Math.hypot(p[0] - x, p[1] - z) < r) return true;
  return false;
};

class Strips {
  pos: number[] = [];
  idx: number[] = [];
  /** A flat quad from centre (x, z), along unit (ux, uz) by `len`, across by `w`, on the terrain. */
  quad(x: number, z: number, ux: number, uz: number, len: number, w: number, lift: number): void {
    const vx = -uz;
    const vz = ux;
    const n = this.pos.length / 3;
    for (const [a, c] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
      const px = x + ux * len * a + vx * w * c;
      const pz = z + uz * len * a + vz * w * c;
      this.pos.push(px, terrain.heightAt(px, pz) + lift, pz);
    }
    this.idx.push(n, n + 2, n + 1, n, n + 3, n + 2);
  }
}
const paint = new Strips();
const rails = new Strips();
const LIFT = 0.07;
let dashes = 0;
/** Walks a polyline in steps of `step`, calling f with the point, direction and distance. */
function walk(line: Pt[], step: number, f: (x: number, z: number, ux: number, uz: number, s: number) => void): void {
  let s = 0;
  let next = step / 2;
  for (let k = 0; k + 1 < line.length; k++) {
    const [ax, az] = line[k];
    const [cx, cz] = line[k + 1];
    const l = Math.hypot(cx - ax, cz - az);
    if (l < 1e-6) continue;
    const ux = (cx - ax) / l;
    const uz = (cz - az) / l;
    while (next <= s + l) {
      const t = next - s;
      f(ax + ux * t, az + uz * t, ux, uz, next);
      next += step;
    }
    s += l;
  }
}
const LANE_W = 3.1;
for (const r of roads) {
  if (r.lanes < 2 || r.sett) continue;
  const n = Math.max(2, Math.min(6, Math.round(r.lanes)));
  const laneW = Math.min(LANE_W, (r.halfWidth * 2 - 1) / n);
  // Lane boundaries across the road, from its left edge; the centre of a two-way road is solid.
  for (let k = 1; k < n; k++) {
    const off = (k - n / 2) * laneW;
    const centre = !r.oneway && k === n / 2;
    const solid = centre && r.big;
    walk(r.line, solid ? 2 : 1, (x, z, ux, uz, s) => {
      if (nearJunction(x, z, r.halfWidth + 4)) return;
      const px = x - uz * off;
      const pz = z + ux * off;
      if (river.isWater(px, pz)) return;
      if (solid) paint.quad(px, pz, ux, uz, 2.05, 0.15, LIFT);
      else if (s % 9 < 1) {
        paint.quad(px, pz, ux, uz, 3, 0.13, LIFT);
        dashes++;
      }
    });
  }
}
// Zebras: 0.5 m stripes every metre along the crossing, 3.5 m long.
for (const c of crossings) walk(c, 1, (x, z, ux, uz) => paint.quad(x, z, ux, uz, 0.5, 3.5, LIFT));
// Tram rails: two per track, 1.435 m apart.
let railMetres = 0;
for (const f of readOsm("trams")) {
  const p = f.properties as Record<string, string | undefined>;
  if ((p.tunnel && p.tunnel !== "no") || (p.bridge && p.bridge !== "no") || f.geometry.type !== "LineString") continue;
  const line = lineOf(f.geometry.coordinates as number[][]);
  if (onBridge(line)) continue;
  walk(line, 2, (x, z, ux, uz) => {
    for (const side of [-0.7175, 0.7175]) rails.quad(x - uz * side, z + ux * side, ux, uz, 2.04, 0.09, LIFT + 0.01);
    railMetres += 2;
  });
}

// --- Traffic ---------------------------------------------------------------------------------------

/**
 * ground/traffic.json: the main roads as a graph the moving cars wander (each way with its
 * lanes each way; ways meet at shared end points), and ground/parked.bin, the parked cars along
 * the kerbs of the side streets: [x, z, heading, colour] as Float32, about seven in ten spaces
 * taken, none near a junction or a crossing.
 */
const DRIVEN = new Set(["primary", "secondary", "tertiary", "primary_link", "secondary_link", "tertiary_link", "trunk", "unclassified"]);
const PARKED = new Set(["residential", "tertiary", "secondary", "unclassified", "living_street"]);
const ways: { pts: number[]; fwd: number; back: number; laneW: number }[] = [];
for (const r of roads) {
  if (!DRIVEN.has(r.highway) || r.line.length < 2) continue;
  const n = Math.max(1, Math.round(r.lanes));
  const fwd = r.oneway ? n : Math.max(1, Math.floor(n / 2));
  const back = r.oneway ? 0 : Math.max(1, n - fwd);
  ways.push({ pts: r.line.flatMap(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]), fwd, back, laneW: Math.min(3.2, (r.halfWidth * 2) / (fwd + back)) });
}
const parked: number[] = [];
const prand = (() => {
  let a = 90211;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
const nearCrossing = (x: number, z: number) => crossings.some((c) => Math.hypot(c[0][0] - x, c[0][1] - z) < 9 || Math.hypot(c[c.length - 1][0] - x, c[c.length - 1][1] - z) < 9);
for (const r of roads) {
  if (!PARKED.has(r.highway) || r.sett || r.halfWidth < 3) continue;
  for (const side of [-1, 1]) {
    const off = side * (r.halfWidth - 1.15);
    walk(r.line, 5.4, (x, z, ux, uz) => {
      if (prand() > 0.72) return;
      const px = x - uz * off;
      const pz = z + ux * off;
      if (nearJunction(x, z, r.halfWidth + 9) || river.isWater(px, pz) || bridges.onFootprint(px, pz, 3)) return;
      if (r.highway !== "residential" && r.highway !== "living_street" && prand() < 0.5) return;
      if (nearCrossing(px, pz)) return;
      // Parked with the traffic on its side of the street (on the right of it, in Hungary).
      const heading = Math.atan2(ux, -uz) + (side > 0 ? 0 : Math.PI);
      parked.push(Math.round(px * 10) / 10, Math.round(pz * 10) / 10, Math.round(heading * 1000) / 1000, Math.floor(prand() * 16));
    });
  }
}
const trafficSize = writeDataBytes("ground/traffic.json", new TextEncoder().encode(JSON.stringify({ license: ODBL, note: "Main roads for the moving traffic: pts flat [x, z, ...], lanes each way (tools/build-ground.ts).", ways })));
const parkedSize = writeDataBytes("ground/parked.bin", new Uint8Array(new Float32Array(parked).buffer));
console.log(`ground/traffic.json ${kb(trafficSize)}: ${ways.length} ways; ground/parked.bin ${kb(parkedSize)}: ${parked.length / 4} parked cars`);

const mesh = (name: string, s: Strips, color: [number, number, number], roughness: number, metalness = 0): MeshDef => {
  const nor = new Float32Array(s.pos.length);
  for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  return { name, material: { name, color, roughness, metalness }, position: new Float32Array(s.pos), normal: nor, index: new Uint32Array(s.idx) };
};
const marksSize = await writeGlb("ground/marks.glb", [mesh("paint", paint, [0.86, 0.85, 0.8], 0.75), mesh("rails", rails, [0.42, 0.41, 0.4], 0.35, 0.8)], { license: ODBL });

console.log(`ground/mask.bin ${nx} × ${nz} at ${CELL} m, ${kb(maskSize)}; ground/ao.bin ${anx} × ${anz} at ${AO_CELL} m, ${kb(aoSize)}`);
console.log(`ground/marks.glb ${kb(marksSize)}: ${dashes} lane dashes, ${junctions.length} junctions kept clear, ${crossings.length} zebras, ${Math.round(railMetres / 1000)} km of tram track`);
