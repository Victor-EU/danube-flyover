// Step 6: the city. Extrudes the OSM building footprints to their tagged height (or levels ×
// 3.3 m, or a default by building type), sits them on the terrain, colours them by district,
// and merges them into one mesh per district. Also scatters trees from OSM tree points, tree
// rows, woods and parks, and lays the small ponds.
//   public/data/city.glb    buildings (one node per district) and ponds
//   public/data/trees.json  tree positions and sizes
//   tools/out/buildings.json  footprints and roof heights for build-floor (not committed)
// The landmarks are left out: their OSM buildings (landmarks.json `osm`) and anything else
// standing where a hero model does (tools/out/heroes.json, from build-heroes), and the trees
// keep clear of them too.
// Usage: npm run build-city (after build-heroes)

import earcut from "earcut";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { TEXTURES, WORLD } from "../src/config";
import { lonLatToLocal } from "../src/geo";
import { worldBounds } from "../src/world/bounds";
import { Bridges, type BridgesJson } from "../src/world/bridges";
import { decodeGrid } from "../src/world/gridFile";
import { inPart, placeParts, type LandmarksJson } from "../src/world/landmarks";
import { River, type RiverJson } from "../src/world/river";
import { Terrain, TERRAIN_CLASS } from "../src/world/terrain";
import { centroid, hash01, mulberry32, pointInPolygon, polygonArea, projectPolygons, ringBox, round2, signedArea, simplifyRing, type Polygon, type Pt } from "./lib/geom";
import { writeGlb, type MeshDef } from "./lib/gltf";
import { kb, ODBL, readData, readDataBytes, readOsm, writeData } from "./lib/io";

/** UVs are stored in units of this many metres, so they quantise into [0, 1]. */
const UV_UNIT = 1024;
const LEVEL = 3.3;

const b = worldBounds();
const river = new River(readData<RiverJson>("river.json"));
const terrain = new Terrain(decodeGrid(readDataBytes("terrain.bin")));
const bridges = new Bridges(readData<BridgesJson>("bridges.json"), river, terrain, false);
const landmarks = readData<LandmarksJson>("landmarks.json").landmarks;
const heroParts = landmarks.flatMap((l) => placeParts(l, (x, z) => terrain.heightAt(x, z)));
const heroIds = new Set(landmarks.flatMap((l) => l.osm ?? []));
// The floor cells the hero models stand on (build-heroes).
const heroOut = JSON.parse(readFileSync(new URL("./out/heroes.json", import.meta.url), "utf8")) as { cell: number; nx: number; heroes: Record<string, { cells: number[] }> };
const heroCells = new Set<number>();
for (const h of Object.values(heroOut.heroes)) for (let k = 0; k < h.cells.length; k += 3) heroCells.add(h.cells[k + 1] * heroOut.nx + h.cells[k]);
/** True if (x, z) is in a cell a hero stands on, or within `margin` cells of one. */
const onHero = (x: number, z: number, margin = 0) => {
  const i = Math.floor((x - b.x0) / heroOut.cell);
  const j = Math.floor((z - b.z0) / heroOut.cell);
  for (let dj = -margin; dj <= margin; dj++) for (let di = -margin; di <= margin; di++) if (heroCells.has((j + dj) * heroOut.nx + i + di)) return true;
  return false;
};
const inBounds = (x: number, z: number, m = 0) => x > b.x0 + m && x < b.x1 - m && z > b.z0 + m && z < b.z1 - m;

// --- Districts ------------------------------------------------------------------------------

