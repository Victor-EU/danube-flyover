// What a hero builder can ask about the world: the landmark's position, the ground under it,
// the river and bridges, and OSM building footprints (projected, simplified, oriented).

import { WORLD } from "../../src/config";
import { lonLatToLocal } from "../../src/geo";
import { Bridges, type BridgesJson } from "../../src/world/bridges";
import { decodeGrid } from "../../src/world/gridFile";
import type { LandmarkJson, LandmarksJson } from "../../src/world/landmarks";
import { River, type RiverJson } from "../../src/world/river";
import { Terrain } from "../../src/world/terrain";
import { polygonArea, projectPolygons, simplifyRing, type Polygon } from "../lib/geom";
import { readData, readDataBytes, readOsm } from "../lib/io";
import { orient } from "./kit";

export class HeroContext {
  readonly river = new River(readData<RiverJson>("river.json"));
  readonly terrain = new Terrain(decodeGrid(readDataBytes("terrain.bin")));
  readonly bridgesJson = readData<BridgesJson>("bridges.json");
  readonly bridges = new Bridges(this.bridgesJson, this.river, this.terrain, false);
  readonly landmarks = readData<LandmarksJson>("landmarks.json").landmarks;
  private readonly osm = new Map(readOsm("buildings").map((f) => [f.properties.id, f]));

  landmark(id: string): LandmarkJson {
    const l = this.landmarks.find((x) => x.id === id);
    if (!l) throw new Error(`no landmark ${id}`);
    return l;
  }

  centre(id: string): { x: number; z: number } {
    const l = this.landmark(id);
    return lonLatToLocal(l.position.lon, l.position.lat);
  }

  ground(x: number, z: number): number {
    return Math.max(this.terrain.heightAt(x, z), WORLD.landBase);
  }

  /** Lowest and highest ground under a set of points. */
  groundRange(points: [number, number][]): [number, number] {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [x, z] of points) {
      const g = this.ground(x, z);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
    }
    return [lo, hi];
  }

  /**
   * An OSM building's polygons in world metres: simplified to `tol`, holes smaller than
   * `minHole` m² dropped, outer rings counter-clockwise and holes clockwise.
   */
  footprint(osmId: string, tol = 0.5, minHole = 0): Polygon[] {
    const f = this.osm.get(osmId);
    if (!f) throw new Error(`no OSM building ${osmId}`);
    return projectPolygons(f.geometry).map((p) =>
      orient(p.map((r) => simplifyRing(r, tol)).filter((r, k) => r.length >= 3 && (k === 0 || polygonArea([r]) >= minHole))),
    );
  }

  bridge(name: string): BridgesJson["bridges"][number] {
    const b = this.bridgesJson.bridges.find((x) => x.name === name);
    if (!b) throw new Error(`no bridge ${name}`);
    return b;
  }
}
