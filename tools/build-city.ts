// Step 6: the city. Extrudes the OSM building footprints to their eaves (from the tagged
// height, or levels × 3.3 m, or a default by building type), sits them on the terrain, colours
// them by district, and roofs them: touching buildings merge into blocks whose straight
// skeletons give pitched, hipped and mansard roofs running across the party walls
// (tools/lib/roofs.ts), with blank firewalls where a wall rises above its neighbour, cornices
// along the streets and courtyards, chimneys near the ridges, and parapets and rooftop units
// on the flat roofs, and occlusion baked into the walls from what faces them across the
// street. One mesh per 320 m tile; the chimneys and rooftop units go to roofbits.bin, which
// the runtime instances and draws only near the camera. Also scatters trees from OSM tree points, tree
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
import { TEXTURES, TREE_SPECIES, TREE_SPECIES_INDEX, type TreeSpecies, WORLD } from "../src/config";
import { lonLatToLocal } from "../src/geo";
import { worldBounds } from "../src/world/bounds";
import { Bridges, type BridgesJson } from "../src/world/bridges";
import { decodeGrid } from "../src/world/gridFile";
import { inPart, placeParts, type LandmarksJson } from "../src/world/landmarks";
import { River, type RiverJson } from "../src/world/river";
import { Terrain, TERRAIN_CLASS } from "../src/world/terrain";
import { centroid, hash01, minAreaRect, mulberry32, pointInPolygon, pointInRing, polygonArea, projectPolygons, ringBox, round2, signedArea, simplifyRing, type Polygon, type Pt } from "./lib/geom";
import { BUDA, CANYON_OPEN, CANYON_UNIT, canyonProbe, districtLookup, facadeOf, LAYER_FIREWALL, LAYER_TRIM, loadDistricts, MODERN, num, OPEN, pick, profileFor, ROOF_LAYER, roofCovering, ROOFS, shapeOf, TRIM, WALLS, type RoofKind } from "./lib/cityStyle";
import { blockPieces, buildBlocks, clipPieces, initSkeleton, pieceHeight, roofHeightAt, type Profile } from "./lib/roofs";
import { writeGlb, type MeshDef } from "./lib/gltf";
import { kb, ODBL, readData, readDataBytes, readOsm, writeData, writeDataBytes } from "./lib/io";

/** UVs are stored in units of this many metres, so they quantise into [0, 1]. */
const UV_UNIT = 1024;

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

const districtOf = districtLookup(loadDistricts());

// --- Buildings --------------------------------------------------------------------------------

interface Building {
  id: string;
  district: string;
  poly: Polygon;
  area: number;
  base: number;
  /** World y of the eaves (the walls' top) and the roof's highest point. */
  eave: number;
  top: number;
  kind: RoofKind;
  roofLevels: number;
  wall: [number, number, number];
  roof: [number, number, number];
  /** Layers in the runtime's surface array: TEXTURES.facades, then TEXTURES.roofs. */
  facade: number;
  roofLayer: number;
  seed: number;
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
  projectPolygons(f.geometry).forEach((poly0, k) => {
    const poly: Polygon = poly0.map((r) => simplifyRing(r, 0.3)).filter((r) => r.length >= 3);
    if (!poly.length || poly[0].length < 3) return skip("degenerate");
    const area = polygonArea(poly);
    if (area < 8) return skip("tiny");
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
    const district = districtOf(cx, cz);
    const seed = hash01(`${p.id}#${k}`);
    const u = hash01(`${p.id}#${k}:colour`);
    const ur = hash01(`${p.id}#${k}:roof`);
    const type = p.building ?? "yes";
    const shape = shapeOf(p, area, hash01(`${p.id}#${k}:height`));
    const castle = district === "I. kerület" && gAvg > 45;
    const walls = MODERN.has(type) ? WALLS.modern : castle ? WALLS.castle : BUDA.has(district) ? WALLS.buda : WALLS.pest;
    const roofKind = roofCovering(shape.kind, BUDA.has(district), ur);
    buildings.push({
      id: `${p.id}${k ? `#${k}` : ""}`,
      district,
      poly,
      area,
      base: gMin - 0.5,
      eave: gAvg + shape.eave,
      top: gAvg + shape.eave,
      kind: shape.kind,
      roofLevels: shape.roofLevels,
      wall: pick(walls, u),
      roof: pick(ROOFS[roofKind], hash01(`${p.id}#${k}:roofshade`)),
      facade: facadeOf(type, district, shape.eave, castle, hash01(`${p.id}#${k}:facade`)),
      roofLayer: ROOF_LAYER[roofKind],
      seed,
    });
    sources[shape.source]++;
  });
}

