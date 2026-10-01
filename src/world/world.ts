// Builds the M0 grey-box world once at load and assembles its scene graph.

import { Group, Mesh, MeshStandardMaterial, PlaneGeometry } from "three";
import { WORLD } from "../config";
import { Bridges } from "./bridges";
import { City } from "./city";
import { Floor } from "./floor";
import { River } from "./river";
import { Terrain, worldBounds, type Bounds } from "./terrain";

export interface World {
  bounds: Bounds;
  river: River;
  terrain: Terrain;
  bridges: Bridges;
  city: City;
  floor: Floor;
  /** The river surface material; lighting tints it toward the horizon colour (M3 adds reflections). */
  water: MeshStandardMaterial;
  group: Group;
  /** Milliseconds per build step, for the debug panel. */
  timings: Record<string, number>;
}

export function buildWorld(): World {
  const timings: Record<string, number> = {};
  const time = <T>(name: string, f: () => T): T => {
    const t0 = performance.now();
    const r = f();
    timings[name] = Math.round(performance.now() - t0);
    return r;
  };
  const bounds = worldBounds();
  const river = time("river", () => new River());
  const terrain = time("terrain", () => new Terrain(river, bounds));
  const bridges = time("bridges", () => new Bridges(river));
  const city = time("city", () => new City(river, terrain, bridges, bounds));
  const floor = time("floor", () => new Floor(river, terrain, city.solids, bridges.obstacles, bounds));

  const group = new Group();
  group.add(time("terrainMesh", () => terrain.buildMesh((p) => city.inIsland(p.x, p.z))));
  const water = buildWater();
  group.add(city.group, bridges.group, water, buildFrame(river, bounds));
  return { bounds, river, terrain, bridges, city, floor, water: water.material as MeshStandardMaterial, group, timings };
}

/** The river: one big tinted plane at Y = 0 under everything. */
function buildWater(): Mesh {
  const geo = new PlaneGeometry(60000, 60000);
  geo.rotateX(-Math.PI / 2);
  const mesh = new Mesh(geo, new MeshStandardMaterial({ color: "#3b7680", roughness: 0.55, metalness: 0 }));
  mesh.receiveShadow = true;
  mesh.name = "water";
  return mesh;
}

/** Flat land around the world rectangle, with a gap where the river runs off north and south. */
function buildFrame(river: River, b: Bounds): Group {
  const group = new Group();
  const mat = new MeshStandardMaterial({ color: "#b4a98f", roughness: 1 });
  const FAR = 25000;
  const y = WORLD.landBase - 0.05;
  const rect = (x0: number, x1: number, z0: number, z1: number) => {
    const geo = new PlaneGeometry(x1 - x0, z1 - z0);
    geo.rotateX(-Math.PI / 2);
    const m = new Mesh(geo, mat);
    m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    m.receiveShadow = true;
    group.add(m);
  };
  rect(-FAR, b.x0, b.z0, b.z1); // west
  rect(b.x1, FAR, b.z0, b.z1); // east
  for (const [z, zFar] of [[b.z0, -FAR], [b.z1, FAR]] as const) {
    const gap = river.edgeGap(z + (z === b.z0 ? 1 : -1));
    const z0 = Math.min(z, zFar);
    const z1 = Math.max(z, zFar);
    if (gap.length === 2) {
      rect(-FAR, gap[0].x, z0, z1);
      rect(gap[1].x, FAR, z0, z1);
    } else rect(-FAR, FAR, z0, z1);
  }
  group.name = "frame";
  return group;
}