const districts = readOsm("districts")
  .filter((f) => f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
  .map((f) => ({ name: f.properties.name ?? f.properties.id, polys: projectPolygons(f.geometry) }));
const districtOf = (x: number, z: number) => districts.find((d) => d.polys.some((p) => pointInPolygon(p, x, z)))?.name ?? "other";
// Buda is everything west of the river; its districts get the Buda palette.
const BUDA = new Set(["I. kerület", "II. kerület", "III. kerület", "XI. kerület", "XII. kerület"]);

// --- Heights ----------------------------------------------------------------------------------

const num = (v: string | undefined) => {
  if (!v) return NaN;
  const m = /^\s*([0-9]+(?:[.,][0-9]+)?)\s*(m|ft|')?\s*$/.exec(v);
  if (!m) return NaN;
  const n = Number(m[1].replace(",", "."));
  return m[2] === "ft" || m[2] === "'" ? n * 0.3048 : n;
};
const SMALL = new Set(["garage", "garages", "shed", "hut", "kiosk", "carport", "service", "toilets", "cabin", "transformer_tower", "bunker"]);
const HOUSE = new Set(["house", "detached", "semidetached_house", "bungalow", "villa", "terrace"]);
function heightOf(p: Record<string, string | undefined>): { h: number; source: "height" | "levels" | "default" } {
  const h = num(p.height);
  if (Number.isFinite(h) && h > 0) return { h, source: "height" };
  const lv = num(p["building:levels"]);
  if (Number.isFinite(lv) && lv > 0) {
    const roof = num(p["roof:levels"]);
    return { h: lv * LEVEL + (Number.isFinite(roof) ? roof * 2 : 0) + 1, source: "levels" };
  }
  const t = p.building ?? "yes";
  if (SMALL.has(t)) return { h: 3.5, source: "default" };
  if (HOUSE.has(t)) return { h: 8, source: "default" };
  if (t === "ruins") return { h: 4, source: "default" };
  if (t === "church" || t === "cathedral" || t === "chapel") return { h: 20, source: "default" };
  if (t === "industrial" || t === "warehouse") return { h: 10, source: "default" };
  return { h: 18, source: "default" }; // the design doc's default
}

// --- Palettes ---------------------------------------------------------------------------------

const hex = (s: string): [number, number, number] => [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];
const WALLS = {
  pest: ["#d9c9a8", "#cdb48c", "#e0d4b8", "#c8a984", "#d4bfa0", "#bfa98a", "#d8bf98", "#c9b79c"].map(hex),
  buda: ["#d8cdb5", "#c9b99c", "#bfae8f", "#d1c4a6", "#ddd3bf", "#cfc0a2"].map(hex),
  castle: ["#e2d8c2", "#d5c7a6", "#cbbd9d", "#e6dcc8"].map(hex),
  modern: ["#b8b5ae", "#a9aaa6", "#c2bfb7", "#b3aea4"].map(hex),
};
const ROOFS = {
  tile: ["#9a5b45", "#8c4f3d", "#a86a4f", "#94604b"].map(hex),
  slate: ["#5d5f63", "#6b6d70", "#545a60"].map(hex),
  copper: ["#6f9384", "#7a9d8c"].map(hex),
  flat: ["#9c9a94", "#8f8d88", "#a5a29b"].map(hex),
};
const MODERN = new Set(["office", "commercial", "retail", "industrial", "warehouse", "hospital", "university", "parking", "train_station", "transportation", "service", "garages"]);
const pick = <T>(list: T[], u: number) => list[Math.min(list.length - 1, Math.floor(u * list.length))];

// --- Buildings --------------------------------------------------------------------------------

interface Building {
  id: string;
  district: string;
  poly: Polygon;
  base: number;
  top: number;
  wall: [number, number, number];
  roof: [number, number, number];
  /** Layers in the runtime's surface array: TEXTURES.facades, then TEXTURES.roofs. */
  facade: number;
  roofLayer: number;
  seed: number;
}

// --- Facade styles ------------------------------------------------------------------------------

const F = Object.fromEntries(TEXTURES.facades.map((name, i) => [name, i])) as Record<string, number>;
const ROOF_LAYER = { tile: 8, slate: 9, copper: 10, flat: 11 };
const PANEL_DISTRICTS = new Set(["III. kerület", "XIII. kerület", "XI. kerület"]);
/** Which of the eight facade tiles a building wears, by type, district, height and bank. */
function facadeOf(type: string, district: string, height: number, castle: boolean, u: number): number {
  if (MODERN.has(type) || height > 32) return F.modern;
  if (SMALL.has(type) || HOUSE.has(type)) return F.villa;
  if (castle) return F.castle;
  if (PANEL_DISTRICTS.has(district) && height >= 18 && (type === "apartments" || type === "residential" || type === "yes") && u < 0.4) return F.panel;
  if (BUDA.has(district)) return height < 14 ? F.budaBaroque : u < 0.7 ? F.pestEclectic : F.pestClassic;
  if (height < 9) return F.villa;
  if (u < 0.16) return F.secession;
  return district === "V. kerület" ? (u < 0.6 ? F.pestClassic : F.pestEclectic) : u < 0.3 ? F.pestClassic : F.pestEclectic;
}

const buildings: Building[] = [];
const skipped: Record<string, number> = {};
const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
const sources = { height: 0, levels: 0, default: 0 };

for (const f of readOsm("buildings")) {
  const p = f.properties;
  if (heroIds.has(p.id)) {
    skip("hero landmark");
    continue;
  }
  if (p.building === "roof" || (p.building === "construction" && !p["building:levels"])) {
    skip(p.building === "roof" ? "canopy (building=roof)" : "construction site");
    continue;
  }
  const { h, source } = heightOf(p);
  projectPolygons(f.geometry).forEach((poly0, k) => {
    const poly: Polygon = poly0.map((r) => simplifyRing(r, 0.3)).filter((r) => r.length >= 3);
    if (!poly.length || poly[0].length < 3) return skip("degenerate");
    if (polygonArea(poly) < 8) return skip("tiny");
    const [cx, cz] = centroid(poly[0]);
    if (!inBounds(cx, cz, 2)) return skip("outside the world");
    if (river.isWater(cx, cz)) return skip("on the water");
    if (bridges.onFootprint(cx, cz, 2)) return skip("on a bridge");
    if (onHero(cx, cz) || heroParts.some((hp) => inPart(hp, cx, cz, 4))) return skip("under a hero landmark");
    // Consistent winding: outer ring positive area, holes negative.
    if (signedArea(poly[0]) < 0) poly[0].reverse();
    for (let i = 1; i < poly.length; i++) if (signedArea(poly[i]) > 0) poly[i].reverse();

    let gMin = Infinity;
    let gSum = 0;
    for (const [x, z] of poly[0]) {
      const g = terrain.heightAt(x, z);
      gMin = Math.min(gMin, g);
      gSum += g;
    }
    const gAvg = Math.max(gSum / poly[0].length, WORLD.landBase);
    const height = Math.min(Math.max(h, 2.5), 120);
    const district = districtOf(cx, cz);
    const seed = hash01(`${p.id}#${k}`);
    const u = hash01(`${p.id}#${k}:colour`);
    const ur = hash01(`${p.id}#${k}:roof`);
    const type = p.building ?? "yes";
    const castle = district === "I. kerület" && gAvg > 45;
    const walls = MODERN.has(type) ? WALLS.modern : castle ? WALLS.castle : BUDA.has(district) ? WALLS.buda : WALLS.pest;
    let roofKind: keyof typeof ROOFS;
    if (type === "church" || type === "cathedral" || type === "chapel") roofKind = ur < 0.5 ? "slate" : "copper";
    else if (MODERN.has(type) || height > 32) roofKind = "flat";
    else roofKind = ur < 0.5 ? "tile" : ur < 0.85 ? "slate" : "flat";
    const roofs = ROOFS[roofKind];
    buildings.push({
      id: `${p.id}${k ? `#${k}` : ""}`,
      district,
      poly,
      base: gMin - 0.5,
      top: gAvg + height,
      wall: pick(walls, u),
      roof: pick(roofs, hash01(`${p.id}#${k}:roofshade`)),
      facade: facadeOf(type, district, height, castle, hash01(`${p.id}#${k}:facade`)),
      roofLayer: ROOF_LAYER[roofKind],
      seed,
    });
    sources[source]++;
  });
}

// --- Meshes per district ------------------------------------------------------------------------

class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  seed: number[] = [];
  facade: number[] = [];
  idx: number[] = [];
  /** `layer` is the surface-array layer; `h` the building's wall height (for the cornice). */
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: number[], u: number, v: number, s: number, layer: number, h: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(c[0], c[1], c[2]);
    this.uv.push(u / UV_UNIT, v / UV_UNIT);
    this.seed.push(s);
    this.facade.push(layer / FACADE_LAYER_UNIT, h / FACADE_HEIGHT_UNIT);
    return this.pos.length / 3 - 1;
  }
}

