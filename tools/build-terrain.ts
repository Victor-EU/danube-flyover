// Step 3: terrain. Turns the GLO-30 surface model (which includes buildings and trees) into
// ground heights in metres above the river, on a 10 m grid over the world:
//   1. resample to 10 m and subtract the river level measured from the DEM's flattened water;
//   2. Buda: remove everything narrower than about 70 m, buildings and trees included (a
//      morphological opening), turn footprints too big for that into level pads, and smooth;
//   3. Pest and the islands are flattened, as the design doc says: a heavily smoothed lower
//      envelope, which keeps their gentle rise away from the river and nothing else;
//   4. the strip along the banks dips under the quays so the waterline stays crisp.
// Also classifies each sample (riverbed, street, park, wood, square, pitch, rock, island) from OSM.
// Writes public/data/terrain.bin. Usage: npm run build-terrain [-- --debug <dir>]

import { readFileSync } from "node:fs";
import { WORLD } from "../src/config";
import { lonLatToLocal } from "../src/geo";
import { worldBounds } from "../src/world/bounds";
import { encodeGrid } from "../src/world/gridFile";
import { River, type RiverJson } from "../src/world/river";
import { TERRAIN_CELL, TERRAIN_CLASS as CLASS } from "../src/world/terrain";
import { minAreaRect, projectPolygons } from "./lib/geom";
import { COPERNICUS, kb, ODBL, readData, readOsm, writeDataBytes } from "./lib/io";
import { debugDir, writePng } from "./lib/png";
import { inpaint, Raster } from "./lib/raster";

const MARGIN = 600;


const b = worldBounds();
const river = new River(readData<RiverJson>("river.json"));

// --- 1. DEM resampled to 10 m, relative to the river --------------------------------------

const meta = JSON.parse(readFileSync(new URL("./dem/glo30.json", import.meta.url), "utf8")) as {
  width: number;
  height: number;
  west: number;
  north: number;
  dlon: number;
  dlat: number;
};
const dem = new Float32Array(readFileSync(new URL("./dem/glo30.bin", import.meta.url)).buffer.slice(0));
const demOrigin = lonLatToLocal(meta.west, meta.north);
const demStep = lonLatToLocal(meta.west + meta.dlon, meta.north - meta.dlat);
const demDX = demStep.x - demOrigin.x;
const demDZ = demStep.z - demOrigin.z;
function demAt(x: number, z: number): number {
  const fx = Math.min(Math.max((x - demOrigin.x) / demDX, 0), meta.width - 1.0001);
  const fz = Math.min(Math.max((z - demOrigin.z) / demDZ, 0), meta.height - 1.0001);
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const k = j * meta.width + i;
  return (dem[k] * (1 - u) + dem[k + 1] * u) * (1 - v) + (dem[k + meta.width] * (1 - u) + dem[k + meta.width + 1] * u) * v;
}

const C = TERRAIN_CELL;
const work = new Raster(b.x0 - MARGIN, b.z0 - MARGIN, C, Math.ceil((b.x1 - b.x0 + 2 * MARGIN) / C) + 1, Math.ceil((b.z1 - b.z0 + 2 * MARGIN) / C) + 1);
const { nx, nz } = work;
const clampZ = (z: number) => Math.min(b.z1 - 1, Math.max(b.z0 + 1, z));

// River level per 250 m band of z: the median DEM height well inside the water.
const BAND = 250;
const bands = new Map<number, number[]>();
for (let z = b.z0 + 5; z < b.z1; z += 20)
  for (let x = b.x0; x < b.x1; x += 20) {
    if (!river.isWater(x, z) || river.nearestBank(x, z, 40)) continue;
    const k = Math.floor((z - b.z0) / BAND);
    if (!bands.has(k)) bands.set(k, []);
    bands.get(k)!.push(demAt(x, z));
  }
