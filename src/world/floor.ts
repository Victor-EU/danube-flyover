// The bird's altitude floor: a 5 m grid holding the highest of terrain, building tops and
// bridge towers, plus whether each cell is open water. M1 bakes this offline into floor.bin;
// in M0 it is built at load from the placeholder boxes.

import { BIRD, WORLD } from "../config";
import type { Obstacle } from "./bridges";
import type { Solid } from "./city";
import type { River } from "./river";
import type { Bounds, Terrain } from "./terrain";

const LAND = 0;
const WATER = 1;
const TOWER = 2;

export class Floor {
  readonly cell = 5;
  readonly nx: number;
  readonly nz: number;
  private readonly bounds: Bounds;
  private readonly height: Float32Array;
  private readonly kind: Uint8Array;

  constructor(river: River, terrain: Terrain, solids: Solid[], obstacles: Obstacle[], bounds: Bounds) {
    this.bounds = bounds;
    this.nx = Math.ceil((bounds.x1 - bounds.x0) / this.cell);
    this.nz = Math.ceil((bounds.z1 - bounds.z0) / this.cell);
    this.height = new Float32Array(this.nx * this.nz);
    this.kind = new Uint8Array(this.nx * this.nz);

    for (let j = 0; j < this.nz; j++) {
      const z = bounds.z0 + (j + 0.5) * this.cell;
      const spans = river.waterSpans(z);
      let k = 0;
      for (let i = 0; i < this.nx; i++) {
        const x = bounds.x0 + (i + 0.5) * this.cell;
        while (k < spans.length && spans[k] <= x) k++;
        const idx = j * this.nx + i;
        if (k % 2 === 1) {
          this.kind[idx] = WATER;
          this.height[idx] = 0;
        } else {
          this.kind[idx] = LAND;
          this.height[idx] = Math.max(terrain.heightAt(x, z), WORLD.quayHeight);
        }
      }
    }

    for (const s of solids) {
      const c = Math.cos(s.rot);
      const sn = Math.sin(s.rot);
      this.raster(s.x, s.z, Math.hypot(s.hw, s.hd), (dx, dz) => {
        // Inverse of the mesh's Y rotation.
        const lx = dx * c - dz * sn;
        const lz = dx * sn + dz * c;
        return Math.abs(lx) <= s.hw + 2.5 && Math.abs(lz) <= s.hd + 2.5;
      }, s.top, LAND);
    }
    for (const o of obstacles) {
      if (!o.tower) continue;
      this.raster(o.cx, o.cz, Math.hypot(o.halfAlong, o.halfAcross), (dx, dz) => {
        const a = dx * o.ux + dz * o.uz;
        const b = -dx * o.uz + dz * o.ux;
        return Math.abs(a) <= o.halfAlong + 2.5 && Math.abs(b) <= o.halfAcross + 2.5;
      }, o.top, TOWER);
    }
  }

  private raster(cx: number, cz: number, r: number, inside: (dx: number, dz: number) => boolean, top: number, kind: number): void {
    const { x0, z0 } = this.bounds;
    const i0 = Math.max(0, Math.floor((cx - r - 3 - x0) / this.cell));
    const i1 = Math.min(this.nx - 1, Math.ceil((cx + r + 3 - x0) / this.cell));
    const j0 = Math.max(0, Math.floor((cz - r - 3 - z0) / this.cell));
    const j1 = Math.min(this.nz - 1, Math.ceil((cz + r + 3 - z0) / this.cell));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = x0 + (i + 0.5) * this.cell;
        const z = z0 + (j + 0.5) * this.cell;
        if (!inside(x - cx, z - cz)) continue;
        const idx = j * this.nx + i;
        if (top > this.height[idx] || this.kind[idx] === WATER) {
          this.height[idx] = Math.max(top, this.height[idx]);
          this.kind[idx] = kind;
        }
      }
  }

  private index(x: number, z: number): number {
    const i = Math.floor((x - this.bounds.x0) / this.cell);
    const j = Math.floor((z - this.bounds.z0) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return -1;
    return j * this.nx + i;
  }

  /** Raw surface height at (x, z): water 0, otherwise ground, roof or tower top. */
  surface(x: number, z: number, ignoreTowers = false): number {
    const idx = this.index(x, z);
    if (idx < 0) return WORLD.landBase;
    if (ignoreTowers && this.kind[idx] === TOWER) return 0;
    return this.height[idx];
  }

  isWater(x: number, z: number, ignoreTowers = false): boolean {
    const idx = this.index(x, z);
    if (idx < 0) return false;
    return this.kind[idx] === WATER || (ignoreTowers && this.kind[idx] === TOWER);
  }

  /** Lowest altitude the bird may fly at (x, z): the surface over water, clearance above it elsewhere. */
  birdMin(x: number, z: number, ignoreTowers = false): number {
    if (this.isWater(x, z, ignoreTowers)) return 0;
    return this.surface(x, z, ignoreTowers) + BIRD.landClearance;
  }

  /** Never below this: keeps the bird out of geometry even while it is being lifted. */
  hardMin(x: number, z: number, ignoreTowers = false): number {
    if (this.isWater(x, z, ignoreTowers)) return 0.3;
    return this.surface(x, z, ignoreTowers) + 3;
  }
}
