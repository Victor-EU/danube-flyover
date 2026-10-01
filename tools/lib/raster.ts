// Regular grids over the local frame for the pipeline: scanline polygon fill by cell centre,
// bilinear sampling, and the separable min/max/blur filters build-terrain uses.

import type { Polygon, Ring } from "./geom";

export class Raster {
  readonly data: Float32Array;

  /** (x0, z0) is the position of sample (0, 0); samples are `cell` apart. */
  constructor(
    readonly x0: number,
    readonly z0: number,
    readonly cell: number,
    readonly nx: number,
    readonly nz: number,
    fill = 0,
  ) {
    this.data = new Float32Array(nx * nz).fill(fill);
  }

  static like(r: Raster, fill = 0): Raster {
    return new Raster(r.x0, r.z0, r.cell, r.nx, r.nz, fill);
  }

  clone(): Raster {
    const r = Raster.like(this);
    r.data.set(this.data);
    return r;
  }

  get(i: number, j: number): number {
    return this.data[j * this.nx + i];
  }

  x(i: number): number {
    return this.x0 + i * this.cell;
  }

  z(j: number): number {
    return this.z0 + j * this.cell;
  }

  /** Bilinear sample, clamped at the edges. */
  sample(x: number, z: number): number {
    const fx = Math.min(Math.max((x - this.x0) / this.cell, 0), this.nx - 1.000001);
    const fz = Math.min(Math.max((z - this.z0) / this.cell, 0), this.nz - 1.000001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const d = this.data;
    const k = j * this.nx + i;
    return (d[k] * (1 - u) + d[k + 1] * u) * (1 - v) + (d[k + this.nx] * (1 - u) + d[k + this.nx + 1] * u) * v;
  }

  /** Calls `f(index, i, j)` for every sample inside the polygon (even-odd over all rings). */
  forEachInside(poly: Polygon | Ring[], f: (k: number, i: number, j: number) => void): void {
    let zMin = Infinity;
    let zMax = -Infinity;
    for (const r of poly) for (const p of r) {
      zMin = Math.min(zMin, p[1]);
      zMax = Math.max(zMax, p[1]);
    }
    const j0 = Math.max(0, Math.ceil((zMin - this.z0) / this.cell));
    const j1 = Math.min(this.nz - 1, Math.floor((zMax - this.z0) / this.cell));
    const xs: number[] = [];
    for (let j = j0; j <= j1; j++) {
      const z = this.z(j);
      xs.length = 0;
      for (const r of poly)
        for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
          const [xa, za] = r[a];
          const [xb, zb] = r[b];
          if (za <= z !== zb <= z) xs.push(xa + ((z - za) / (zb - za)) * (xb - xa));
        }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - this.x0) / this.cell));
        const i1 = Math.min(this.nx - 1, Math.floor((xs[k + 1] - this.x0) / this.cell));
        for (let i = i0; i <= i1; i++) f(j * this.nx + i, i, j);
      }
    }
  }

  fillPolygon(poly: Polygon | Ring[], value: number, mode: "set" | "max" | "min" = "set"): void {
    const d = this.data;
    if (mode === "set") this.forEachInside(poly, (k) => (d[k] = value));
    else if (mode === "max") this.forEachInside(poly, (k) => (d[k] = Math.max(d[k], value)));
    else this.forEachInside(poly, (k) => (d[k] = Math.min(d[k], value)));
  }

  /** Square-window min or max with radius `r` samples (separable). */
  morph(r: number, op: "min" | "max"): Raster {
    const pick = op === "min" ? Math.min : Math.max;
    const tmp = Raster.like(this);
    const out = Raster.like(this);
    const { nx, nz } = this;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        let v = op === "min" ? Infinity : -Infinity;
        for (let k = Math.max(0, i - r); k <= Math.min(nx - 1, i + r); k++) v = pick(v, this.data[j * nx + k]);
        tmp.data[j * nx + i] = v;
      }
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        let v = op === "min" ? Infinity : -Infinity;
        for (let k = Math.max(0, j - r); k <= Math.min(nz - 1, j + r); k++) v = pick(v, tmp.data[k * nx + i]);
        out.data[j * nx + i] = v;
      }
    return out;
  }

  /** Gaussian blur with standard deviation `sigma` metres (separable, edge-clamped). */
  blur(sigma: number): Raster {
    const s = sigma / this.cell;
    const r = Math.ceil(s * 3);
    const w = new Float32Array(r * 2 + 1);
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += w[k + r] = Math.exp(-(k * k) / (2 * s * s));
    for (let k = 0; k < w.length; k++) w[k] /= sum;
    const { nx, nz } = this;
    const tmp = Raster.like(this);
    const out = Raster.like(this);
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        let v = 0;
        for (let k = -r; k <= r; k++) v += w[k + r] * this.data[j * nx + Math.min(nx - 1, Math.max(0, i + k))];
        tmp.data[j * nx + i] = v;
      }
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        let v = 0;
        for (let k = -r; k <= r; k++) v += w[k + r] * tmp.data[Math.min(nz - 1, Math.max(0, j + k)) * nx + i];
        out.data[j * nx + i] = v;
      }
    return out;
  }
}

/**
 * Fills the samples where `mask` is non-zero by relaxing toward their neighbours (Jacobi
 * iterations of Laplace's equation), keeping the unmasked samples fixed.
 */
export function inpaint(r: Raster, mask: Uint8Array, iterations: number): Raster {
  const out = r.clone();
  const { nx, nz } = r;
  // Start masked samples from the mean of the unmasked ones so convergence is quicker.
  let mean = 0;
  let n = 0;
  for (let k = 0; k < mask.length; k++) if (!mask[k]) {
    mean += r.data[k];
    n++;
  }
  mean /= Math.max(1, n);
  for (let k = 0; k < mask.length; k++) if (mask[k]) out.data[k] = mean;
  const next = out.data.slice();
  for (let it = 0; it < iterations; it++) {
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!mask[k]) continue;
        let s = 0;
        let c = 0;
        if (i > 0) (s += out.data[k - 1]), c++;
        if (i < nx - 1) (s += out.data[k + 1]), c++;
        if (j > 0) (s += out.data[k - nx]), c++;
        if (j < nz - 1) (s += out.data[k + nx]), c++;
        next[k] = s / c;
      }
    out.data.set(next);
  }
  return out;
}
