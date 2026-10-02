// Step 7: the glider's altitude floor. A 5 m grid over the world holding, per cell, the highest
// of terrain, building roofs, the hero models, tree crowns (see below) and bridge towers, plus
// whether the cell is open water or a tower standing in it. Bridge decks are not in the grid:
// the runtime's deck queries decide under or over (see docs/decisions.md).
// Writes public/data/floor.bin. Usage: npm run build-floor (after build-city)

import { readFileSync } from "node:fs";
import { GLIDER, WORLD } from "../src/config";
import { worldBounds } from "../src/world/bounds";
import { Bridges, type BridgesJson } from "../src/world/bridges";
import { FLOOR_CELL, FLOOR_KIND } from "../src/world/floor";
import { decodeGrid, encodeGrid } from "../src/world/gridFile";
import { inPart, placeParts, type LandmarksJson } from "../src/world/landmarks";
import { River, type RiverJson } from "../src/world/river";
import { Terrain } from "../src/world/terrain";
import { distToRing, type Pt, type Ring } from "./lib/geom";
import { kb, readData, readDataBytes, writeDataBytes } from "./lib/io";
import { Raster } from "./lib/raster";

const C = FLOOR_CELL;
const b = worldBounds();
const river = new River(readData<RiverJson>("river.json"));
const terrain = new Terrain(decodeGrid(readDataBytes("terrain.bin")));
const bridges = new Bridges(readData<BridgesJson>("bridges.json"), river, terrain, false);
const landmarks = readData<LandmarksJson>("landmarks.json").landmarks;
const footprints = JSON.parse(readFileSync(new URL("./out/buildings.json", import.meta.url), "utf8")) as { top: number; ring: number[] }[];
const trees = readData<{ trees: number[] }>("trees.json").trees;

const nx = Math.ceil((b.x1 - b.x0) / C);
const nz = Math.ceil((b.z1 - b.z0) / C);
// Sample (i, j) is the centre of cell (i, j); cell (0, 0) starts at the world's corner.
const height = new Raster(b.x0 + C / 2, b.z0 + C / 2, C, nx, nz);
const kind = new Uint8Array(nx * nz);
const counts = { water: 0, building: 0, hero: 0, tree: 0, tower: 0 };

// Water and ground. A land cell takes the highest terrain over its corners and centre.
for (let j = 0; j < nz; j++) {
  const z = height.z(j);
  const spans = river.waterSpans(z);
  let s = 0;
  for (let i = 0; i < nx; i++) {
    const x = height.x(i);
    while (s < spans.length && spans[s] <= x) s++;
    const k = j * nx + i;
    if (s % 2 === 1) {
      kind[k] = FLOOR_KIND.water;
      counts.water++;
      continue;
    }
    let g = terrain.heightAt(x, z);
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) g = Math.max(g, terrain.heightAt(x + (dx * C) / 2, z + (dz * C) / 2));
    height.data[k] = Math.max(g, WORLD.quayHeight);
  }
}

/** Raise every cell touching the shape (centre inside, or within half a cell diagonal of it). */
const HALF_DIAG = (C * Math.SQRT2) / 2;
function raise(minX: number, minZ: number, maxX: number, maxZ: number, inside: (x: number, z: number) => boolean, top: number, k: number): number {
  let n = 0;
  const i0 = Math.max(0, Math.floor((minX - HALF_DIAG - b.x0) / C));
  const i1 = Math.min(nx - 1, Math.floor((maxX + HALF_DIAG - b.x0) / C));
  const j0 = Math.max(0, Math.floor((minZ - HALF_DIAG - b.z0) / C));
  const j1 = Math.min(nz - 1, Math.floor((maxZ + HALF_DIAG - b.z0) / C));
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const idx = j * nx + i;
      if (!inside(height.x(i), height.z(j))) continue;
      const wet = kind[idx] === FLOOR_KIND.water;
      if (wet && k !== FLOOR_KIND.tower) continue;
      if (top > height.data[idx] || wet) {
        height.data[idx] = Math.max(top, height.data[idx]);
        // Towers in the river are marked, so a glider passing under the deck can ignore them;
        // on land they are simply solid.
        if (wet) kind[idx] = FLOOR_KIND.tower;
        n++;
      }
    }
  return n;
}