// --- Roofs: blocks and their skeletons ------------------------------------------------------------

await initSkeleton();
const tBlocks = performance.now();
const { blocks, blockOf, failed: failedBlocks } = await buildBlocks(buildings.map((bd) => bd.poly));
console.log(`blocks: ${blocks.length} (${failedBlocks} without a skeleton) in ${((performance.now() - tBlocks) / 1000).toFixed(1)} s`);
function profileOf(bd: Building, block: number): Profile | null {
  return block < 0 ? null : profileFor(bd.kind, bd.eave - bd.base, bd.roofLevels, `block${block}`);
}

// --- Meshes per district ------------------------------------------------------------------------

class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  seed: number[] = [];
  facade: number[] = [];
  canyon: number[] = [];
  idx: number[] = [];
  /** What faces the next vertices across the street: [distance, its top above this wall's base]. */
  facing: [number, number] = [CANYON_OPEN, 0];
  /** `layer` is the surface-array layer; `h` the building's wall height (for the cornice). */
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: number[], u: number, v: number, s: number, layer: number, h: number): number {
    this.canyon.push(Math.min(1, this.facing[0] / CANYON_UNIT), Math.min(1, Math.max(0, this.facing[1]) / CANYON_UNIT));
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(c[0], c[1], c[2]);
    this.uv.push(u / UV_UNIT, v / UV_UNIT);
    this.seed.push(s);
    this.facade.push(layer / FACADE_LAYER_UNIT, h / FACADE_HEIGHT_UNIT);
    return this.pos.length / 3 - 1;
  }
  /** A quad a, b, c, d (in order round its edge) with one normal, wound to face along it. */
  quad(p: number[][], n: number[], c: number[], uvs: number[][], s: number, layer: number, h: number): void {
    const i = p.map((q, k) => this.vertex(q[0], q[1], q[2], n[0], n[1], n[2], c, uvs[k][0], uvs[k][1], s, layer, h));
    this.facets(i, p, n);
  }
  /** Two triangles over the quad of vertices `i` (at `p`), wound so their front faces along `n`. */
  facets(i: number[], p: number[][], n: number[]): void {
    // The diagonals' cross product is the quad's area vector, even with one corner collapsed.
    const u = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const v = [p[3][0] - p[1][0], p[3][1] - p[1][1], p[3][2] - p[1][2]];
    const along = (u[1] * v[2] - u[2] * v[1]) * n[0] + (u[2] * v[0] - u[0] * v[2]) * n[1] + (u[0] * v[1] - u[1] * v[0]) * n[2];
    if (along >= 0) this.idx.push(i[0], i[1], i[2], i[0], i[2], i[3]);
    else this.idx.push(i[0], i[2], i[1], i[0], i[3], i[2]);
  }
}

/** Triangulates a polygon in x-z and emits it facing up, with heights and UVs from callbacks. */
function emitFlat(m: MeshBuilder, poly: Polygon, y: (x: number, z: number) => number, n: number[], uv: (x: number, z: number) => [number, number], c: number[], s: number, layer: number, h: number): void {
  const flat: number[] = [];
  const holes: number[] = [];
  poly.forEach((r, k) => {
    if (k > 0) holes.push(flat.length / 2);
    for (const p of r) flat.push(p[0], p[1]);
  });
  const tris = earcut(flat, holes, 2);
  const first = m.pos.length / 3;
  for (let i = 0; i < flat.length; i += 2) {
    const [u, v] = uv(flat[i], flat[i + 1]);
    m.vertex(flat[i], y(flat[i], flat[i + 1]), flat[i + 1], n[0], n[1], n[2], c, u, v, s, layer, h);
  }
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b2, d] = [tris[t], tris[t + 1], tris[t + 2]];
    const cross = (flat[b2 * 2] - flat[a * 2]) * (flat[d * 2 + 1] - flat[a * 2 + 1]) - (flat[b2 * 2 + 1] - flat[a * 2 + 1]) * (flat[d * 2] - flat[a * 2]);
    if (cross < 0) m.idx.push(first + a, first + b2, first + d);
    else m.idx.push(first + a, first + d, first + b2);
  }
}

