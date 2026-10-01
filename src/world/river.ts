// River geometry in local metres, from public/data/river.json (built by tools/build-water.ts
// from OpenStreetMap): a point-in-water test, the nearest bank, and scanline water spans.

import type { XZ } from "../geo";

export interface RiverJson {
  /** Polygons as [outer, ...holes]; each ring a flat [x, z, ...] list. */
  water: number[][][];
  /** The real bank lines; a closed bank (an island) repeats its first point. */
  banks: number[][];
  centreline: number[];
}

type Ring = Float64Array; // x0, z0, x1, z1, ... (implicitly closed)

export interface BankHit {
  /** Distance from the query point to the bank. */
  d: number;
  /** Nearest point on the bank. */
  x: number;
  z: number;
  /** Unit direction of the bank segment there. */
  ux: number;
  uz: number;
}

const CELL = 50;

/** x positions where a closed ring crosses the horizontal line z (half-open rule). */
function ringCrossings(ring: Ring, z: number, out: number[]): void {
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const zi = ring[i * 2 + 1];
    const zj = ring[j * 2 + 1];
    if (zi <= z !== zj <= z) {
      const xi = ring[i * 2];
      const xj = ring[j * 2];
      out.push(xi + ((z - zi) / (zj - zi)) * (xj - xi));
    }
  }
}

export class River {
  /** Every ring of every water polygon; inside-ness is even-odd over all of them. */
  readonly rings: Ring[];
  readonly banks: Float64Array[];
  readonly centreline: Float64Array;
  private readonly ringBoxes: number[][];
  private readonly segs: number[] = []; // ax, az, bx, bz
  private readonly grid = new Map<number, number[]>();

  constructor(data: RiverJson) {
    this.rings = data.water.flat().map((r) => Float64Array.from(r));
    this.ringBoxes = this.rings.map((r) => {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < r.length; i += 2) {
        x0 = Math.min(x0, r[i]);
        x1 = Math.max(x1, r[i]);
        z0 = Math.min(z0, r[i + 1]);
        z1 = Math.max(z1, r[i + 1]);
      }
      return [x0, z0, x1, z1];
    });
    this.banks = data.banks.map((b) => Float64Array.from(b));
    this.centreline = Float64Array.from(data.centreline);
    for (const b of this.banks) this.addPolyline(b);
  }

  private addPolyline(p: Float64Array): void {
    const n = p.length / 2;
    for (let i = 0; i < n - 1; i++) {
      const idx = this.segs.length / 4;
      this.segs.push(p[i * 2], p[i * 2 + 1], p[i * 2 + 2], p[i * 2 + 3]);
      const x0 = Math.floor(Math.min(p[i * 2], p[i * 2 + 2]) / CELL);
      const x1 = Math.floor(Math.max(p[i * 2], p[i * 2 + 2]) / CELL);
      const z0 = Math.floor(Math.min(p[i * 2 + 1], p[i * 2 + 3]) / CELL);
      const z1 = Math.floor(Math.max(p[i * 2 + 1], p[i * 2 + 3]) / CELL);
      for (let cx = x0; cx <= x1; cx++)
        for (let cz = z0; cz <= z1; cz++) {
          const key = cx * 100003 + cz;
          let list = this.grid.get(key);
          if (!list) this.grid.set(key, (list = []));
          list.push(idx);
        }
    }
  }

  isWater(x: number, z: number): boolean {
    let inside = false;
    for (let k = 0; k < this.rings.length; k++) {
      const bx = this.ringBoxes[k];
      if (x < bx[0] || x > bx[2] || z < bx[1] || z > bx[3]) continue;
      const ring = this.rings[k];
      const n = ring.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = ring[i * 2];
        const zi = ring[i * 2 + 1];
        const xj = ring[j * 2];
        const zj = ring[j * 2 + 1];
        if (zi <= z !== zj <= z && x < xi + ((z - zi) / (zj - zi)) * (xj - xi)) inside = !inside;
      }
    }
    return inside;
  }

  /** Nearest bank point within `radius`, or null. Islands count as banks; the world edge does not. */
  nearestBank(x: number, z: number, radius: number): BankHit | null {
    const r = Math.ceil(radius / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best: BankHit | null = null;
    let bestD2 = radius * radius;
    // Segments spanning several cells are tested more than once; that is cheaper than a Set.
    for (let i = cx - r; i <= cx + r; i++)
      for (let j = cz - r; j <= cz + r; j++) {
        const list = this.grid.get(i * 100003 + j);
        if (!list) continue;
        for (const s of list) {
          const ax = this.segs[s * 4];
          const az = this.segs[s * 4 + 1];
          const ex = this.segs[s * 4 + 2] - ax;
          const ez = this.segs[s * 4 + 3] - az;
          const u = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
          const px = ax + ex * u;
          const pz = az + ez * u;
          const d2 = (px - x) ** 2 + (pz - z) ** 2;
          if (d2 < bestD2) {
            bestD2 = d2;
            const l = Math.hypot(ex, ez) || 1;
            best = { d: Math.sqrt(d2), x: px, z: pz, ux: ex / l, uz: ez / l };
          }
        }
      }
    return best;
  }

  /**
   * Sorted x intervals [x0, x1, x2, x3, ...] of water along the line z: water lies in
   * [x0, x1), [x2, x3), ... Used to fill masks a row at a time.
   */
  waterSpans(z: number): number[] {
    const xs: number[] = [];
    for (const r of this.rings) ringCrossings(r, z, xs);
    return xs.sort((a, b) => a - b);
  }

  /** Where the water crosses the line z, outermost banks only (for the backdrop frame). */
  edgeGap(z: number): XZ[] {
    const xs = this.waterSpans(z);
    return xs.length >= 2 ? [{ x: xs[0], z }, { x: xs[xs.length - 1], z }] : [];
  }
}
