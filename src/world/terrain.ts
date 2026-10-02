// Terrain from public/data/terrain.bin (built by tools/build-terrain.ts from Copernicus GLO-30
// and OpenStreetMap): heights in metres above the river on a 10 m grid, plus a landcover class
// per sample that colours the mesh (and, at night, lights its streets).

import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial } from "three";
import type { Grid } from "./gridFile";
import { patchTerrain } from "./surfaces";

export const TERRAIN_CELL = 10;

/** Landcover classes stored per sample. */
export const TERRAIN_CLASS = { bed: 0, street: 1, park: 2, wood: 3, square: 4, pitch: 5, rock: 6, island: 7 } as const;

/** Street-light glow at night by class: streets and squares lit, parks a little, woods dark. */
const GLOW: Record<number, number> = { 1: 1, 4: 0.85, 5: 0.25, 2: 0.12, 7: 0.05 };

/** Ground colour by class, in early October: tired olive grass, leaf litter under the woods. */
const PALETTE: Record<number, Color> = {
  0: new Color("#2f3f3d"),
  1: new Color("#b9ae97"),
  2: new Color("#8a9852"),
  3: new Color("#77693d"),
  4: new Color("#cbbf9f"),
  5: new Color("#8aa65e"),
  6: new Color("#a99d8a"),
  7: new Color("#879a55"),
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

  /**
   * The terrain mesh, on every sample, or with a stride on every stride-th one (and the last):
   * the coarse one the water's reflection draws in its place (water.ts), where its detail
   * doesn't show. A coarse vertex takes its block's average colour and street glow, so the
   * streets don't alias at night; the river bed is left out of a bank's average.
   */
  buildMesh(stride = 1, material?: MeshStandardMaterial): Mesh {
    const { nx, nz, cell } = this;
    const xs = strided(nx, stride);
    const zs = strided(nz, stride);
    const mx = xs.length;
    const mz = zs.length;
    const pos = new Float32Array(mx * mz * 3);
    const col = new Float32Array(mx * mz * 3);
    const glow = new Float32Array(mx * mz);
    const c = new Color();
    const r = Math.floor(stride / 2);
    for (let b = 0; b < mz; b++)
      for (let a = 0; a < mx; a++) {
        const i = xs[a];
        const j = zs[b];
        const v = b * mx + a;
        const k = j * nx + i;
        pos[v * 3] = this.x0 + i * cell;
        pos[v * 3 + 1] = this.heights[k];
        pos[v * 3 + 2] = this.z0 + j * cell;
        const bed = this.classes[k] === TERRAIN_CLASS.bed;
        let n = 0;
        let g = 0;
        let [cr, cg, cb] = [0, 0, 0];
        for (let jj = Math.max(0, j - r); jj <= Math.min(nz - 1, j + r); jj++)
          for (let ii = Math.max(0, i - r); ii <= Math.min(nx - 1, i + r); ii++) {
            const kk = jj * nx + ii;
            if (!bed && this.classes[kk] === TERRAIN_CLASS.bed) continue;
            this.colorAt(kk, c);
            cr += c.r;
            cg += c.g;
            cb += c.b;
            g += GLOW[this.classes[kk]] ?? 0;
            n++;
          }
        col[v * 3] = cr / n;
        col[v * 3 + 1] = cg / n;
        col[v * 3 + 2] = cb / n;
        glow[v] = g / n;
      }
    // Skip quads entirely under the water: the river surface hides them anyway.
    const h = this.heights;
    const dry = (i0: number, i1: number, j0: number, j1: number) => {
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (h[j * nx + i] >= -0.5) return true;
      return false;
    };
    const index: number[] = [];
    for (let b = 0; b < mz - 1; b++)
      for (let a = 0; a < mx - 1; a++) {
        if (!dry(xs[a], xs[a + 1], zs[b], zs[b + 1])) continue;
        const p = b * mx + a;
        const q = p + 1;
        const d = p + mx;
        const e = d + 1;
        index.push(p, d, q, q, d, e);
      }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    geo.setAttribute("color", new BufferAttribute(col, 3));
    geo.setAttribute("glow", new BufferAttribute(glow, 1));
    geo.setIndex(new BufferAttribute(new Uint32Array(index), 1));
    geo.computeVertexNormals();
    let mat = material;
    if (!mat) {
      mat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
      patchTerrain(mat);
    }
    const mesh = new Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = stride > 1 ? "terrain (reflection)" : "terrain";
    return mesh;
  }
}

/** Every stride-th index below n, and the last. */
function strided(n: number, stride: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n - 1; i += stride) out.push(i);
  out.push(n - 1);
  return out;
}

function hash(i: number, j: number): number {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