const facing = canyonProbe(buildings);

/** _FACADE stores (layer / 16, wall height / 128 m), so it quantises into [0, 1]. */
const FACADE_LAYER_UNIT = 16;
const FACADE_HEIGHT_UNIT = 128;
const CORNICE = { out: 0.42, drop: 0.62, fascia: 0.3 };
const PARAPET = 0.9;
/** Buildings go into tiles, for culling; each tile's chimneys and rooftop units into a second mesh the runtime draws only near the camera. */
const TILE = 320;
const perTile = new Map<string, { main: MeshBuilder; buildings: number }>();
/** Chimneys and rooftop units, instanced at runtime: [x, z, y0, y1, ax, az, halfU, halfV, r, g, b, kind] each. */
const bits: number[] = [];
const bit = (x: number, z: number, y0: number, y1: number, ax: number, az: number, hu: number, hv: number, c: number[], kind: 0 | 1) => bits.push(x, z, y0, y1, ax, az, hu, hv, c[0], c[1], c[2], kind);
const stats = { pitched: 0, mansard: 0, steep: 0, flat: 0, fallback: 0, chimneys: 0, firewalls: 0, units: 0 };
const roofRand = mulberry32(4711);
const tRoofs = performance.now();
buildings.forEach((bd, bi) => {
  if (bi % 1000 === 0 && process.env.PROGRESS) console.log(`  ${bi} buildings, ${((performance.now() - tRoofs) / 1000).toFixed(1)} s`);
  const [tcx, tcz] = centroid(bd.poly[0]);
  const tileKey = `${Math.floor((tcx - b.x0) / TILE)}_${Math.floor((tcz - b.z0) / TILE)}`;
  let tile = perTile.get(tileKey);
  if (!tile) perTile.set(tileKey, (tile = { main: new MeshBuilder(), buildings: 0 }));
  tile.buildings++;
  const m = tile.main;
  const { base, eave, seed } = bd;
  const wallH = eave - base;
  const blockIndex = blockOf[bi];
  const block = blockIndex >= 0 ? blocks[blockIndex] : null;
  const profile = profileOf(bd, blockIndex);
  const pieces = block && profile ? blockPieces(block, profile) : null;
  const flatRoof = !pieces;
  if (flatRoof && bd.kind !== "flat") stats.fallback++;
  stats[flatRoof ? "flat" : bd.kind]++;
  const [cx, cz] = centroid(bd.poly[0]);
  /** Inside the block (another building's side of a party wall), probed just past an edge. */
  const inBlock = (x: number, z: number) => !!block && pointInPolygon(block.outline, x, z);
  let ridge = flatRoof ? PARAPET : 0;

  for (const ring of bd.poly) {
    let along = 0;
    const n = ring.length;
    // Each edge: its outward normal, and whether it faces the street (or a courtyard) or a neighbour.
    const edges = ring.map((a, i) => {
      const c = ring[(i + 1) % n];
      const ex = c[0] - a[0];
      const ez = c[1] - a[1];
      const l = Math.hypot(ex, ez);
      const nx = l > 0 ? ez / l : 0;
      const nz = l > 0 ? -ex / l : 0;
      const mx = (a[0] + c[0]) / 2;
      const mz = (a[1] + c[1]) / 2;
      const party = l > 0.05 && inBlock(mx + nx * 0.35, mz + nz * 0.35);
      return { a, c, l, nx, nz, party };
    });
    edges.forEach((e) => {
      if (e.l < 0.05) return;
      const { a, c, nx, nz, l } = e;
      // Walls: a quad per edge with its own normal (flat shading), u along the perimeter. A
      // party wall is a blank firewall where it rises above its neighbour.
      const layer = e.party ? LAYER_FIREWALL : bd.facade;
      // Each end of a street wall looks across at whatever faces it, for the baked occlusion.
      const inset = Math.min(1, l / 3);
      const fa = e.party ? OPEN : facing(a[0] + ((c[0] - a[0]) / l) * inset, a[1] + ((c[1] - a[1]) / l) * inset, nx, nz, bi, base);
      const fc = e.party ? OPEN : facing(c[0] - ((c[0] - a[0]) / l) * inset, c[1] - ((c[1] - a[1]) / l) * inset, nx, nz, bi, base);
      const w = [[a[0], base, a[1]], [c[0], base, c[1]], [c[0], eave, c[1]], [a[0], eave, a[1]]];
      const wuv = [[along, 0], [along + l, 0], [along + l, wallH], [along, wallH]];
      const vi = w.map((q, k) => {
        m.facing = k === 0 || k === 3 ? fa : fc;
        return m.vertex(q[0], q[1], q[2], nx, 0, nz, bd.wall, wuv[k][0], wuv[k][1], seed, layer, wallH);
      });
      m.facing = OPEN;
      m.facets(vi, w, [nx, 0, nz]);
      if (e.party && pieces) {
        // The gable: the wall carried up to the roof's section along the party edge.
        const steps = Math.max(1, Math.ceil(l / 0.75));
        let prev: [number, number, number] | null = null;
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const x = a[0] + (c[0] - a[0]) * t;
          const z = a[1] + (c[1] - a[1]) * t;
          const h = Math.max(0, roofHeightAt(pieces, x - nx * 0.04, z - nz * 0.04));
          const cur: [number, number, number] = [x, z, h];
          if (prev && (prev[2] > 0.02 || h > 0.02)) {
            const d0 = along + l * ((k - 1) / steps);
            const d1 = along + l * t;
            m.quad([[prev[0], eave, prev[1]], [x, eave, z], [x, eave + h, z], [prev[0], eave + prev[2], prev[1]]], [nx, 0, nz], bd.wall, [[d0, wallH], [d1, wallH], [d1, wallH + h], [d0, wallH + prev[2]]], seed, LAYER_FIREWALL, wallH + 6);
          }
          prev = cur;
        }
        stats.firewalls++;
      }
      along += l;
    });

    // Cornices along the street (and courtyard) sides; on flat roofs, a parapet with a coping.
    const prevOf = (i: number) => edges[(i - 1 + n) % n];
    const nextOf = (i: number) => edges[(i + 1) % n];
    const miter = (e1: { nx: number; nz: number; party: boolean }, e2: { nx: number; nz: number; party: boolean }, own: { nx: number; nz: number }): [number, number] => {
      if (e1.party || e2.party) return [own.nx, own.nz];
      const mx = e1.nx + e2.nx;
      const mz = e1.nz + e2.nz;
      const dot = e1.nx * e2.nx + e1.nz * e2.nz;
      const k = 1 / Math.max(0.35, (1 + dot) / 2);
      const ml = Math.hypot(mx, mz) || 1;
      return [(mx / ml) * Math.sqrt(k), (mz / ml) * Math.sqrt(k)];
    };
    edges.forEach((e, i) => {
      if (e.party || e.l < 0.3) return;
      const ma = miter(prevOf(i), e, e);
      const mc = miter(e, nextOf(i), e);
      const { a, c, nx, nz } = e;
      const at = (p: Pt, mv: [number, number], d: number, y: number) => [p[0] + mv[0] * d, y, p[1] + mv[1] * d];
      const L = e.l;
      if (flatRoof) {
        const t = 0.22;
        const y1 = eave + PARAPET;
        // Outer face (the wall carried up), coping, inner face.
        m.quad([at(a, ma, 0, eave), at(c, mc, 0, eave), at(c, mc, 0, y1), at(a, ma, 0, y1)], [nx, 0, nz], bd.wall, [[0, 0], [L, 0], [L, PARAPET], [0, PARAPET]], seed, LAYER_TRIM, PARAPET);
        m.quad([at(a, ma, 0.06, y1), at(c, mc, 0.06, y1), at(c, mc, -t, y1 + 0.06), at(a, ma, -t, y1 + 0.06)], [0, 1, 0], TRIM.unit[1], [[0, 0], [L, 0], [L, t], [0, t]], seed, LAYER_TRIM, 0);
        m.quad([at(c, mc, -t, eave), at(a, ma, -t, eave), at(a, ma, -t, y1 + 0.06), at(c, mc, -t, y1 + 0.06)], [-nx, 0, -nz], bd.wall, [[0, 0], [L, 0], [L, PARAPET], [0, PARAPET]], seed, LAYER_TRIM, PARAPET);
      } else {
        const { out, drop, fascia } = CORNICE;
        const y0 = eave - drop;
        const yf = eave - fascia;
        const sl = Math.hypot(out, drop - fascia);
        const sn = [nx * (drop - fascia) / sl, -out / sl, nz * (drop - fascia) / sl];
        m.quad([at(c, mc, 0, y0), at(a, ma, 0, y0), at(a, ma, out, yf), at(c, mc, out, yf)], sn, bd.wall, [[0, 0], [L, 0], [L, sl], [0, sl]], seed, LAYER_TRIM, 0);
        m.quad([at(a, ma, out, yf), at(c, mc, out, yf), at(c, mc, out, eave + 0.04), at(a, ma, out, eave + 0.04)], [nx, 0, nz], bd.wall, [[0, 0], [L, 0], [L, fascia], [0, fascia]], seed, LAYER_TRIM, 0);
        m.quad([at(a, ma, out, eave + 0.04), at(c, mc, out, eave + 0.04), at(c, mc, 0, eave + 0.04), at(a, ma, 0, eave + 0.04)], [0, 1, 0], bd.roof, [[0, 0], [L, 0], [L, out], [0, out]], seed, bd.roofLayer, 0);
      }
    });
  }

  if (flatRoof) {
    // A flat roof inside its parapet, and a few rooftop units on the bigger ones.
    emitFlat(m, bd.poly, () => eave + 0.02, [0, 1, 0], (x, z) => [x - cx + UV_UNIT / 2, z - cz + UV_UNIT / 2], bd.roof, seed, ROOF_LAYER.flat, wallH);
    const units = bd.area > 150 ? Math.min(5, Math.floor(bd.area / 350) + 1) : 0;
    const rect = minAreaRect(bd.poly[0]);
    for (let k = 0; k < units; k++) {
      const u = (roofRand() - 0.5) * 1.4 * Math.max(0, rect.halfU - 3);
      const v = (roofRand() - 0.5) * 1.4 * Math.max(0, rect.halfV - 3);
      const x = rect.cx + rect.ux * u - rect.uz * v;
      const z = rect.cz + rect.uz * u + rect.ux * v;
      if (!pointInPolygon(bd.poly, x, z)) continue;
      const hu = 0.8 + roofRand() * 2;
      const hv = 0.6 + roofRand() * 1.5;
      const hh = 1.2 + roofRand() * 1.8;
      bit(x, z, eave, eave + hh, rect.ux, rect.uz, hu, hv, pick(TRIM.unit, roofRand()), 1);
      ridge = Math.max(ridge, hh);
      stats.units++;
    }
  } else {
    // The pitched roof: the block's pieces over this footprint, lifted to its eaves.
    for (const { poly, piece } of clipPieces(pieces!, bd.poly)) {
      const s = piece.slope;
      const nl = Math.hypot(s * piece.a, 1, s * piece.b);
      const nrm = [(-s * piece.a) / nl, 1 / nl, (-s * piece.b) / nl];
      const k = Math.sqrt(1 + s * s);
      emitFlat(
        m,
        poly,
        (x, z) => eave + Math.max(0, pieceHeight(piece, x, z)),
        nrm,
        // u along the eave line, v up the slope (metres on the roof), so the courses run level.
        (x, z) => [-piece.b * (x - cx) + piece.a * (z - cz) + UV_UNIT / 2, (piece.a * (x - cx) + piece.b * (z - cz)) * k + UV_UNIT / 2],
        bd.roof,
        seed,
        bd.roofLayer,
        wallH,
      );
      for (const r of poly) for (const [x, z] of r) ridge = Math.max(ridge, pieceHeight(piece, x, z));
    }
    // Chimneys near the ridges, as Budapest's roofs have them, a few to every block of flats.
    const cap = profile!.knots[profile!.knots.length - 1][1];
    const count = bd.area < 40 || bd.kind === "steep" ? 0 : Math.min(14, Math.max(1, Math.round(bd.area / 75)));
    const box = ringBox(bd.poly[0]);
    let placed = 0;
    for (let tries = 0; tries < count * 6 && placed < count; tries++) {
      const x = box.minX + roofRand() * (box.maxX - box.minX);
      const z = box.minZ + roofRand() * (box.maxZ - box.minZ);
      if (!pointInPolygon(bd.poly, x, z)) continue;
      const h = roofHeightAt(pieces!, x, z);
      if (h < cap * 0.5) continue;
      // Along the slope's contour, so a stack sits square to its ridge.
      let ax = 1;
      let az = 0;
      for (const p of pieces!) {
        if (p.slope > 0 && pointInRing(p.poly[0], x, z)) {
          ax = -p.b;
          az = p.a;
          break;
        }
      }
      const top = eave + h + 1.0 + roofRand() * 0.6;
      const colour = pick(TRIM.chimney, roofRand());
      bit(x, z, eave + h - 0.8, top, ax, az, 0.32 + roofRand() * 0.2, 0.25, colour, 0);
      ridge = Math.max(ridge, top + 0.1 - eave);
      placed++;
      stats.chimneys++;
    }
  }
  bd.top = eave + ridge;
});
console.log(`roofs in ${((performance.now() - tRoofs) / 1000).toFixed(1)} s: ${JSON.stringify(stats)}`);