for (const f of footprints) {
  const ring: Ring = [];
  for (let i = 0; i < f.ring.length; i += 2) ring.push([f.ring[i], f.ring[i + 1]] as Pt);
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const inRing = (x: number, z: number) => {
    let r = false;
    for (let a = 0, c = ring.length - 1; a < ring.length; c = a++) {
      const [xa, za] = ring[a];
      const [xc, zc] = ring[c];
      if (za <= z !== zc <= z && x < xa + ((z - za) / (zc - za)) * (xc - xa)) r = !r;
    }
    return r || distToRing(ring, x, z) <= HALF_DIAG;
  };
  counts.building += raise(minX, minZ, maxX, maxZ, inRing, f.top, FLOOR_KIND.land);
}

// The heroes: build-heroes lists the cells each model covers, at its triangles' tops.
const heroOut = JSON.parse(readFileSync(new URL("./out/heroes.json", import.meta.url), "utf8")) as { nx: number; heroes: Record<string, { cells: number[] }> };
if (heroOut.nx !== nx) throw new Error("tools/out/heroes.json is for another grid: run build-heroes again");
for (const h of Object.values(heroOut.heroes))
  for (let k = 0; k < h.cells.length; k += 3) {
    const idx = h.cells[k + 1] * nx + h.cells[k];
    if (kind[idx] === FLOOR_KIND.water || h.cells[k + 2] <= height.data[idx]) continue;
    height.data[idx] = h.cells[k + 2];
    counts.hero++;
  }

// Any landmark still on an M1 placeholder block.
for (const l of landmarks)
  for (const p of placeParts(l, (x, z) => terrain.heightAt(x, z))) {
    const r = Math.hypot(p.hw, p.hd);
    counts.hero += raise(p.x - r, p.z - r, p.x + r, p.z + r, (x, z) => inPart(p, x, z, HALF_DIAG), p.top, FLOOR_KIND.land);
  }

// Tree crowns, as the runtime draws them: radius 4.5 m and top 13 m above the ground, times the
// scale. The glider keeps only TREE_CLEARANCE above a crown, not the full land clearance, so the
// crown goes in lowered by the difference.
const TREE_CLEARANCE = 4;
for (let t = 0; t < trees.length; t += 3) {
  const [x, z, s] = [trees[t], trees[t + 1], trees[t + 2]];
  const r = 4.5 * s;
  const top = terrain.heightAt(x, z) + 13 * s + TREE_CLEARANCE - GLIDER.landClearance;
  counts.tree += raise(x - r, z - r, x + r, z + r, (px, pz) => Math.hypot(px - x, pz - z) <= r + HALF_DIAG * 0.5, top, FLOOR_KIND.land);
}

for (const o of bridges.obstacles) {
  if (!o.tower) continue;
  const r = Math.hypot(o.halfAlong, o.halfAcross);
  counts.tower += raise(o.cx - r, o.cz - r, o.cx + r, o.cz + r, (x, z) => {
    const dx = x - o.cx;
    const dz = z - o.cz;
    const a = dx * o.ux + dz * o.uz;
    const c = -dx * o.uz + dz * o.ux;
    return Math.abs(a) <= o.halfAlong + HALF_DIAG && Math.abs(c) <= o.halfAcross + HALF_DIAG;
  }, o.top, FLOOR_KIND.tower);
}

const dm = new Uint16Array(nx * nz);
for (let k = 0; k < dm.length; k++) dm[k] = Math.round(Math.max(0, height.data[k]) * 10);
const bytes = encodeGrid(
  {
    kind: "floor",
    x0: b.x0,
    z0: b.z0,
    cell: C,
    nx,
    nz,
    origin: "edge: cell (i, j) covers [x0 + i·cell, x0 + (i+1)·cell) × [z0 + j·cell, z0 + (j+1)·cell)",
    layers: [
      { name: "height", type: "uint16", scale: 0.1 },
      { name: "kind", type: "uint8" },
    ],
    kinds: FLOOR_KIND,
  },
  [dm, kind],
);
console.log(`floor.bin ${nx} × ${nz} cells at ${C} m, ${kb(writeDataBytes("floor.bin", bytes))}; cells raised: ${JSON.stringify(counts)}`);