const bandLevel = [...bands.entries()].sort((p, q) => p[0] - q[0]).map(([k, v]) => {
  v.sort((p, q) => p - q);
  return { z: b.z0 + (k + 0.5) * BAND, level: v[Math.floor(v.length / 2)] };
});
function riverLevel(z: number): number {
  if (z <= bandLevel[0].z) return bandLevel[0].level;
  for (let i = 0; i < bandLevel.length - 1; i++)
    if (z <= bandLevel[i + 1].z) {
      const t = (z - bandLevel[i].z) / (bandLevel[i + 1].z - bandLevel[i].z);
      return bandLevel[i].level + t * (bandLevel[i + 1].level - bandLevel[i].level);
    }
  return bandLevel[bandLevel.length - 1].level;
}
for (let j = 0; j < nz; j++) {
  const level = riverLevel(work.z(j));
  for (let i = 0; i < nx; i++) work.data[j * nx + i] = demAt(work.x(i), work.z(j)) - level;
}

// --- Regions: water, Buda, Pest, islands (by the order of water crossings along each row) ---

const REGION = { water: 0, buda: 1, pest: 2, island: 3 } as const;
const region = new Uint8Array(nx * nz);
for (let j = 0; j < nz; j++) {
  const z = work.z(j);
  const spans = river.waterSpans(clampZ(z));
  let k = 0;
  for (let i = 0; i < nx; i++) {
    const x = work.x(i);
    while (k < spans.length && spans[k] <= x) k++;
    const idx = j * nx + i;
    if (k % 2 === 1) region[idx] = REGION.water;
    else if (k === 0) region[idx] = REGION.buda;
    else if (k === spans.length) region[idx] = REGION.pest;
    else region[idx] = REGION.island;
  }
}

// --- 2. Buda: buildings out, bumps out, smoothed --------------------------------------------

// An opening (min then max filter) removes anything narrower than its window, buildings and
// trees included, and keeps wider shapes such as the Castle Hill plateau intact. Footprints too
// big for it (the palace) and the river are filled in from their surroundings first.
const OPEN_R = 3; // samples: a 70 m window
const BLUR = 12;
const bigMask = Raster.like(work);
for (const f of readOsm("buildings"))
  for (const poly of projectPolygons(f.geometry)) {
    const r = minAreaRect(poly[0]);
    if (Math.min(r.halfU, r.halfV) * 2 > OPEN_R * C * 1.6) bigMask.fillPolygon([poly[0]], 1);
  }
// The DEM's 30 m pixels smear each building over its neighbours: grow the mask by 20 m.
const grown = bigMask.morph(2, "max");
const opened = work.morph(OPEN_R, "min").morph(OPEN_R, "max");
// Each big footprint becomes a level pad at the 75th percentile of the ground around it, so a
// building on a hillside sits on a terrace rather than in a dip (a mean fill would pull the
// palace down toward the slopes below it).
{
  const seen = new Uint8Array(nx * nz);
  for (let start = 0; start < seen.length; start++) {
    if (!grown.data[start] || seen[start] || region[start] === REGION.water) continue;
    const comp: number[] = [];
    const ring = new Set<number>();
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      comp.push(k);
      const i = k % nx;
      const j = (k - i) / nx;
      for (let dj = -3; dj <= 3; dj++)
        for (let di = -3; di <= 3; di++) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
          const q = jj * nx + ii;
          if (grown.data[q]) {
            if (Math.abs(di) + Math.abs(dj) === 1 && !seen[q]) {
              seen[q] = 1;
              stack.push(q);
            }
          } else if (region[q] !== REGION.water) ring.add(q);
        }
    }
    const around = [...ring].map((q) => opened.data[q]).sort((p, q) => p - q);
    if (!around.length) continue;
    const pad = around[Math.floor(around.length * 0.75)];
    for (const k of comp) opened.data[k] = pad;
  }
}
// The river is filled from the banks, so its flat level doesn't drag the banks down in the blur.
const waterMask = new Uint8Array(nx * nz);
for (let k = 0; k < waterMask.length; k++) waterMask[k] = region[k] === REGION.water ? 1 : 0;
const buda = inpaint(opened, waterMask, 400).blur(BLUR);

