// The glider's altitude floor from public/data/floor.bin (baked by tools/build-floor.ts): a 5 m
// grid holding the highest of terrain, building roofs, hero blocks, tree crowns and bridge
// towers, and whether each cell is open water (or a tower standing in the water).

import { GLIDER, WORLD } from "../config";
import type { Grid } from "./gridFile";

export const FLOOR_CELL = 5;
export const FLOOR_KIND = { land: 0, water: 1, tower: 2 } as const;

export class Floor {
  readonly cell: number;
  readonly nx: number;
  readonly nz: number;
  private readonly x0: number;
  private readonly z0: number;
  private readonly height: Float32Array;
  private readonly kind: Uint8Array;

  constructor(grid: Grid) {
    const h = grid.header;
    this.cell = h.cell;
    this.nx = h.nx;
    this.nz = h.nz;
    this.x0 = h.x0;
    this.z0 = h.z0;
    const raw = grid.layers.height;
    const scale = h.layers.find((l) => l.name === "height")?.scale ?? 1;
    this.height = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) this.height[i] = raw[i] * scale;
    this.kind = grid.layers.kind as Uint8Array;
  }

  private index(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return -1;
    return j * this.nx + i;
  }

  /** Raw surface height at (x, z): water 0, otherwise ground, roof, crown or tower top. */
  surface(x: number, z: number, ignoreTowers = false): number {
    const idx = this.index(x, z);
    if (idx < 0) return WORLD.landBase;
    if (ignoreTowers && this.kind[idx] === FLOOR_KIND.tower) return 0;
    return this.height[idx];
  }

  isWater(x: number, z: number, ignoreTowers = false): boolean {
    const idx = this.index(x, z);
    if (idx < 0) return false;
    return this.kind[idx] === FLOOR_KIND.water || (ignoreTowers && this.kind[idx] === FLOOR_KIND.tower);
  }

  /** Lowest altitude the glider may fly at (x, z): the surface over water, clearance above it elsewhere. */
  gliderMin(x: number, z: number, ignoreTowers = false): number {
    if (this.isWater(x, z, ignoreTowers)) return 0;
    return this.surface(x, z, ignoreTowers) + GLIDER.landClearance;
  }

  /** Never below this: keeps the glider out of geometry even while it is being lifted. */
  hardMin(x: number, z: number, ignoreTowers = false): number {
    if (this.isWater(x, z, ignoreTowers)) return 0.3;
    return this.surface(x, z, ignoreTowers) + 3;
  }
}