const meshes: MeshDef[] = [];
let tris = 0;
for (const [key, tile] of [...perTile.entries()].sort((p, q) => p[0].localeCompare(q[0]))) {
  const m = tile.main;
  if (!m.idx.length) continue;
  tris += m.idx.length / 3;
  meshes.push({
    name: `buildings ${key}`,
    material: { name: "building", roughness: 0.9 },
    position: new Float32Array(m.pos),
    normal: new Float32Array(m.nor),
    color: new Float32Array(m.col),
    uv: new Float32Array(m.uv),
    index: new Uint32Array(m.idx),
    extra: { _SEED: { array: new Float32Array(m.seed), size: 1 }, _FACADE: { array: new Float32Array(m.facade), size: 2 }, _CANYON: { array: new Float32Array(m.canyon), size: 2 } },
    extras: { tile: key, buildings: tile.buildings },
  });
}
const bitsSize = writeDataBytes("roofbits.bin", new Uint8Array(new Float32Array(bits).buffer));

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
// Species: the tagged genus where OSM has one, otherwise a mix by setting (street rows, the
// banks, Margaret Island, the hill woods, parks), with neighbours tending to share a species.
const GENUS: Record<string, TreeSpecies> = {
  Platanus: "plane", Aesculus: "chestnut", Tilia: "linden", Acer: "maple", Populus: "poplar", Salix: "willow", Quercus: "oak",
  Robinia: "robinia", Robinieae: "robinia", Gleditsia: "robinia", Sophora: "robinia", Pinus: "pine", Picea: "pine", Taxus: "pine",
  "fenyő": "pine", "Fenyőalakúak": "pine", Carpinus: "linden", Fraxinus: "maple", Betula: "poplar", Juglans: "chestnut", Morus: "linden",
  Ginkgo: "linden", Celtis: "linden", Ulmus: "linden", Prunus: "maple",
};
type Setting = "street" | "bank" | "island" | "wood" | "park";
const MIX: Record<Setting, [TreeSpecies, number][]> = {
  street: [["plane", 3], ["linden", 3], ["chestnut", 2], ["maple", 2], ["robinia", 2]],
  bank: [["willow", 3], ["poplar", 3], ["plane", 3], ["maple", 1]],
  island: [["plane", 4], ["poplar", 3], ["chestnut", 2], ["oak", 2], ["maple", 2], ["linden", 1]],
  wood: [["oak", 5], ["robinia", 3], ["maple", 2], ["pine", 2], ["linden", 1]],
  park: [["plane", 3], ["chestnut", 3], ["linden", 3], ["maple", 3], ["oak", 1], ["pine", 1]],
};
const fromMix = (mix: [TreeSpecies, number][], u: number): TreeSpecies => {
  const total = mix.reduce((n, [, w]) => n + w, 0);
  let t = u * total;
  for (const [sp, w] of mix) if ((t -= w) < 0) return sp;
  return mix[0][0];
};
function speciesAt(x: number, z: number, street: boolean, props: Record<string, string | undefined>): TreeSpecies {
  const genus = props.genus ?? props.species?.split(" ")[0];
  if (genus && GENUS[genus]) return GENUS[genus];
  if (props.leaf_type === "needleleaved") return "pine";
  const c = terrain.classAt(x, z);
  const setting: Setting = river.nearestBank(x, z, 85) ? "bank" : c === TERRAIN_CLASS.island ? "island" : c === TERRAIN_CLASS.wood ? "wood" : street ? "street" : "park";
  // The neighbourhood's own species (in 35 m cells) most of the time, a random one otherwise.
  const cell = hash01(`tree:${Math.floor(x / 35)},${Math.floor(z / 35)}`);
  return fromMix(MIX[setting], rand() < 0.6 ? cell : rand());
}
const addTree = (x: number, z: number, s: number, sp: TreeSpecies) => {
  if (treeOk(x, z)) trees.push(round2(x * 10) / 10, round2(z * 10) / 10, Math.round(s * 100) / 100, TREE_SPECIES_INDEX[sp]);
};
let fromOsm = 0;
for (const f of readOsm("trees")) {
  const props = f.properties as Record<string, string | undefined>;
  if (f.geometry.type === "Point") {
    const [lon, lat] = f.geometry.coordinates as number[];
    const { x, z } = lonLatToLocal(lon, lat);
    const street = terrain.classAt(x, z) === TERRAIN_CLASS.street;
    const sp = speciesAt(x, z, street, props);
    const h = num(props.height);
    const full = TREE_SPECIES[TREE_SPECIES_INDEX[sp]].height;
    addTree(x, z, Number.isFinite(h) ? Math.min(1.4, Math.max(0.35, h / full)) : street ? 0.5 + rand() * 0.25 : 0.7 + rand() * 0.45, sp);
    fromOsm++;
  } else if (f.geometry.type === "LineString") {
    const line = projectPolygons({ type: "Polygon", coordinates: [f.geometry.coordinates as number[][]] })[0][0];
    // A row is mostly one species.
    const sp0 = speciesAt(line[0][0], line[0][1], true, props);
    for (let i = 0; i < line.length - 1; i++) {
      const l = Math.hypot(line[i + 1][0] - line[i][0], line[i + 1][1] - line[i][1]);
      for (let d = 0; d < l; d += 8) {
        const x = line[i][0] + ((line[i + 1][0] - line[i][0]) * d) / l;
        const z = line[i][1] + ((line[i + 1][1] - line[i][1]) * d) / l;
        addTree(x, z, 0.5 + rand() * 0.25, rand() < 0.85 ? sp0 : speciesAt(x, z, true, props));
      }
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
      addTree(px, pz, 0.7 + rand() * 0.55, speciesAt(px, pz, false, {}));
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
const treeCount = trees.length / 4;
const treesSize = writeData("trees.json", { license: ODBL, note: "Flat [x, z, scale, species, ...] in local metres (species: TREE_SPECIES in src/config.ts); y comes from the terrain.", trees });

// --- Footprints for build-floor -------------------------------------------------------------------

mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
writeFileSync(
  new URL("./out/buildings.json", import.meta.url),
  JSON.stringify(buildings.map((bd) => ({ top: round2(bd.top), ring: bd.poly[0].flatMap((p: Pt) => [round2(p[0]), round2(p[1])]) }))),
);

console.log(`buildings: ${buildings.length} (height tag ${sources.height}, levels ${sources.levels}, default ${sources.default}); skipped ${JSON.stringify(skipped)}`);
console.log(`tiles: ${perTile.size} of ${TILE} m`);
const styleCount = TEXTURES.facades.map((name, i) => `${name} ${buildings.filter((x) => x.facade === i).length}`);
console.log(`facades: ${styleCount.join(", ")}`);
console.log(`city.glb ${kb(glb)}, ${tris} building triangles; roofbits.bin ${kb(bitsSize)}, ${bits.length / 12} chimneys and rooftop units`);
console.log(`trees.json ${kb(treesSize)}: ${treeCount} trees (${fromOsm} OSM tree points before filtering)`);
