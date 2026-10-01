// Assembles the world from the files the tools/ pipeline writes to public/data/. The query
// layer (river, terrain, floor, bridges) is built in Node too, for tools/simulate.ts; the
// scene graph (glTF city and water, landmark blocks, trees, backdrop) only in the browser.

import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshStandardMaterial, PlaneGeometry, type Object3D } from "three";
import { WORLD } from "../config";
import { worldBounds, type Bounds } from "./bounds";
import { Bridges, type BridgesJson } from "./bridges";
import { Floor } from "./floor";
import { decodeGrid } from "./gridFile";
import { buildSights, Landmarks, type LandmarksJson, type Sight } from "./landmarks";
import { River, type RiverJson } from "./river";
import { Terrain } from "./terrain";
import { buildTrees, type TreesJson } from "./trees";

export interface WorldFiles {
  river: RiverJson;
  bridges: BridgesJson;
  landmarks: LandmarksJson;
  trees: TreesJson;
  terrain: ArrayBuffer | Uint8Array;
  floor: ArrayBuffer | Uint8Array;
}

/** The glTF scenes from city.glb and water.glb, already loaded (browser only). */
export interface WorldModels {
  city: Object3D;
  water: Object3D;
}

export interface World {
  bounds: Bounds;
  river: River;
  terrain: Terrain;
  floor: Floor;
  bridges: Bridges;
  /** Placeholder blocks and labels (browser only). */
  landmarks: Landmarks | null;
  /** Every landmark's position and aim point, for the cards and the orbit camera. */
  sights: Sight[];
  /** The shared water material; lighting tints it toward the horizon colour (M3 adds reflections). */
  water: MeshStandardMaterial;
  group: Group;
  /** Milliseconds per build step, for the debug panel. */
  timings: Record<string, number>;
}

export function buildWorld(files: WorldFiles, models?: WorldModels): World {
  const timings: Record<string, number> = {};
  const time = <T>(name: string, f: () => T): T => {
    const t0 = performance.now();
    const r = f();
    timings[name] = Math.round(performance.now() - t0);
    return r;
  };
  const bounds = worldBounds();
  const river = time("river", () => new River(files.river));
  const terrain = time("terrain", () => new Terrain(decodeGrid(files.terrain)));
  const floor = time("floor", () => new Floor(decodeGrid(files.floor)));
  const bridges = time("bridges", () => new Bridges(files.bridges, river, terrain, !!models));
  const sights = buildSights(files.landmarks, (x, z) => terrain.heightAt(x, z));
  const water = new MeshStandardMaterial({ color: "#3b7680", roughness: 0.55, metalness: 0 });
  const group = new Group();
  let landmarks: Landmarks | null = null;

  if (models) {
    group.add(time("terrainMesh", () => terrain.buildMesh()));
    group.add(time("apron", () => buildApron(terrain)));
    group.add(buildFrame(river, bounds, water));
    time("models", () => {
      for (const root of [models.city, models.water])
        root.traverse((o) => {
          if (!(o as Mesh).isMesh) return;
          const mesh = o as Mesh;
          const mat = mesh.material as MeshStandardMaterial;
          if (mat.name === "water") {
            mesh.material = water;
            mesh.receiveShadow = true;
          } else {
            mesh.castShadow = mesh.name.startsWith("buildings");
            mesh.receiveShadow = true;
            mat.flatShading = false;
          }
        });
      group.add(models.city, models.water);
    });
    landmarks = time("landmarks", () => new Landmarks(files.landmarks, (x, z) => terrain.heightAt(x, z)));
    group.add(landmarks.group);
    group.add(time("trees", () => buildTrees(files.trees, terrain)));
    group.add(bridges.group);
  }
  return { bounds, river, terrain, floor, bridges, landmarks, sights, water, group, timings };
}

/**
 * The terrain fades out beyond the world: from each edge sample, two rings 600 m and 2.5 km
 * out, sloping to the flat land base, so the hills don't end in a cliff. The river keeps
 * going under the far water strips.
 */