// --- 3. Pest and the islands: a smoothed lower envelope -----------------------------------

const envelope = work.morph(12, "min"); // the lowest point within 125 m: streets and squares
for (let k = 0; k < envelope.data.length; k++) if (region[k] === REGION.water) envelope.data[k] = NaN;
// Blur only over land on each side: replace water with the nearest land value first (fill).
const envMask = new Uint8Array(nx * nz);
for (let k = 0; k < envMask.length; k++) envMask[k] = Number.isNaN(envelope.data[k]) ? 1 : 0;
for (let k = 0; k < envMask.length; k++) if (envMask[k]) envelope.data[k] = 0;
const flatLand = inpaint(envelope, envMask, 300).blur(200);

// --- 4. Combine, shape the banks, classify --------------------------------------------------

const out = new Raster(b.x0, b.z0, C, Math.ceil((b.x1 - b.x0) / C) + 1, Math.ceil((b.z1 - b.z0) / C) + 1);
const cls = new Uint8Array(out.nx * out.nz);
const Q = WORLD.quayHeight - 0.6; // just under the quay strip
const smoothstep = (a: number, c: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (c - a)));
  return t * t * (3 - 2 * t);
};
for (let j = 0; j < out.nz; j++)
  for (let i = 0; i < out.nx; i++) {
    const x = out.x(i);
    const z = out.z(j);
    const wi = Math.round((x - work.x0) / C);
    const wj = Math.round((z - work.z0) / C);
    const r = region[wj * nx + wi];
    const k = j * out.nx + i;
    if (r === REGION.water || river.isWater(x, z)) {
      out.data[k] = -3;
      cls[k] = CLASS.bed;
      continue;
    }
    const natural = r === REGION.buda ? buda.sample(x, z) : r === REGION.pest ? Math.min(Math.max(flatLand.sample(x, z), WORLD.landBase + 1), 14) : Math.min(Math.max(flatLand.sample(x, z), WORLD.quayHeight), 8);
    const hit = river.nearestBank(x, z, 100);
    const d = hit ? hit.d : 100;
    let h: number;
    if (d < 12) h = -3;
    else if (d < 40) h = -3 + (Q + 3) * smoothstep(12, 30, d);
    else h = Q + (Math.max(natural, Q) - Q) * smoothstep(40, 90, d);
    out.data[k] = h;
    cls[k] = r === REGION.island ? CLASS.island : CLASS.street;
  }

// Landcover from OSM, later layers win.
const cover = readOsm("landcover");
const layer = (test: (p: Record<string, string | undefined>) => boolean, c: number) => {
  for (const f of cover) {
    if (!test(f.properties)) continue;
    for (const poly of projectPolygons(f.geometry)) out.forEachInside(poly, (k) => cls[k] !== CLASS.bed && (cls[k] = c));
  }
};
layer((p) => ["park", "garden", "golf_course"].includes(p.leisure ?? "") || ["grass", "meadow", "recreation_ground", "cemetery", "village_green", "allotments", "orchard", "vineyard"].includes(p.landuse ?? "") || ["grassland", "heath"].includes(p.natural ?? ""), CLASS.park);
layer((p) => ["pitch", "stadium", "playground"].includes(p.leisure ?? ""), CLASS.pitch);
layer((p) => p.landuse === "forest" || p.natural === "wood" || p.natural === "scrub", CLASS.wood);
layer((p) => p.place === "square" || (p.highway === "pedestrian" && p.area === "yes"), CLASS.square);
layer((p) => p.natural === "bare_rock", CLASS.rock);
// The quay band reads as stone whatever OSM says about it.
for (let j = 0; j < out.nz; j++)
  for (let i = 0; i < out.nx; i++) {
    const k = j * out.nx + i;
    if (cls[k] === CLASS.bed) continue;
    const hit = river.nearestBank(out.x(i), out.z(j), WORLD.quayWidth);
    if (hit) cls[k] = CLASS.square;
  }

