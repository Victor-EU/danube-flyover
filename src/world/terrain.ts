// Terrain from public/data/terrain.bin (built by tools/build-terrain.ts from Copernicus GLO-30
// and OpenStreetMap): heights in metres above the river on a 10 m grid, plus a landcover class
// per sample that colours the mesh until M3's textures arrive.

import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial } from "three";
import type { Grid } from "./gridFile";

export const TERRAIN_CELL = 10;

/** Landcover classes stored per sample. */
export const TERRAIN_CLASS = { bed: 0, street: 1, park: 2, wood: 3, square: 4, pitch: 5, rock: 6, island: 7 } as const;

const PALETTE: Record<number, Color> = {
  0: new Color("#2f3f3d"),
  1: new Color("#b9ae97"),
  2: new Color("#7a9a58"),
  3: new Color("#5b7a44"),
  4: new Color("#cbbf9f"),
  5: new Color("#8fae62"),
  6: new Color("#a99d8a"),
  7: new Color("#7c9f5b"),
};

export class Terrain {
  readonly x0: number;
  readonly z0: number;
  readonly cell: number;
  readonly nx: number;
  readonly nz: number;
  readonly heights: Float32Array;
  readonly classes: Uint8Array;

  constructor(grid: Grid) {
    const h = grid.header;
    this.x0 = h.x0;
    this.z0 = h.z0;
    this.cell = h.cell;
    this.nx = h.nx;
    this.nz = h.nz;
    const raw = grid.layers.height;
    const scale = h.layers.find((l) => l.name === "height")?.scale ?? 1;
    this.heights = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) this.heights[i] = raw[i] * scale;
    this.classes = grid.layers.class as Uint8Array;
  }

  /** Bilinear height in metres above the river, clamped at the edges. */
  heightAt(x: number, z: number): number {
    const fx = Math.min(Math.max((x - this.x0) / this.cell, 0), this.nx - 1.001);
    const fz = Math.min(Math.max((z - this.z0) / this.cell, 0), this.nz - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const h = this.heights;
    const k = j * this.nx + i;
    return (h[k] * (1 - u) + h[k + 1] * u) * (1 - v) + (h[k + this.nx] * (1 - u) + h[k + this.nx + 1] * u) * v;
  }

  classAt(x: number, z: number): number {
    const i = Math.min(Math.max(Math.round((x - this.x0) / this.cell), 0), this.nx - 1);
    const j = Math.min(Math.max(Math.round((z - this.z0) / this.cell), 0), this.nz - 1);
    return this.classes[j * this.nx + i];
  }

  /** The mesh colour of sample k: its class colour with a little value noise. */
  colorAt(k: number, out: Color): Color {
    out.copy(PALETTE[this.classes[k]] ?? PALETTE[1]);
    const i = k % this.nx;
    const n = 1 + (hash(i, (k - i) / this.nx) - 0.5) * 0.06;
    return out.multiplyScalar(n);
  }

  buildMesh(): Mesh {
    const { nx, nz, cell } = this;
    const pos = new Float32Array(nx * nz * 3);
    const col = new Float32Array(nx * nz * 3);
    const c = new Color();
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        pos[k * 3] = this.x0 + i * cell;
        pos[k * 3 + 1] = this.heights[k];
        pos[k * 3 + 2] = this.z0 + j * cell;
        this.colorAt(k, c);
        col[k * 3] = c.r;
        col[k * 3 + 1] = c.g;
        col[k * 3 + 2] = c.b;
      }
    // Skip quads entirely under the water: the river surface hides them anyway.
    const index: number[] = [];
    for (let j = 0; j < nz - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const d = a + nx;
        const e = d + 1;
        const h = this.heights;
        if (h[a] < -0.5 && h[b] < -0.5 && h[d] < -0.5 && h[e] < -0.5) continue;
        index.push(a, d, b, b, d, e);
      }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    geo.setAttribute("color", new BufferAttribute(col, 3));
    geo.setIndex(new BufferAttribute(new Uint32Array(index), 1));
    geo.computeVertexNormals();
    const mesh = new Mesh(geo, new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    mesh.receiveShadow = true;
    mesh.name = "terrain";
    return mesh;
  }
}

function hash(i: number, j: number): number {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