/** _FACADE stores (layer / 16, wall height / 128 m), so it quantises into [0, 1]. */
const FACADE_LAYER_UNIT = 16;
const FACADE_HEIGHT_UNIT = 128;
const perDistrict = new Map<string, MeshBuilder>();
for (const bd of buildings) {
  let m = perDistrict.get(bd.district);
  if (!m) perDistrict.set(bd.district, (m = new MeshBuilder()));
  const { base, top, seed } = bd;
  const h = top - base;
  // Walls: a quad per edge with its own normal (flat shading), u along the perimeter.
  for (const ring of bd.poly) {
    let along = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const c = ring[(i + 1) % ring.length];
      const ex = c[0] - a[0];
      const ez = c[1] - a[1];
      const l = Math.hypot(ex, ez);
      if (l < 0.05) continue;
      const nx = ez / l;
      const nz = -ex / l;
      // The runtime shades the foot of the wall (ambient occlusion) from v, the height above the base.
      const A = m.vertex(a[0], base, a[1], nx, 0, nz, bd.wall, along, 0, seed, bd.facade, h);
      const B = m.vertex(c[0], base, c[1], nx, 0, nz, bd.wall, along + l, 0, seed, bd.facade, h);
      const C = m.vertex(c[0], top, c[1], nx, 0, nz, bd.wall, along + l, h, seed, bd.facade, h);
      const D = m.vertex(a[0], top, a[1], nx, 0, nz, bd.wall, along, h, seed, bd.facade, h);
      m.idx.push(A, C, B, A, D, C);
      along += l;
    }
  }
  // Roof: the footprint with its courtyards, flat, UVs in metres around the centroid.
  const flat: number[] = [];
  const holes: number[] = [];
  bd.poly.forEach((r, k) => {
    if (k > 0) holes.push(flat.length / 2);
    for (const p of r) flat.push(p[0], p[1]);
  });
  const tris = earcut(flat, holes, 2);
  const [cx, cz] = centroid(bd.poly[0]);
  const first = m.pos.length / 3;
  for (let i = 0; i < flat.length; i += 2) m.vertex(flat[i], top, flat[i + 1], 0, 1, 0, bd.roof, flat[i] - cx + UV_UNIT / 2, flat[i + 1] - cz + UV_UNIT / 2, seed, bd.roofLayer, h);
  for (let t = 0; t < tris.length; t += 3) {
    const [a, c, d] = [tris[t], tris[t + 1], tris[t + 2]];
    const cross = (flat[c * 2] - flat[a * 2]) * (flat[d * 2 + 1] - flat[a * 2 + 1]) - (flat[c * 2 + 1] - flat[a * 2 + 1]) * (flat[d * 2] - flat[a * 2]);
    if (cross < 0) m.idx.push(first + a, first + c, first + d);
    else m.idx.push(first + a, first + d, first + c);
  }
}

