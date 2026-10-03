// Step 10: the far field, the city, the hills and the river beyond the world, out into the
// haze. From the wider DEM windows (fetch-dem far) and the far OSM extract (fetch-osm far):
//   far/terrain.bin    heights at 40 m over FAR.box, metres above the river: the surface model
//                      with the buildings taken out (their footprints filled in from around
//                      them, then a small opening), woods kept at their canopy, the river's bed
//                      under its water, and blended into the world's own terrain at its edge;
//   far/wide.bin       the same at 160 m over FAR.wide, for the hills beyond the box;
//   far/ground.webp    the box's ground at 12.5 m a pixel: land use, parks, woods in autumn,
//                      streets and rails, roofs; alpha is the street light falling there;
//   far/wide.webp      FAR.wide's at 50 m: the box's, and woods, fields and water beyond it;
//   far/buildings.bin  the box's buildings outside the world, as footprints with heights and
//                      colours per 1 km tile, for the runtime to extrude (src/world/farFormat.ts);
//   far/structures.glb the water beyond the world, the bridges over it, and towers, masts and
//                      chimneys; its extras hold the bridges' lamps and the aviation lights.
// Usage: npm run build-far [-- --debug <dir>]

import earcut from "earcut";
import { mkdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import polygonClipping, { type MultiPolygon as PCMulti, type Polygon as PCPoly } from "polygon-clipping";
import sharp from "sharp";
import { FAR } from "../src/config";
import { localToLonLat, lonLatToLocal } from "../src/geo";
import { worldBounds } from "../src/world/bounds";
import { FAR_ROOF_GROUPS, FAR_ROOFS, FAR_TILE, FAR_WALL_GROUPS, encodeFarBuildings, type FarBuilding } from "../src/world/farFormat";
import { decodeGrid, encodeGrid } from "../src/world/gridFile";
import { Terrain } from "../src/world/terrain";
import { centroid, mulberry32, projectPolygons, signedArea, type Polygon, type Pt, type Ring } from "./lib/geom";
import { writeGlb, type MeshDef } from "./lib/gltf";
import { COPERNICUS, DATA_DIR, kb, ODBL, OSM_DIR, readDataBytes, writeDataBytes, type OsmFeature } from "./lib/io";
import { debugDir, writePng } from "./lib/png";
import { inpaint, Raster } from "./lib/raster";

const t0 = performance.now();
const lap = (what: string) => console.log(`  ${what} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

mkdirSync(new URL("far/", DATA_DIR), { recursive: true });
const b = worldBounds();
const coreGrid = decodeGrid(readDataBytes("terrain.bin"));
const core = new Terrain(coreGrid);
const rectOf = (g: { latMin: number; latMax: number; lonMin: number; lonMax: number }) => {
  const nw = lonLatToLocal(g.lonMin, g.latMax);
  const se = lonLatToLocal(g.lonMax, g.latMin);
  return { x0: nw.x, x1: se.x, z0: nw.z, z1: se.z };
};
const box = rectOf(FAR.box);
const wide = rectOf(FAR.wide);
/** Distance from (x, z) to the world rectangle (0 inside it). */
const toWorld = (x: number, z: number) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.z0 - z, 0, z - b.z1));
const inWorld = (x: number, z: number, m = 0) => x > b.x0 + m && x < b.x1 - m && z > b.z0 + m && z < b.z1 - m;
const inBox = (x: number, z: number) => x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1;

const readFar = (g: string): OsmFeature[] => (JSON.parse(gunzipSync(readFileSync(new URL(`far/${g}.geojson.gz`, OSM_DIR))).toString("utf8")) as { features: OsmFeature[] }).features;

/** A DEM window (fetch-dem) as a bilinear sampler over local metres. */
function demSampler(name: string): (x: number, z: number) => number {
  const meta = JSON.parse(readFileSync(new URL(`./dem/${name}.json`, import.meta.url), "utf8")) as { width: number; height: number; west: number; north: number; dlon: number; dlat: number };
  const raw = new Int16Array(readFileSync(new URL(`./dem/${name}.bin`, import.meta.url)).buffer.slice(0));
  return (x, z) => {
    const { lon, lat } = localToLonLat(x, z);
    const fx = clamp((lon - meta.west) / meta.dlon, 0, meta.width - 1.001);
    const fz = clamp((meta.north - lat) / meta.dlat, 0, meta.height - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const k = j * meta.width + i;
    return ((raw[k] * (1 - u) + raw[k + 1] * u) * (1 - v) + (raw[k + meta.width] * (1 - u) + raw[k + meta.width + 1] * u) * v) / 10;
  };
}
const dsm = demSampler("far");
const dsmWide = demSampler("wide");

// --- The OSM layers ---------------------------------------------------------------------------

const buildingsOsm = readFar("buildings");
const roadsOsm = readFar("roads");
const landOsm = readFar("landcover");
const waterOsm = readFar("water");
const towersOsm = readFar("towers");
const bridgesOsm = readFar("bridges");
lap(`read ${buildingsOsm.length} buildings, ${roadsOsm.length} roads and rails, ${landOsm.length} land areas, ${waterOsm.length} water, ${towersOsm.length} towers, ${bridgesOsm.length} bridges`);

const water: Polygon[] = waterOsm.flatMap((f) => projectPolygons(f.geometry));

// --- River level ------------------------------------------------------------------------------

/** Metres above sea level of the river surface at z: the world's measured bands, then 7 cm a km falling south. */
const bands = (coreGrid.header.riverLevelASL as [number, number][]).slice().sort((p, q) => p[0] - q[0]);
function riverLevel(z: number): number {
  const first = bands[0];
  const last = bands[bands.length - 1];
  if (z <= first[0]) return first[1] + (first[0] - z) * 0.00007;
  if (z >= last[0]) return last[1] - (z - last[0]) * 0.00007;
  for (let i = 1; i < bands.length; i++)
    if (z <= bands[i][0]) {
      const t = (z - bands[i - 1][0]) / (bands[i][0] - bands[i - 1][0]);
      return bands[i - 1][1] + (bands[i][1] - bands[i - 1][1]) * t;
    }
  return last[1];
}

// --- 1. The box's terrain, 40 m -----------------------------------------------------------------

const C = 40;
const g = new Raster(box.x0, box.z0, C, Math.ceil((box.x1 - box.x0) / C) + 1, Math.ceil((box.z1 - box.z0) / C) + 1);
for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) g.data[j * g.nx + i] = dsm(g.x(i), g.z(j)) - riverLevel(g.z(j));

// Buildings out of the surface model: their footprints (and a sample around them, the DEM's
// 30 m pixels smear them over the street) filled in from the ground around.
const built = Raster.like(g);
const buildingPolys: { f: OsmFeature; poly: Polygon }[] = [];
for (const f of buildingsOsm)
  for (const poly of projectPolygons(f.geometry)) {
    if (poly[0].length < 3) continue;
    buildingPolys.push({ f, poly });
    built.fillPolygon([poly[0]], 1);
    const [cx, cz] = centroid(poly[0]);
    const i = Math.round((cx - g.x0) / C);
    const j = Math.round((cz - g.z0) / C);
    if (i >= 0 && j >= 0 && i < g.nx && j < g.nz) built.data[j * g.nx + i] = 1;
  }
const builtWide = built.morph(1, "max");
// Water by feature, all its rings at once (even-odd): a multipolygon's holes needn't sit in the outer OSM gave them.
const waterRings: Ring[][] = waterOsm.map((f) => projectPolygons(f.geometry).flat()).filter((r) => r.length);
const isWater = Raster.like(g);
for (const rings of waterRings) isWater.fillPolygon(rings, 1);
// Trees too, outside the woods (which keep their canopy): in the parks, gardens and streets
// they stand clear of the ground's opening (the surface with everything under 200 m across taken off).
const isWood = Raster.like(g);
for (const f of landOsm) {
  const p = f.properties;
  if (p.landuse === "forest" || p.natural === "wood" || p.natural === "scrub") isWood.fillPolygon(projectPolygons(f.geometry).flat(), 1);
}
const opened = g.morph(2, "min").morph(2, "max");
const mask = new Uint8Array(g.nx * g.nz);
for (let k = 0; k < mask.length; k++) {
  if (isWater.data[k]) continue;
  const tall = g.data[k] - opened.data[k] > 2.5 && !isWood.data[k];
  mask[k] = builtWide.data[k] > 0 || tall ? 1 : 0;
}
// Start the filled samples from the opening, so the relaxing only has to smooth.
const start = g.clone();
for (let k = 0; k < mask.length; k++) if (mask[k]) start.data[k] = opened.data[k];
let ground = inpaint(start, mask, 200, true);
// The DEM's noise.
ground = ground.blur(30);
lap("bare ground: buildings filled in, small things opened away");

// The river's bed under its water, and the banks just clear of it.
for (let j = 0; j < g.nz; j++)
  for (let i = 0; i < g.nx; i++) {
    const k = j * g.nx + i;
    if (isWater.data[k]) ground.data[k] = Math.min(ground.data[k], -2.5);
    else {
      let wet = false;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di;
        const jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < g.nx && jj < g.nz && isWater.data[jj * g.nx + ii]) wet = true;
      }
      if (wet) ground.data[k] = Math.max(ground.data[k], 1);
    }
  }

// Into the world's own terrain at its edge: over 600 m outside, and under it (2 m down) inside.
const BLEND = 600;
for (let j = 0; j < g.nz; j++)
  for (let i = 0; i < g.nx; i++) {
    const k = j * g.nx + i;
    const x = g.x(i);
    const z = g.z(j);
    const d = toWorld(x, z);
    if (d === 0) ground.data[k] = core.heightAt(x, z) - 2;
    else if (d < BLEND) {
      const edge = core.heightAt(clamp(x, b.x0, b.x1), clamp(z, b.z0, b.z1));
      ground.data[k] = edge + (ground.data[k] - edge) * smoothstep(0, BLEND, d);
    }
  }
lap("river bed, banks, and the blend into the world's terrain");

// --- 2. FAR.wide's terrain, 160 m -----------------------------------------------------------------

const WC = 160;
const wg = new Raster(wide.x0, wide.z0, WC, Math.ceil((wide.x1 - wide.x0) / WC) + 1, Math.ceil((wide.z1 - wide.z0) / WC) + 1);
for (let j = 0; j < wg.nz; j++) for (let i = 0; i < wg.nx; i++) wg.data[j * wg.nx + i] = dsmWide(wg.x(i), wg.z(j)) - riverLevel(wg.z(j));
// The river beyond the box: low and flat.
const wideWater = new Uint8Array(wg.nx * wg.nz);
for (let j = 1; j < wg.nz - 1; j++)
  for (let i = 1; i < wg.nx - 1; i++) {
    const k = j * wg.nx + i;
    const h = wg.data[k];
    let spread = 0;
    for (const d of [1, -1, wg.nx, -wg.nx]) spread = Math.max(spread, Math.abs(wg.data[k + d] - h));
    if (h < 1.6 && spread < 0.8) wideWater[k] = 1;
  }
// Lone flat cells aren't a river: keep the ones with water neighbours.
for (let pass = 0; pass < 2; pass++)
  for (let k = wg.nx; k < wideWater.length - wg.nx; k++) if (wideWater[k] && wideWater[k + 1] + wideWater[k - 1] + wideWater[k + wg.nx] + wideWater[k - wg.nx] < 2) wideWater[k] = 0;
const wground = wg.blur(120);
for (let j = 0; j < wg.nz; j++)
  for (let i = 0; i < wg.nx; i++) {
    const k = j * wg.nx + i;
    const x = wg.x(i);
    const z = wg.z(j);
    if (wideWater[k]) wground.data[k] = -2.5;
    // The box's own heights inside it (2 m under, its mesh draws there), blended out over 1.5 km.
    const dx = Math.max(box.x0 - x, 0, x - box.x1);
    const dz = Math.max(box.z0 - z, 0, z - box.z1);
    const d = Math.hypot(dx, dz);
    if (d === 0) wground.data[k] = ground.sample(x, z) - 2;
    else if (d < 1500) {
      const edge = ground.sample(clamp(x, box.x0, box.x1), clamp(z, box.z0, box.z1));
      wground.data[k] = edge + (wground.data[k] - edge) * smoothstep(0, 1500, d);
    }
  }
lap("the wide terrain");

const gridBytes = (r: Raster, kind: string, extra: Record<string, unknown>) => {
  const h = new Int16Array(r.data.length);
  for (let k = 0; k < h.length; k++) h[k] = Math.round(clamp(r.data[k], -1600, 1600) * 20);
  return encodeGrid({ kind, x0: r.x0, z0: r.z0, cell: r.cell, nx: r.nx, nz: r.nz, layers: [{ name: "height", type: "int16", scale: 0.05 }], ...extra, license: [COPERNICUS, ODBL] }, [h]);
};
const terrainSize = writeDataBytes("far/terrain.bin", gridBytes(ground, "far-terrain", { world: b }));
const wideSize = writeDataBytes("far/wide.bin", gridBytes(wground, "far-wide", { box }));

// --- 3. The ground's colours --------------------------------------------------------------------

type RGB = [number, number, number];
const hex = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];

/** An RGB and street-light painter over a rectangle, by pixel centre (supersampled, then halved). */
class Paint {
  readonly rgb: Uint8Array;
  readonly light: Uint8Array;
  readonly wood: Uint8Array;
  readonly s: number;
  constructor(
    readonly x0: number,
    readonly z0: number,
    readonly w: number,
    readonly h: number,
    readonly n: number,
    base: RGB,
  ) {
    this.s = w / n;
    this.rgb = new Uint8Array(n * n * 3);
    for (let k = 0; k < n * n; k++) this.rgb.set(base, k * 3);
    this.light = new Uint8Array(n * n);
    this.wood = new Uint8Array(n * n);
  }
  /** Pixels inside the rings (even-odd), set to colour c, light l (0..1, or keep) and wood. */
  fill(rings: Ring[], c: RGB | null, l = -1, wood = -1): void {
    const { n, s } = this;
    const sz = this.h / n;
    let zMin = Infinity;
    let zMax = -Infinity;
    for (const r of rings) for (const p of r) (zMin = Math.min(zMin, p[1])), (zMax = Math.max(zMax, p[1]));
    const j0 = Math.max(0, Math.ceil((zMin - this.z0) / sz - 0.5));
    const j1 = Math.min(n - 1, Math.floor((zMax - this.z0) / sz - 0.5));
    const xs: number[] = [];
    for (let j = j0; j <= j1; j++) {
      const z = this.z0 + (j + 0.5) * sz;
      xs.length = 0;
      for (const r of rings)
        for (let a = 0, q = r.length - 1; a < r.length; q = a++) {
          const [xa, za] = r[a];
          const [xb, zb] = r[q];
          if (za <= z !== zb <= z) xs.push(xa + ((z - za) / (zb - za)) * (xb - xa));
        }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - this.x0) / s - 0.5));
        const i1 = Math.min(n - 1, Math.floor((xs[k + 1] - this.x0) / s - 0.5));
        for (let i = i0; i <= i1; i++) {
          const p = j * n + i;
          if (c) this.rgb.set(c, p * 3);
          if (l >= 0) this.light[p] = Math.round(l * 255);
          if (wood >= 0) this.wood[p] = wood;
        }
      }
    }
  }
  /** A polyline `width` metres wide (segments as quads, round joins as octagons). */
  stroke(pts: Pt[], width: number, c: RGB, l = -1): void {
    const r = Math.max(width, this.s * 0.7) / 2;
    const oct = (x: number, z: number): Ring => Array.from({ length: 8 }, (_, k): Pt => [x + r * Math.cos((k * Math.PI) / 4), z + r * Math.sin((k * Math.PI) / 4)]);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      const nx = (-(bz - az) / len) * r;
      const nz = ((bx - ax) / len) * r;
      this.fill([[[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz]]], c, l);
      if (i > 0) this.fill([oct(ax, az)], c, l);
    }
  }
}

const N = 4096; // supersampled; the texture is 2048²
const paint = new Paint(box.x0, box.z0, box.x1 - box.x0, box.z1 - box.z0, N, hex("#9d9686"));

// Land use, biggest first so the small areas lie on top.
const LAND: Record<string, [string, number, number?]> = {
  // tag value: colour, street light, wood
  residential: ["#8f8c78", 0.12],
  commercial: ["#9b9891", 0.25],
  retail: ["#9d9891", 0.3],
  industrial: ["#8e8a82", 0.15],
  railway: ["#857c70", 0.08],
  construction: ["#a8987c", 0.05],
  brownfield: ["#a39578", 0.03],
  greenfield: ["#8c8a58", 0],
  landfill: ["#9a9078", 0],
  quarry: ["#a39f95", 0],
  farmland: ["#b0a275", 0],
  farmyard: ["#9a8f78", 0.03],
  meadow: ["#8a8a52", 0],
  grass: ["#7f8848", 0.04],
  village_green: ["#7f8848", 0.05],
  recreation_ground: ["#7c8746", 0.06],
  cemetery: ["#6e7848", 0.02],
  allotments: ["#7c854c", 0.02],
  orchard: ["#76803f", 0],
  vineyard: ["#8a8147", 0],
  plant_nursery: ["#76803f", 0],
  military: ["#8c8a76", 0.05],
  religious: ["#8f8c78", 0.08],
  education: ["#8f8d80", 0.1],
  forest: ["#5d6232", 0, 1],
  park: ["#6f7a42", 0.08],
  garden: ["#6f7a42", 0.03],
  pitch: ["#6f8c45", 0.05],
  golf_course: ["#7a944c", 0],
  stadium: ["#8a8a80", 0.15],
  track: ["#9a6a4a", 0],
  wood: ["#5d6232", 0, 1],
  scrub: ["#6f7140", 0, 2],
  grassland: ["#8a8a52", 0],
  heath: ["#86834f", 0],
  wetland: ["#5f6b45", 0],
  bare_rock: ["#9d9284", 0],
  sand: ["#c2b48f", 0],
};
const areas: { rings: Ring[]; style: [string, number, number?]; area: number }[] = [];
for (const f of landOsm) {
  const p = f.properties;
  const key = [p.landuse, p.leisure, p.natural].find((v) => v && LAND[v]);
  if (!key) continue;
  const polys = projectPolygons(f.geometry);
  if (!polys.length) continue;
  areas.push({ rings: polys.flat(), style: LAND[key], area: polys.reduce((sum, q) => sum + Math.abs(signedArea(q[0])), 0) });
}
areas.sort((p, q) => q.area - p.area);
for (const a of areas) paint.fill(a.rings, hex(a.style[0]), a.style[1], a.style[2] ?? 0);
for (const rings of waterRings) paint.fill(rings, hex("#2f3f3d"), 0, 0);
lap(`painted ${areas.length} land areas and the water`);

// Woods in autumn: canopy colours mixed by noise at a few scales.
{
  const hash = (i: number, j: number) => {
    const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const vnoise = (x: number, z: number) => {
    const i = Math.floor(x);
    const j = Math.floor(z);
    const u = x - i;
    const v = z - j;
    const a = hash(i, j);
    const bb = hash(i + 1, j);
    const c = hash(i, j + 1);
    const d = hash(i + 1, j + 1);
    const su = u * u * (3 - 2 * u);
    const sv = v * v * (3 - 2 * v);
    return (a + (bb - a) * su) * (1 - sv) + (c + (d - c) * su) * sv;
  };
  const canopy = ["#4d5a2c", "#5a6a32", "#6a6a30", "#7a6a2e", "#8a5a2a", "#6e4f2a", "#566233"].map(hex);
  const shrub = ["#6f7140", "#7a6f3a", "#646a3a"].map(hex);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const p = j * N + i;
      const w = paint.wood[p];
      if (!w) continue;
      const x = paint.x0 + (i + 0.5) * paint.s;
      const z = paint.z0 + (j + 0.5) * paint.s;
      // Crowns of about 8 m, stands of about 60 m, and broad drifts of colour.
      const n = vnoise(x / 9, z / 9) * 0.35 + vnoise(x / 60, z / 60) * 0.4 + vnoise(x / 400 + 7, z / 400) * 0.25;
      const list = w === 1 ? canopy : shrub;
      const c = list[Math.min(list.length - 1, Math.floor(n * list.length))];
      const dark = 0.82 + 0.3 * vnoise(x / 5 + 3, z / 5);
      paint.rgb.set(c.map((v) => Math.min(255, v * dark)), p * 3);
    }
  lap("woods in their autumn colours");
}

// Streets and rails, lit by class.
const ROAD: Record<string, [number, string, number]> = {
  motorway: [24, "#5b5a57", 0.9],
  trunk: [22, "#5b5a57", 0.9],
  primary: [18, "#5e5d5a", 1],
  secondary: [15, "#605f5c", 0.9],
  tertiary: [12, "#62615e", 0.8],
  unclassified: [8, "#666560", 0.5],
  residential: [8, "#686762", 0.65],
  living_street: [7, "#6c6a64", 0.55],
  pedestrian: [7, "#9b958a", 0.6],
  service: [5, "#6e6c66", 0.3],
  motorway_link: [9, "#5b5a57", 0.8],
  trunk_link: [9, "#5b5a57", 0.8],
  primary_link: [8, "#5e5d5a", 0.8],
  secondary_link: [8, "#605f5c", 0.7],
  tertiary_link: [7, "#62615e", 0.7],
};
const lines = (geom: { type: string; coordinates: unknown }): Pt[][] => {
  const proj = (cs: number[][]) =>
    cs.map(([lon, lat]): Pt => {
      const p = lonLatToLocal(lon, lat);
      return [p.x, p.z];
    });
  if (geom.type === "LineString") return [proj(geom.coordinates as number[][])];
  if (geom.type === "MultiLineString") return (geom.coordinates as number[][][]).map(proj);
  return [];
};
const ordered = roadsOsm.filter((f) => f.properties.tunnel !== "yes" && f.properties.bridge !== "yes" && f.properties.area !== "yes");
// Rails first (under the streets), then streets from the least to the most important.
const rank = (f: OsmFeature) => (f.properties.railway ? -1 : Object.keys(ROAD).length - Object.keys(ROAD).indexOf(f.properties.highway ?? ""));
ordered.sort((p, q) => rank(p) - rank(q));
for (const f of ordered) {
  const p = f.properties;
  for (const pts of lines(f.geometry)) {
    if (p.railway) {
      if (p.railway === "tram") continue;
      paint.stroke(pts, 9, hex("#7a7064"), 0.05);
      paint.stroke(pts, 4, hex("#5a524a"));
      continue;
    }
    const r = ROAD[p.highway ?? ""];
    if (!r) continue;
    if (p.highway === "service" && (p.service === "parking_aisle" || p.service === "driveway")) continue;
    paint.stroke(pts, r[0], hex(r[1]), r[2]);
  }
}
lap(`painted ${ordered.length} streets and rails`);

// Roofs: tile on houses, slate and tin on the older blocks, flat grey on the big and the new.
const roofRgb = (area: number, tall: boolean, u: number): RGB => {
  const group = tall || area > 4000 ? (u < 0.7 ? "flat" : "slate") : area > 300 ? (u < 0.6 ? "tile" : u < 0.9 ? "slate" : "flat") : u < 0.8 ? "tile" : "slate";
  const [g0, g1] = FAR_ROOF_GROUPS[group];
  return hex(FAR_ROOFS[g0 + Math.floor(((u * 7.31) % 1) * (g1 - g0))]);
};
{
  const rand = mulberry32(11);
  for (const { poly, f } of buildingPolys) {
    const area = Math.abs(signedArea(poly[0]));
    const tall = Number(f.properties["building:levels"]) > 7 || Number.parseFloat(f.properties.height ?? "") > 24;
    paint.fill([poly[0]], roofRgb(area, tall, rand()), 0.04);
  }
}
lap(`painted ${buildingPolys.length} roofs`);

/** Halves the painter into RGBA (alpha the street light). */
function halve(p: Paint): Uint8Array {
  const n = p.n / 2;
  const out = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = (j * 2) * p.n + i * 2;
      const q = [a, a + 1, a + p.n, a + p.n + 1];
      for (let c = 0; c < 3; c++) out[(j * n + i) * 4 + c] = (p.rgb[q[0] * 3 + c] + p.rgb[q[1] * 3 + c] + p.rgb[q[2] * 3 + c] + p.rgb[q[3] * 3 + c] + 2) >> 2;
      out[(j * n + i) * 4 + 3] = (p.light[q[0]] + p.light[q[1]] + p.light[q[2]] + p.light[q[3]] + 2) >> 2;
    }
  return out;
}
const groundRgba = halve(paint);
const GN = N / 2;
const groundWebp = await sharp(Buffer.from(groundRgba.buffer), { raw: { width: GN, height: GN, channels: 4 } }).webp({ quality: 86, alphaQuality: 70, effort: 5, exact: true }).toBuffer();
const groundSize = writeDataBytes("far/ground.webp", groundWebp);
lap("ground.webp");

// FAR.wide's ground: the box's inside it; beyond, woods on the hills, fields and towns on the
// flat, and the river.
const WN = 1024;
const wideRgba = new Uint8Array(WN * WN * 4);
{
  const sx = (wide.x1 - wide.x0) / WN;
  const sz = (wide.z1 - wide.z0) / WN;
  const hash = (i: number, j: number) => {
    const s = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };
  const vn = (x: number, z: number) => {
    const i = Math.floor(x);
    const j = Math.floor(z);
    const u = x - i;
    const v = z - j;
    return (hash(i, j) * (1 - u) + hash(i + 1, j) * u) * (1 - v) + (hash(i, j + 1) * (1 - u) + hash(i + 1, j + 1) * u) * v;
  };
  const woods = ["#4d5a2c", "#5a6a32", "#6a6a30", "#7a6a2e", "#6e4f2a"].map(hex);
  const fields = ["#b0a275", "#a39a6c", "#9c9a6c", "#8f9460", "#b5a77e"].map(hex);
  const town = hex("#9a9284");
  for (let j = 0; j < WN; j++)
    for (let i = 0; i < WN; i++) {
      const x = wide.x0 + (i + 0.5) * sx;
      const z = wide.z0 + (j + 0.5) * sz;
      const o = (j * WN + i) * 4;
      if (inBox(x, z)) {
        // Average the box's texels under this one.
        const bi = Math.floor(((x - box.x0) / (box.x1 - box.x0)) * GN);
        const bj = Math.floor(((z - box.z0) / (box.z1 - box.z0)) * GN);
        const r = 2;
        const acc = [0, 0, 0, 0];
        let n = 0;
        for (let dj = -r; dj <= r; dj++)
          for (let di = -r; di <= r; di++) {
            const ii = clamp(bi + di, 0, GN - 1);
            const jj = clamp(bj + dj, 0, GN - 1);
            for (let c = 0; c < 4; c++) acc[c] += groundRgba[(jj * GN + ii) * 4 + c];
            n++;
          }
        for (let c = 0; c < 4; c++) wideRgba[o + c] = acc[c] / n;
        continue;
      }
      const wi = clamp(Math.round((x - wg.x0) / WC), 0, wg.nx - 1);
      const wj = clamp(Math.round((z - wg.z0) / WC), 0, wg.nz - 1);
      const k = wj * wg.nx + wi;
      if (wideWater[k]) {
        wideRgba.set([...hex("#2f3f3d"), 0], o);
        continue;
      }
      const h = wg.data[k];
      const slope = Math.hypot(wg.data[Math.min(k + 1, wg.data.length - 1)] - wg.data[Math.max(k - 1, 0)], wg.data[Math.min(k + wg.nx, wg.data.length - 1)] - wg.data[Math.max(k - wg.nx, 0)]) / (2 * WC);
      const n1 = vn(x / 900, z / 900);
      const n2 = vn(x / 250 + 5, z / 250);
      if (h > 140 || slope > 0.09 || (h > 60 && n1 > 0.62)) {
        const c = woods[Math.floor(clamp(n2 * 0.6 + n1 * 0.4, 0, 0.999) * woods.length)];
        wideRgba.set([...c, 0], o);
      } else if (n1 < 0.3 && h < 40) {
        wideRgba.set([...town.map((v) => v * (0.9 + 0.2 * n2)), 40], o);
      } else wideRgba.set([...fields[Math.floor(clamp(n2, 0, 0.999) * fields.length)], 0], o);
    }
}
const wideWebp = await sharp(Buffer.from(wideRgba.buffer), { raw: { width: WN, height: WN, channels: 4 } }).webp({ quality: 84, alphaQuality: 60, exact: true }).toBuffer();
const wideTexSize = writeDataBytes("far/wide.webp", wideWebp);
lap("wide.webp");

// --- 4. Buildings -----------------------------------------------------------------------------------

const LEVEL = 3.3;
const SMALL = new Set(["garage", "garages", "shed", "hut", "kiosk", "carport", "service", "toilets", "cabin", "transformer_tower", "bunker", "roof"]);
const HOUSE = new Set(["house", "detached", "semidetached_house", "bungalow", "villa", "terrace", "farm", "residential"]);
const CHURCH = new Set(["church", "cathedral", "chapel"]);
const MODERN = new Set(["office", "commercial", "retail", "hospital", "university", "parking", "train_station", "transportation", "college", "school", "hotel", "apartments"]);
const INDUSTRIAL = new Set(["industrial", "warehouse", "manufacture", "hangar", "factory", "greenhouse"]);
const num = (s: string | undefined) => (s === undefined ? NaN : Number.parseFloat(s));

/** Eaves height (m) and roof of a far building. */
function farShape(p: Record<string, string | undefined>, area: number, u: number): { eave: number; pitched: boolean } {
  const t = p.building ?? "yes";
  const h = num(p.height);
  const lv = num(p["building:levels"]);
  const shape = p["roof:shape"];
  let eave: number;
  if (Number.isFinite(h) && h > 0) eave = shape && shape !== "flat" ? h - Math.min(4, h * 0.3) : h;
  else if (Number.isFinite(lv) && lv > 0) eave = lv * LEVEL + 1;
  else if (SMALL.has(t)) eave = 2.8;
  else if (HOUSE.has(t) || (t === "yes" && area < 220)) eave = area < 90 ? 3.5 + u : 5.5 + 2.5 * u;
  else if (CHURCH.has(t)) eave = 14;
  else if (INDUSTRIAL.has(t)) eave = 7 + 4 * u;
  else if (t === "apartments") eave = 12 + 9 * u;
  else eave = area > 3000 ? 9 + 6 * u : 12 + 8 * u;
  const pitched = shape ? shape !== "flat" : !INDUSTRIAL.has(t) && !MODERN.has(t) && area < 700 && eave < 14;
  return { eave: clamp(eave, 2.4, 330), pitched };
}

/** The ring counter-clockwise (x, z), cleaned of repeats and nearly straight corners, with each wall's hidden flag kept. */
function cleanRing(ring: Ring, hidden: boolean[]): { ring: Ring; hidden: boolean[] } {
  let r = ring.slice();
  let h = hidden.slice();
  if (signedArea(r) < 0) {
    // Reversed: wall i (from i to i + 1) becomes the wall from the new i to i + 1.
    const n = r.length;
    r = r.slice().reverse();
    h = Array.from({ length: n }, (_, i) => hidden[(n - 2 - i + n) % n]);
  }
  for (let changed = true; changed && r.length > 3; ) {
    changed = false;
    for (let i = 0; i < r.length && r.length > 3; i++) {
      const n = r.length;
      const a = r[(i - 1 + n) % n];
      const p = r[i];
      const c = r[(i + 1) % n];
      const ac = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const off = ac > 1e-6 ? Math.abs((c[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (c[1] - a[1])) / ac : 0;
      if (Math.hypot(p[0] - a[0], p[1] - a[1]) < 0.4 || off < 0.35) {
        // Drop p: the wall from a now runs to c, a party wall only if both parts were.
        const ia = (i - 1 + n) % n;
        h[ia] = h[ia] && h[i];
        r.splice(i, 1);
        h.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return { ring: r, hidden: h };
}

// Party walls: edges two footprints share (OSM's neighbours share their nodes).
const edgeKey = (a: Pt, c: Pt) => {
  const ka = `${Math.round(a[0] * 20)},${Math.round(a[1] * 20)}`;
  const kc = `${Math.round(c[0] * 20)},${Math.round(c[1] * 20)}`;
  return ka < kc ? `${ka}|${kc}` : `${kc}|${ka}`;
};
interface Raw {
  ring: Ring;
  eave: number;
  pitched: boolean;
  area: number;
  cx: number;
  cz: number;
  wall: number;
  roof: number;
  d: number;
}
const raws: Raw[] = [];
{
  const rand = mulberry32(7);
  const riverX = (z: number) => {
    // Buda west of the river, Pest east: the river's line through the box (Margaret Island to Csepel), roughly.
    const t = clamp((z - box.z0) / (box.z1 - box.z0), 0, 1);
    return 1200 * (1 - t) + 300 * t;
  };
  for (const { f, poly } of buildingPolys) {
    const ring = poly[0];
    const area = Math.abs(signedArea(ring));
    if (area < 20) continue;
    const [cx, cz] = centroid(ring);
    if (inWorld(cx, cz, 2) || !inBox(cx, cz)) continue;
    const u = rand();
    const { eave, pitched } = farShape(f.properties, area, u);
    const t = f.properties.building ?? "yes";
    const modern = MODERN.has(t) || eave > 26 || area > 4000;
    const wg0 = INDUSTRIAL.has(t) ? FAR_WALL_GROUPS.industrial : modern ? FAR_WALL_GROUPS.modern : cx < riverX(cz) ? FAR_WALL_GROUPS.buda : FAR_WALL_GROUPS.pest;
    const wall = wg0[0] + Math.floor(rand() * (wg0[1] - wg0[0]));
    // Pest's and Buda's old blocks are tiled or slated even where the far field draws them flat; the new and the big are flat.
    const roofGroup = CHURCH.has(t) && rand() < 0.4 ? "copper" : modern || INDUSTRIAL.has(t) ? (rand() < 0.75 ? "flat" : "slate") : rand() < 0.66 ? "tile" : "slate";
    const rg = FAR_ROOF_GROUPS[roofGroup];
    const roof = rg[0] + Math.floor(rand() * (rg[1] - rg[0]));
    raws.push({ ring, eave, pitched, area, cx, cz, wall, roof, d: toWorld(cx, cz) });
  }
}
// Near the world everything; further out only what stands out of the roofscape (the rest is in the ground's texture).
const NEAR = 6000;
const kept = raws.filter((r) => r.d < NEAR || r.eave >= 22 || r.area >= 2500);
const edges = new Map<string, { b: number; h: number }[]>();
kept.forEach((r, bi) => {
  for (let i = 0; i < r.ring.length; i++) {
    const key = edgeKey(r.ring[i], r.ring[(i + 1) % r.ring.length]);
    let list = edges.get(key);
    if (!list) edges.set(key, (list = []));
    list.push({ b: bi, h: r.eave });
  }
});
const tilesMap = new Map<string, { x: number; z: number; buildings: FarBuilding[] }>();
let hiddenWalls = 0;
let walls = 0;
let hipped = 0;
for (let bi = 0; bi < kept.length; bi++) {
  const r = kept[bi];
  const hidden = r.ring.map((p, i) => {
    const list = edges.get(edgeKey(p, r.ring[(i + 1) % r.ring.length]))!;
    // Hidden when a neighbour shares it and stands at least as tall (less 3 m).
    return list.some((o) => o.b !== bi && o.h >= r.eave - 3);
  });
  const clean = cleanRing(r.ring, hidden);
  if (clean.ring.length < 3 || clean.ring.length > 250) continue;
  // The base: the lowest ground under the walls, a little below it.
  let base = Infinity;
  for (const [x, z] of clean.ring) base = Math.min(base, ground.sample(x, z));
  base = Math.min(base, ground.sample(r.cx, r.cz)) - 1;
  // A hipped roof on small, nearly rectangular houses.
  let rise = 0;
  if (r.pitched && clean.ring.length === 4 && r.area < 450) {
    const [p0, p1, p2] = clean.ring;
    const e1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    const e2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const cos = ((p1[0] - p0[0]) * (p2[0] - p1[0]) + (p1[1] - p0[1]) * (p2[1] - p1[1])) / (e1 * e2);
    if (Math.abs(cos) < 0.2) {
      rise = clamp(Math.min(e1, e2) * 0.42, 1.5, 7);
      hipped++;
    }
  }
  const tx = Math.floor((r.cx - box.x0) / FAR_TILE);
  const tz = Math.floor((r.cz - box.z0) / FAR_TILE);
  const key = `${tx},${tz}`;
  let tile = tilesMap.get(key);
  if (!tile) tilesMap.set(key, (tile = { x: box.x0 + tx * FAR_TILE, z: box.z0 + tz * FAR_TILE, buildings: [] }));
  tile.buildings.push({ base, eave: r.eave, rise, wall: r.wall, roof: r.roof, ring: clean.ring, hidden: clean.hidden });
  walls += clean.ring.length;
  hiddenWalls += clean.hidden.filter(Boolean).length;
}
const farTiles = [...tilesMap.values()].sort((p, q) => p.z - q.z || p.x - q.x);
const buildingCount = farTiles.reduce((s, t) => s + t.buildings.length, 0);
const buildingsSize = writeDataBytes("far/buildings.bin", encodeFarBuildings(farTiles, { license: [ODBL] }));
lap(`${buildingCount} far buildings (of ${raws.length} outside the world) in ${farTiles.length} tiles; ${hipped} hipped roofs; ${hiddenWalls} of ${walls} walls party walls`);

// --- 5. Water, bridges and towers -----------------------------------------------------------------

const meshes: MeshDef[] = [];
const rectPoly = (x0: number, z0: number, x1: number, z1: number): PCPoly => [
  [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
    [x0, z0],
  ],
];
{
  // The river and lakes in the box, outside the world.
  const all: PCMulti = water.map((p) => p.map((r) => [...r, r[0]].map(([x, z]) => [x, z] as [number, number])));
  let wet = polygonClipping.union(all);
  wet = polygonClipping.intersection(wet, rectPoly(box.x0, box.z0, box.x1, box.z1));
  wet = polygonClipping.difference(wet, rectPoly(b.x0, b.z0, b.x1, b.z1));
  const pos: number[] = [];
  const idx: number[] = [];
  for (const poly of wet) {
    const flat: number[] = [];
    const holes: number[] = [];
    poly.forEach((ring, ri) => {
      if (ri > 0) holes.push(flat.length / 2);
      for (let k = 0; k < ring.length - 1; k++) flat.push(ring[k][0], ring[k][1]);
    });
    const tris = earcut(flat, holes, 2);
    const base0 = pos.length / 3;
    for (let k = 0; k < flat.length; k += 2) pos.push(flat[k], 0, flat[k + 1]);
    for (let t = 0; t < tris.length; t += 3) {
      const [a, c, d] = [tris[t], tris[t + 1], tris[t + 2]];
      const cross = (flat[c * 2] - flat[a * 2]) * (flat[d * 2 + 1] - flat[a * 2 + 1]) - (flat[c * 2 + 1] - flat[a * 2 + 1]) * (flat[d * 2] - flat[a * 2]);
      // Facing up: (x, z) clockwise seen from above has a negative cross here.
      if (cross < 0) idx.push(base0 + a, base0 + c, base0 + d);
      else idx.push(base0 + a, base0 + d, base0 + c);
    }
  }
  // The river beyond the box, cell by cell from the wide grid's water.
  for (let j = 0; j < wg.nz; j++)
    for (let i = 0; i < wg.nx; ) {
      const x = wg.x(i);
      const z = wg.z(j);
      if (!wideWater[j * wg.nx + i] || inBox(x, z)) {
        i++;
        continue;
      }
      let i1 = i;
      while (i1 + 1 < wg.nx && wideWater[j * wg.nx + i1 + 1] && !inBox(wg.x(i1 + 1), z)) i1++;
      const x0 = x - WC / 2;
      const x1 = wg.x(i1) + WC / 2;
      const base0 = pos.length / 3;
      pos.push(x0, 0, z - WC / 2, x1, 0, z - WC / 2, x1, 0, z + WC / 2, x0, 0, z + WC / 2);
      idx.push(base0, base0 + 2, base0 + 1, base0, base0 + 3, base0 + 2);
      i = i1 + 1;
    }
  const uv = new Float32Array((pos.length / 3) * 2);
  // Flow coordinates like the world's far water strips: u runs south, v east, in metres.
  for (let k = 0; k < pos.length / 3; k++) uv.set([pos[k * 3 + 2], pos[k * 3]], k * 2);
  const nor = new Float32Array(pos.length);
  for (let k = 1; k < nor.length; k += 3) nor[k] = 1;
  meshes.push({ name: "water", material: { name: "water", color: [0.06, 0.19, 0.23], roughness: 0.1 }, position: new Float32Array(pos), normal: nor, uv, index: new Uint32Array(idx) });
  lap(`water: ${idx.length / 3} triangles`);
}

/** Boxes and prisms with vertex colours, flat-shaded. */
class Solid {
  pos: number[] = [];
  col: number[] = [];
  nor: number[] = [];
  quad(a: number[], c: number[], d: number[], e: number[], rgb: RGB): void {
    const ux = c[0] - a[0];
    const uy = c[1] - a[1];
    const uz = c[2] - a[2];
    const vx = e[0] - a[0];
    const vy = e[1] - a[1];
    const vz = e[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    for (const p of [a, c, d, a, d, e]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      this.col.push(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    }
  }
  /** A prism between heights y0 and y1 over a footprint (either winding), its walls facing out, with a top. */
  prism(corners: Pt[], y0: number, y1: number, rgb: RGB, top = true): void {
    const n = corners.length;
    const ccw = signedArea(corners) > 0;
    const pts = ccw ? corners : corners.slice().reverse();
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const c = pts[(i + 1) % n];
      this.quad([a[0], y0, a[1]], [a[0], y1, a[1]], [c[0], y1, c[1]], [c[0], y0, c[1]], rgb);
    }
    if (top) for (let i = 1; i + 1 < n; i++) this.tri([pts[0][0], y1, pts[0][1]], [pts[i + 1][0], y1, pts[i + 1][1]], [pts[i][0], y1, pts[i][1]], rgb);
  }
  tri(a: number[], c: number[], d: number[], rgb: RGB): void {
    const ux = c[0] - a[0];
    const uy = c[1] - a[1];
    const uz = c[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    for (const p of [a, c, d]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      this.col.push(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    }
  }
  mesh(name: string, material: string): MeshDef {
    return { name, material: { name: material, roughness: 0.8 }, position: new Float32Array(this.pos), normal: new Float32Array(this.nor), color: new Float32Array(this.col) };
  }
}

const lamps: number[] = [];
const beacons: number[] = [];
{
  // Bridges over the water outside the world: decks on piers, ramping down to the banks.
  const solid = new Solid();
  let count = 0;
  const wetAt = (x: number, z: number) => {
    const i = Math.round((x - g.x0) / C);
    const j = Math.round((z - g.z0) / C);
    return i >= 0 && j >= 0 && i < g.nx && j < g.nz && isWater.data[j * g.nx + i] > 0;
  };
  for (const f of bridgesOsm) {
    const p = f.properties;
    if (p.bridge !== "yes" && p.bridge !== "viaduct") continue;
    if (!p.highway && !p.railway) continue;
    for (const pts0 of lines(f.geometry)) {
      // Densify to 10 m so the deck follows its ramps.
      const pts: Pt[] = [];
      for (let i = 0; i + 1 < pts0.length; i++) {
        const [ax, az] = pts0[i];
        const [bx, bz] = pts0[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 10));
        for (let k = 0; k < n; k++) pts.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
      }
      pts.push(pts0[pts0.length - 1]);
      const wet = pts.map(([x, z]) => wetAt(x, z));
      const wetLen = wet.filter(Boolean).length * 10;
      const [mx, mz] = pts[Math.floor(pts.length / 2)];
      if (wetLen < 60 || inWorld(mx, mz) || !inBox(mx, mz)) continue;
      const width = p.railway ? 11 : (({ motorway: 30, trunk: 26, primary: 22, secondary: 18 }) as Record<string, number>)[p.highway ?? ""] ?? 14;
      const ends = Math.max(ground.sample(...pts[0]), ground.sample(...pts[pts.length - 1]), 4);
      const deckOver = Math.max(ends, 9) + 2;
      // The deck: over the water at deckOver, on land at the ground, ramping at 5 % between.
      const raw = pts.map(([x, z], i) => (wet[i] ? deckOver : Math.max(ground.sample(x, z) + 1.2, 0)));
      const deck = raw.slice();
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < deck.length; i++) deck[i] = Math.max(deck[i], deck[i - 1] - 0.5);
        for (let i = deck.length - 2; i >= 0; i--) deck[i] = Math.max(deck[i], deck[i + 1] - 0.5);
      }
      const steel: RGB = p.railway ? hex("#4a4f50") : hex("#59645f");
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, az] = pts[i];
        const [bx, bz] = pts[i + 1];
        const len = Math.hypot(bx - ax, bz - az) || 1;
        const nx = (-(bz - az) / len) * (width / 2);
        const nz = ((bx - ax) / len) * (width / 2);
        const ya = deck[i];
        const yb = deck[i + 1];
        const corners = [
          [ax + nx, ya, az + nz],
          [bx + nx, yb, bz + nz],
          [bx - nx, yb, bz - nz],
          [ax - nx, ya, az - nz],
        ];
        const below = corners.map((c) => [c[0], c[1] - 2.2, c[2]]);
        // Top, sides and underside.
        solid.quad(corners[0], corners[1], corners[2], corners[3], hex("#5c5a56"));
        solid.quad(below[0], below[1], corners[1], corners[0], steel);
        solid.quad(corners[3], corners[2], below[2], below[3], steel);
        solid.quad(below[3], below[2], below[1], below[0], steel);
        // A pier every 80 m over the water.
        if (wet[i] && i % 8 === 4) {
          const ux = (bx - ax) / len;
          const uz = (bz - az) / len;
          const px = (ax + bx) / 2;
          const pz = (az + bz) / 2;
          const hw = (width / 2) * 0.85;
          const hl = 3;
          solid.prism(
            [
              [px + ux * hl + -uz * hw, pz + uz * hl + ux * hw],
              [px - ux * hl + -uz * hw, pz - uz * hl + ux * hw],
              [px - ux * hl - -uz * hw, pz - uz * hl - ux * hw],
              [px + ux * hl - -uz * hw, pz + uz * hl - ux * hw],
            ],
            -3,
            Math.min(ya, yb) - 2.2,
            hex("#8f8a80"),
            false,
          );
        }
        // Lamps along both edges, 30 m apart, 8 m up.
        if (i % 3 === 0 && !p.railway) for (const s of [1, -1]) lamps.push(ax + nx * s * 0.95, ya + 8, az + nz * s * 0.95);
      }
      count++;
    }
  }
  if (solid.pos.length) meshes.push(solid.mesh("bridges", "far bridges"));
  lap(`${count} bridges beyond the world`);
}
{
  // Towers, masts and chimneys: tapered prisms, the tall ones banded red and white.
  const solid = new Solid();
  let count = 0;
  for (const f of towersOsm) {
    const p = f.properties;
    const kind = p.man_made ?? "";
    const geo = f.geometry;
    let x: number;
    let z: number;
    if (geo.type === "Point") {
      const [lon, lat] = geo.coordinates as number[];
      ({ x, z } = lonLatToLocal(lon, lat));
    } else {
      const polys = projectPolygons(geo);
      if (!polys.length) continue;
      [x, z] = centroid(polys[0][0]);
    }
    if (inWorld(x, z) || !inBox(x, z)) continue;
    const tagged = num(p.height);
    const h = Number.isFinite(tagged) ? tagged : kind === "communications_tower" ? 120 : kind === "mast" ? 50 : kind === "chimney" ? 40 : 0;
    if (h < (kind === "chimney" || kind === "mast" || kind === "communications_tower" ? 30 : 40)) continue;
    const y0 = ground.sample(x, z) - 1;
    const r0 = kind === "mast" ? 1.4 : kind === "chimney" ? clamp(h / 22, 2, 9) : kind === "communications_tower" ? clamp(h / 18, 4, 9) : clamp(h / 12, 3, 7);
    const r1 = kind === "chimney" ? r0 * 0.6 : kind === "mast" ? 0.6 : r0 * 0.55;
    const banded = (kind === "chimney" && h >= 90) || kind === "mast" || (kind === "communications_tower" && h > 100);
    const concrete: RGB = kind === "chimney" ? hex("#a8a39a") : hex("#b8b3aa");
    const bands = banded ? 7 : 1;
    const SEG = 8;
    for (let s = 0; s < bands; s++) {
      // Only the top part of a chimney is banded.
      const t0 = banded && kind === "chimney" ? 0.55 + (0.45 * s) / bands : s / bands;
      const t1 = banded && kind === "chimney" ? 0.55 + (0.45 * (s + 1)) / bands : (s + 1) / bands;
      const ra = r0 + (r1 - r0) * t0;
      const rb = r0 + (r1 - r0) * t1;
      const rgb = banded ? (s % 2 ? hex("#e8e4dc") : hex("#c0392b")) : concrete;
      for (let k = 0; k < SEG; k++) {
        const a0 = (k / SEG) * Math.PI * 2;
        const a1 = ((k + 1) / SEG) * Math.PI * 2;
        // Counter-clockwise from above in (x, z), outward.
        solid.quad([x + Math.cos(a0) * ra, y0 + h * t0, z + Math.sin(a0) * ra], [x + Math.cos(a0) * rb, y0 + h * t1, z + Math.sin(a0) * rb], [x + Math.cos(a1) * rb, y0 + h * t1, z + Math.sin(a1) * rb], [x + Math.cos(a1) * ra, y0 + h * t0, z + Math.sin(a1) * ra], rgb);
      }
      if (banded && kind === "chimney" && s === 0) {
        // The plain shaft below the bands.
        for (let k = 0; k < SEG; k++) {
          const a0 = (k / SEG) * Math.PI * 2;
          const a1 = ((k + 1) / SEG) * Math.PI * 2;
          const rm = r0 + (r1 - r0) * 0.55;
          solid.quad([x + Math.cos(a0) * r0, y0, z + Math.sin(a0) * r0], [x + Math.cos(a0) * rm, y0 + h * 0.55, z + Math.sin(a0) * rm], [x + Math.cos(a1) * rm, y0 + h * 0.55, z + Math.sin(a1) * rm], [x + Math.cos(a1) * r0, y0, z + Math.sin(a1) * r0], concrete);
        }
      }
    }
    if (h >= 45) {
      beacons.push(x, y0 + h + 0.5, z);
      if (h >= 150) beacons.push(x, y0 + h * 0.5, z);
    }
    count++;
  }
  if (solid.pos.length) meshes.push(solid.mesh("towers", "far towers"));
  lap(`${count} towers, masts and chimneys; ${beacons.length / 3} aviation lights`);
}
const structuresSize = await writeGlb("far/structures.glb", meshes, { lamps, beacons, license: [ODBL] });

console.log(
  `far/: terrain.bin ${kb(terrainSize)} (${g.nx} × ${g.nz} at ${C} m), wide.bin ${kb(wideSize)} (${wg.nx} × ${wg.nz} at ${WC} m), ground.webp ${kb(groundSize)}, wide.webp ${kb(wideTexSize)}, buildings.bin ${kb(buildingsSize)}, structures.glb ${kb(structuresSize)}; ${((performance.now() - t0) / 1000).toFixed(0)} s`,
);

const dir = debugDir();
if (dir) {
  // Hillshades of both grids, and the ground at a quarter.
  for (const [r, name] of [
    [ground, "far-terrain"],
    [wground, "far-wide"],
  ] as const) {
    const rgb = new Uint8Array(r.nx * r.nz * 3);
    for (let j = 1; j < r.nz - 1; j++)
      for (let i = 1; i < r.nx - 1; i++) {
        const dx = r.get(i + 1, j) - r.get(i - 1, j);
        const dz = r.get(i, j + 1) - r.get(i, j - 1);
        const v = clamp(140 + ((-dx + dz) * 400) / r.cell, 0, 255);
        const hgt = clamp(r.get(i, j) / 4, 0, 90);
        rgb.set([v, clamp(v + hgt - 40, 0, 255), v], (j * r.nx + i) * 3);
      }
    writePng(`${dir}/${name}.png`, r.nx, r.nz, rgb);
  }
  const rgb = new Uint8Array(GN * GN * 3);
  for (let k = 0; k < GN * GN; k++) rgb.set(groundRgba.subarray(k * 4, k * 4 + 3), k * 3);
  await sharp(Buffer.from(rgb.buffer), { raw: { width: GN, height: GN, channels: 3 } }).resize(1024).png().toFile(`${dir}/far-ground.png`);
  console.log(`debug images in ${dir}`);
}
