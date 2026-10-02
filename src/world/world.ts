// Assembles the world from the files the tools/ pipeline writes to public/data/. The query
// layer (river, terrain, floor, bridges) is built in Node too, for tools/simulate.ts; the
// scene graph (glTF city and water, landmark blocks, trees, backdrop) only in the browser.

import { BufferAttribute, BufferGeometry, Color, Group, type InstancedMesh, Mesh, MeshStandardMaterial, PlaneGeometry, type Object3D } from "three";
import { WORLD } from "../config";
import type { LifeJson } from "../effects";
import type { TextureSet } from "../textures";
import { worldBounds, type Bounds } from "./bounds";
import { Bridges, type BridgesJson } from "./bridges";
import { Floor } from "./floor";
import { Heroes } from "./heroes";
import { decodeGrid } from "./gridFile";
import { buildSights, Landmarks, type LandmarksJson, type Sight } from "./landmarks";
import { River, type RiverJson } from "./river";
import { Terrain } from "./terrain";
import { patchBuildings, patchQuays } from "./surfaces";
import { buildTrees, type TreesJson } from "./trees";
import { LAYER } from "./water";

export interface WorldFiles {
  river: RiverJson;
  bridges: BridgesJson;
  landmarks: LandmarksJson;
  trees: TreesJson;
  terrain: ArrayBuffer | Uint8Array;
  floor: ArrayBuffer | Uint8Array;
  /** The trams' lines (browser only). */
  life?: LifeJson;
}

/** The glTF scenes (city, water, heroes by landmark id) and the texture set, loaded (browser only). */
export interface WorldModels {
  city: Object3D;
  water: Object3D;
  heroes: Record<string, Object3D>;
  textures: TextureSet;
}

export interface World {
  bounds: Bounds;
  river: River;
  terrain: Terrain;
  floor: Floor;
  bridges: Bridges;
  /** Labels, and placeholder blocks for any landmark still without a model (browser only). */
  landmarks: Landmarks | null;
  /** The hero landmarks' models (browser only). */
  heroes: Heroes | null;
  /** The instanced trees (browser only); the quality tiers draw a share of them. */
  trees: InstancedMesh | null;
  /** Every landmark's position and aim point, for the cards and the orbit camera. */
  sights: Sight[];
  /** The river's material (water.ts makes it reflect), and the ponds' (no planar reflection). */
  water: MeshStandardMaterial;
  pond: MeshStandardMaterial;
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
  // Bridges with a hero model aren't built here (the landmark's name is the bridge's).
  const heroBridges = new Set(files.landmarks.landmarks.filter((l) => l.model && models?.heroes[l.id]).map((l) => l.name));
  const bridges = time("bridges", () => new Bridges(files.bridges, river, terrain, !!models, heroBridges));
  const sights = buildSights(files.landmarks, (x, z) => terrain.heightAt(x, z));
  const water = new MeshStandardMaterial({ color: "#3b7680", roughness: 0.55, metalness: 0, name: "river" });
  const pond = new MeshStandardMaterial({ color: "#3b7680", roughness: 0.55, metalness: 0, name: "pond" });
  const group = new Group();
  let landmarks: Landmarks | null = null;
  let heroes: Heroes | null = null;
  let trees: InstancedMesh | null = null;

  if (models) {
    group.add(time("terrainMesh", () => terrain.buildMesh()));
    group.add(time("apron", () => buildApron(terrain)));
    group.add(buildFrame(river, bounds, water));
    time("models", () => {
      const patched = new Set<MeshStandardMaterial>();
      for (const root of [models.city, models.water])
        root.traverse((o) => {
          if (!(o as Mesh).isMesh) return;
          const mesh = o as Mesh;
          const mat = mesh.material as MeshStandardMaterial;
          if (mat.name === "water") {
            // The river (water.glb) reflects the scene; the ponds (city.glb) only the sky.
            const river = root === models.water;
            mesh.material = river ? water : pond;
            mesh.receiveShadow = true;
            mesh.layers.set(LAYER.water);
            return;
          }
          mesh.castShadow = mesh.name.startsWith("buildings");
          mesh.receiveShadow = true;
          mat.flatShading = false;
          if (patched.has(mat)) return;
          patched.add(mat);
          if (mat.name === "building") patchBuildings(mat, models.textures);
          else if (mat.name === "quay") patchQuays(mat, models.textures.quay);
        });
      group.add(models.city, models.water);
    });
    landmarks = time("landmarks", () => new Landmarks(files.landmarks, (x, z) => terrain.heightAt(x, z), new Set(Object.keys(models.heroes))));
    group.add(landmarks.group);
    heroes = time("heroes", () => new Heroes(models.heroes, models.textures, Object.fromEntries(files.landmarks.landmarks.map((l) => [l.id, l.name]))));
    group.add(heroes.group);
    trees = time("trees", () => buildTrees(files.trees, terrain));
    trees.layers.set(LAYER.trees);
    group.add(trees);
    group.add(bridges.group);
  }
  return { bounds, river, terrain, floor, bridges, landmarks, heroes, trees, sights, water, pond, group, timings };
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
    if (m === water) {
      // Flow coordinates like the river mesh's: u runs south (downstream), v east, in metres.
      const pos = geo.attributes.position;
      const uv = geo.attributes.uv;
      for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getZ(i) + mesh.position.z, pos.getX(i) + mesh.position.x);
      mesh.layers.set(LAYER.water);
    }
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