const meshes: MeshDef[] = [];
let tris = 0;
for (const [name, m] of [...perDistrict.entries()].sort((p, q) => p[0].localeCompare(q[0]))) {
  tris += m.idx.length / 3;
  meshes.push({
    name: `buildings ${name}`,
    material: { name: "building", roughness: 0.9 },
    position: new Float32Array(m.pos),
    normal: new Float32Array(m.nor),
    color: new Float32Array(m.col),
    uv: new Float32Array(m.uv),
    index: new Uint32Array(m.idx),
    extra: { _SEED: { array: new Float32Array(m.seed), size: 1 }, _FACADE: { array: new Float32Array(m.facade), size: 2 } },
    extras: { district: name, buildings: buildings.filter((x) => x.district === name).length },
  });
}

// --- Ponds --------------------------------------------------------------------------------------

{
  const pos: number[] = [];
  const idx: number[] = [];
  let count = 0;
  for (const f of readOsm("water")) {
    if (f.properties.water === "river" || f.properties.waterway) continue;
    for (const poly0 of projectPolygons(f.geometry)) {
      const poly = poly0.map((r) => simplifyRing(r, 0.5)).filter((r) => r.length >= 3);
      if (!poly.length) continue;
      const [cx, cz] = centroid(poly[0]);
      if (!inBounds(cx, cz, 5) || river.isWater(cx, cz) || polygonArea(poly) < 30) continue;
      // Level with the lowest point of the rim, with a skirt down to hide any gap under it.
      const y = Math.min(...poly[0].map(([x, z]) => terrain.heightAt(x, z))) + 0.15;
      const flat: number[] = [];
      const holes: number[] = [];
      poly.forEach((r, k) => {
        if (k > 0) holes.push(flat.length / 2);
        for (const p of r) flat.push(p[0], p[1]);
      });
      const t = earcut(flat, holes, 2);
      const first = pos.length / 3;
      for (let i = 0; i < flat.length; i += 2) pos.push(flat[i], y, flat[i + 1]);
      for (let k = 0; k < t.length; k += 3) {
        const [a, c, d] = [t[k], t[k + 1], t[k + 2]];
        const cross = (flat[c * 2] - flat[a * 2]) * (flat[d * 2 + 1] - flat[a * 2 + 1]) - (flat[c * 2 + 1] - flat[a * 2 + 1]) * (flat[d * 2] - flat[a * 2]);
        if (cross < 0) idx.push(first + a, first + c, first + d);
        else idx.push(first + a, first + d, first + c);
      }
      count++;
    }
  }
  const nor = new Float32Array(pos.length);
  for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  meshes.push({ name: "ponds", material: { name: "water", color: [0.231, 0.463, 0.502], roughness: 0.55 }, position: new Float32Array(pos), normal: nor, index: new Uint32Array(idx), extras: { ponds: count } });
}