// --- Output ---------------------------------------------------------------------------------

const heights = new Int16Array(out.nx * out.nz);
for (let k = 0; k < heights.length; k++) heights[k] = Math.round(out.data[k] * 100);
const bytes = encodeGrid(
  {
    kind: "terrain",
    x0: out.x0,
    z0: out.z0,
    cell: C,
    nx: out.nx,
    nz: out.nz,
    layers: [
      { name: "height", type: "int16", scale: 0.01 },
      { name: "class", type: "uint8" },
    ],
    classes: CLASS,
    riverLevelASL: bandLevel.map((l) => [Math.round(l.z), Math.round(l.level * 10) / 10]),
    license: [COPERNICUS, ODBL],
  },
  [heights, cls],
);
const size = writeDataBytes("terrain.bin", bytes);

// Spot checks (metres above the river). Expectations are the design doc's: Castle Hill about
// 168 m and Gellért Hill 235 m above sea level; Pest and the islands are flattened.
const spots: [string, number, number, string][] = [
  ["Castle Hill, Szentháromság tér", 47.5017, 19.0344, "about 70"],
  ["Buda Castle, palace", 47.496, 19.0393, "-"],
  ["Gellért Hill, Citadella", 47.4869, 19.0466, "about 135"],
  ["Pest, Vörösmarty tér", 47.4962, 19.051, "flattened"],
  ["Pest, Kossuth tér", 47.5072, 19.0478, "flattened"],
  ["Margaret Island, centre", 47.526, 19.048, "flattened"],
  ["Batthyány tér", 47.5065, 19.039, "-"],
  ["Tabán", 47.4935, 19.0405, "-"],
];
console.log(`river level ${bandLevel[0].level.toFixed(1)} m (north) to ${bandLevel[bandLevel.length - 1].level.toFixed(1)} m (south) above sea level`);
for (const [name, lat, lon, expect] of spots) {
  const p = lonLatToLocal(lon, lat);
  console.log(`  ${name.padEnd(32)} ${out.sample(p.x, p.z).toFixed(1).padStart(6)} m   (surface model ${(demAt(p.x, p.z) - riverLevel(p.z)).toFixed(1).padStart(6)}; expected ${expect})`);
}
console.log(`terrain.bin ${out.nx} × ${out.nz} samples at ${C} m, ${kb(size)}`);

const dir = debugDir();
if (dir) {
  // Hillshade tinted by class, north up.
  const palette: Record<number, number[]> = { 0: [60, 90, 100], 1: [200, 190, 170], 2: [120, 160, 90], 3: [70, 110, 60], 4: [215, 205, 180], 5: [150, 180, 110], 6: [170, 160, 150], 7: [130, 170, 95] };
  const rgb = new Uint8Array(out.nx * out.nz * 3);
  for (let j = 0; j < out.nz; j++)
    for (let i = 0; i < out.nx; i++) {
      const k = j * out.nx + i;
      const dx = out.get(Math.min(out.nx - 1, i + 1), j) - out.get(Math.max(0, i - 1), j);
      const dz = out.get(i, Math.min(out.nz - 1, j + 1)) - out.get(i, Math.max(0, j - 1));
      const shade = Math.min(1.3, Math.max(0.35, 0.9 + (-dx + dz) * 0.06));
      const c = palette[cls[k]];
      for (let q = 0; q < 3; q++) rgb[k * 3 + q] = Math.min(255, c[q] * shade);
    }
  writePng(`${dir}/terrain.png`, out.nx, out.nz, rgb);
  console.log(`debug image ${dir}/terrain.png`);
}