function buildApron(t: Terrain): Mesh {
  const edge: { i: number; j: number; nx: number; nz: number }[] = [];
  const last = { i: t.nx - 1, j: t.nz - 1 };
  const s = Math.SQRT1_2;
  for (let i = 0; i < last.i; i++) edge.push({ i, j: 0, nx: 0, nz: -1 });
  edge.push({ i: last.i, j: 0, nx: s, nz: -s });
  for (let j = 1; j < last.j; j++) edge.push({ i: last.i, j, nx: 1, nz: 0 });
  edge.push({ i: last.i, j: last.j, nx: s, nz: s });
  for (let i = last.i - 1; i > 0; i--) edge.push({ i, j: last.j, nx: 0, nz: 1 });
  edge.push({ i: 0, j: last.j, nx: -s, nz: s });
  for (let j = last.j - 1; j > 0; j--) edge.push({ i: 0, j, nx: -1, nz: 0 });
  edge.splice(0, 1, { i: 0, j: 0, nx: -s, nz: -s });

  const base = WORLD.landBase;
  const far = new Color("#b4a98f");
  const RINGS = [0, 600, 2500];
  // The outer rings follow a smoothed copy of the edge heights, so the edge's detail doesn't
  // stretch out into radial ridges.
  const n = edge.length;
  const raw = edge.map((e) => t.heights[e.j * t.nx + e.i]);
  const smooth = raw.map((_, a) => {
    let sum = 0;
    for (let d = -20; d <= 20; d++) sum += Math.max(raw[(a + d + n) % n], base);
    return sum / 41;
  });
  const pos: number[] = [];
  const col: number[] = [];
  const c = new Color();
  edge.forEach((e, a) => {
    const k = e.j * t.nx + e.i;
    const h = raw[a];
    const x = t.x0 + e.i * t.cell;
    const z = t.z0 + e.j * t.cell;
    t.colorAt(k, c);
    RINGS.forEach((d, r) => {
      const y = h < 0 ? h : r === 0 ? h : r === 1 ? smooth[a] * 0.45 + base * 0.55 : base;
      pos.push(x + e.nx * d, y, z + e.nz * d);
      const cc = r === 0 ? c : far;
      col.push(cc.r, cc.g, cc.b);
    });
  });
  const index: number[] = [];
  for (let a = 0; a < n; a++) {
    const bIdx = (a + 1) % n;
    for (let r = 0; r < RINGS.length - 1; r++) {
      const p = a * 3 + r;
      const q = bIdx * 3 + r;
      // The walk goes clockwise seen from above (north up); this winding faces up.
      index.push(p, q, p + 1, q, q + 1, p + 1);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute("color", new BufferAttribute(new Float32Array(col), 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const mesh = new Mesh(geo, new MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  mesh.receiveShadow = true;
  mesh.name = "apron";
  return mesh;
}

/** Flat land beyond the apron, and water where the river runs off north and south. */
function buildFrame(river: River, b: Bounds, water: MeshStandardMaterial): Group {
  const group = new Group();
  const mat = new MeshStandardMaterial({ color: "#b4a98f", roughness: 1 });
  const FAR = 25000;
  const y = WORLD.landBase - 2;
  const rect = (x0: number, x1: number, z0: number, z1: number, m: MeshStandardMaterial, h: number) => {
    const geo = new PlaneGeometry(x1 - x0, z1 - z0);
    geo.rotateX(-Math.PI / 2);
    const mesh = new Mesh(geo, m);
    mesh.position.set((x0 + x1) / 2, h, (z0 + z1) / 2);
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  rect(-FAR, b.x0, b.z0, b.z1, mat, y); // west
  rect(b.x1, FAR, b.z0, b.z1, mat, y); // east
  for (const [z, zFar] of [[b.z0, -FAR], [b.z1, FAR]] as const) {
    const gap = river.edgeGap(z + (z === b.z0 ? 1 : -1));
    const z0 = Math.min(z, zFar);
    const z1 = Math.max(z, zFar);
    if (gap.length === 2) {
      rect(-FAR, gap[0].x, z0, z1, mat, y);
      rect(gap[1].x, FAR, z0, z1, mat, y);
      rect(gap[0].x, gap[1].x, z0, z1, water, 0);
    } else rect(-FAR, FAR, z0, z1, mat, y);
  }
  group.name = "frame";
  return group;
}