const glb = await writeGlb("city.glb", meshes, { license: ODBL, uvUnit: UV_UNIT, facadeLayerUnit: FACADE_LAYER_UNIT, facadeHeightUnit: FACADE_HEIGHT_UNIT });

// --- Trees ----------------------------------------------------------------------------------------

const rand = mulberry32(1873);
const trees: number[] = [];
const footprints = new Map<number, Building[]>();
const CELL = 50;
for (const bd of buildings) {
  const bx = ringBox(bd.poly[0]);
  for (let i = Math.floor(bx.minX / CELL); i <= Math.floor(bx.maxX / CELL); i++)
    for (let j = Math.floor(bx.minZ / CELL); j <= Math.floor(bx.maxZ / CELL); j++) {
      const key = i * 100003 + j;
      if (!footprints.has(key)) footprints.set(key, []);
      footprints.get(key)!.push(bd);
    }
}
const nearBuilding = (x: number, z: number) => {
  for (const bd of footprints.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL)) ?? []) {
    if (pointInPolygon(bd.poly, x, z)) return true;
    for (const [px, pz] of bd.poly[0]) if (Math.hypot(px - x, pz - z) < 3) return true;
  }
  return false;
};
const treeOk = (x: number, z: number) => {
  if (!inBounds(x, z, 3) || river.isWater(x, z)) return false;
  if (river.nearestBank(x, z, WORLD.quayWidth + 2)) return false; // the quays stay clear
  const c = terrain.classAt(x, z);
  if (c === TERRAIN_CLASS.pitch || c === TERRAIN_CLASS.square || c === TERRAIN_CLASS.bed) return false;
  if (bridges.onFootprint(x, z, 4)) return false;
  if (onHero(x, z, 1) || heroParts.some((hp) => inPart(hp, x, z, 6))) return false;
  return !nearBuilding(x, z);
};
const addTree = (x: number, z: number, s: number) => {
  if (treeOk(x, z)) trees.push(round2(x * 10) / 10, round2(z * 10) / 10, Math.round(s * 100) / 100);
};
let fromOsm = 0;
for (const f of readOsm("trees")) {
  if (f.geometry.type === "Point") {
    const [lon, lat] = f.geometry.coordinates as number[];
    const { x, z } = lonLatToLocal(lon, lat);
    const h = num(f.properties.height);
    addTree(x, z, Number.isFinite(h) ? Math.min(1.6, Math.max(0.5, h / 12)) : 0.75 + rand() * 0.5);
    fromOsm++;
  } else if (f.geometry.type === "LineString") {
    const line = projectPolygons({ type: "Polygon", coordinates: [f.geometry.coordinates as number[][]] })[0][0];
    for (let i = 0; i < line.length - 1; i++) {
      const l = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
      for (let d = 0; d < l; d += 8) addTree(line[i][0] + ((line[i + 1][0] - line[i][0]) * d) / l, line[i][1] + ((line[i + 1][1] - line[i][1]) * d) / l, 0.8 + rand() * 0.4);
    }
  }
}
const scatter = (poly: Polygon, spacing: number, keep: number) => {
  const bx = ringBox(poly[0]);
  for (let z = Math.ceil(bx.minZ / spacing) * spacing; z < bx.maxZ; z += spacing)
    for (let x = Math.ceil(bx.minX / spacing) * spacing; x < bx.maxX; x += spacing) {
      // Anywhere in the cell, so no rows show.
      const px = x + (rand() - 0.5) * spacing;
      const pz = z + (rand() - 0.5) * spacing;
      if (rand() > keep || !pointInPolygon(poly, px, pz)) continue;
      addTree(px, pz, 0.8 + rand() * 0.6);
    }
};
for (const f of readOsm("landcover")) {
  const p = f.properties;
  const wood = p.landuse === "forest" || p.natural === "wood";
  const scrub = p.natural === "scrub";
  const park = p.leisure === "park" || p.leisure === "garden" || p.landuse === "cemetery";
  if (!wood && !scrub && !park) continue;
  for (const poly of projectPolygons(f.geometry)) {
    if (wood) scatter(poly, 11, 0.9);
    else if (scrub) scatter(poly, 14, 0.6);
    else scatter(poly, 17, 0.5);
  }
}
const treeCount = trees.length / 3;
const treesSize = writeData("trees.json", { license: ODBL, note: "Flat [x, z, scale, ...] in local metres; y comes from the terrain.", trees });

// --- Footprints for build-floor -------------------------------------------------------------------

mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("./out/buildings.json", import.meta.url),
  JSON.stringify(buildings.map((bd) => ({ top: round2(bd.top), ring: bd.poly[0].flatMap((p: Pt) => [round2(p[0]), round2(p[1])]) }))),
);

console.log(`buildings: ${buildings.length} (height tag ${sources.height}, levels ${sources.levels}, default ${sources.default}); skipped ${JSON.stringify(skipped)}`);
console.log(`districts: ${[...perDistrict.keys()].join(", ")}`);
const styleCount = TEXTURES.facades.map((name, i) => `${name} ${buildings.filter((x) => x.facade === i).length}`);
console.log(`facades: ${styleCount.join(", ")}`);
console.log(`city.glb ${kb(glb)}, ${tris} building triangles`);
console.log(`trees.json ${kb(treesSize)}: ${treeCount} trees (${fromOsm} OSM tree points before filtering)`);
