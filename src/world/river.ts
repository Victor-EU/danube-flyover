// River geometry in local metres: the water polygon (banks minus islands), a point-in-water
// test, distance to the nearest bank, and scanline crossings for building grids.

import { latLonToLocal, type XZ } from "../geo";
import { EAST_BANK, ISLANDS, WEST_BANK, type LatLon } from "./osmPlaceholder";

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

function toFlat(points: readonly LatLon[]): Float64Array {
  const out = new Float64Array(points.length * 2);
  points.forEach((p, i) => {
    const l = latLonToLocal(p);
    out[i * 2] = l.x;
    out[i * 2 + 1] = l.z;
  });
  return out;
}

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

function bankAt(line: Float64Array, z: number): { x: number; ux: number; uz: number } {
  const n = line.length / 2;
  for (let i = 0; i < n - 1; i++) {
    const za = line[i * 2 + 1];
    const zb = line[i * 2 + 3];
    if ((za - z) * (zb - z) <= 0 && za !== zb) {
      const ex = line[i * 2 + 2] - line[i * 2];
      const ez = zb - za;
      const l = Math.hypot(ex, ez);
      return { x: line[i * 2] + ((z - za) / ez) * ex, ux: ex / l, uz: ez / l };
    }
  }
  return { x: line[z < line[1] ? 0 : (n - 1) * 2], ux: 0, uz: 1 };
}

function pointInRing(ring: Ring, x: number, z: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const zi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const zj = ring[j * 2 + 1];
    if (zi <= z !== zj <= z && x < xi + ((z - zi) / (zj - zi)) * (xj - xi)) inside = !inside;
  }
  return inside;
}

export class River {
  /** Buda and Pest banks, north to south. */
  readonly west: Float64Array;
  readonly east: Float64Array;
  readonly islands: Ring[];
  /** The water ring: west bank down, east bank back up. */
  private readonly ring: Ring;
  private readonly segs: number[] = []; // ax, az, bx, bz
  private readonly grid = new Map<number, number[]>();

  constructor() {
    this.west = toFlat(WEST_BANK);
    this.east = toFlat(EAST_BANK);
    this.islands = ISLANDS.map((i) => toFlat(i.outline));
    const nw = this.west.length / 2;
    const ne = this.east.length / 2;
    this.ring = new Float64Array((nw + ne) * 2);
    this.ring.set(this.west, 0);
    for (let i = 0; i < ne; i++) {
      this.ring[(nw + i) * 2] = this.east[(ne - 1 - i) * 2];
      this.ring[(nw + i) * 2 + 1] = this.east[(ne - 1 - i) * 2 + 1];
    }
    this.addPolyline(this.west, false);
    this.addPolyline(this.east, false);
    for (const r of this.islands) this.addPolyline(r, true);
  }

  private addPolyline(p: Float64Array, closed: boolean): void {
    const n = p.length / 2;
    const count = closed ? n : n - 1;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % n;
      const idx = this.segs.length / 4;
      this.segs.push(p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1]);
      const x0 = Math.floor(Math.min(p[i * 2], p[j * 2]) / CELL);
      const x1 = Math.floor(Math.max(p[i * 2], p[j * 2]) / CELL);
      const z0 = Math.floor(Math.min(p[i * 2 + 1], p[j * 2 + 1]) / CELL);
      const z1 = Math.floor(Math.max(p[i * 2 + 1], p[j * 2 + 1]) / CELL);
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
    if (!pointInRing(this.ring, x, z)) return false;
    for (const r of this.islands) if (pointInRing(r, x, z)) return false;
    return true;
  }

  /** Nearest bank point within `radius`, or null. Islands count as banks. */
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
    const river: number[] = [];
    ringCrossings(this.ring, z, river);
    river.sort((a, b) => a - b);
    const islands: number[] = [];
    for (const r of this.islands) ringCrossings(r, z, islands);
    if (islands.length === 0) return river;
    islands.sort((a, b) => a - b);
    // Subtract island intervals from river intervals.
    const out: number[] = [];
    for (let i = 0; i + 1 < river.length; i += 2) {
      let start = river[i];
      const end = river[i + 1];
      for (let k = 0; k + 1 < islands.length; k += 2) {
        const a = islands[k];
        const b = islands[k + 1];
        if (b <= start || a >= end) continue;
        if (a > start) out.push(start, a);
        start = Math.max(start, b);
      }
      if (start < end) out.push(start, end);
    }
    return out;
  }

  /** x of the Buda bank at z (first crossing). */
  westBankX(z: number): number {
    return bankAt(this.west, z).x;
  }

  /** x of the Pest bank at z (first crossing). */
  eastBankX(z: number): number {
    return bankAt(this.east, z).x;
  }

  /** Bank position and direction (north to south) at z on the given side. */
  bankAt(side: "west" | "east", z: number): { x: number; ux: number; uz: number } {
    return bankAt(side === "west" ? this.west : this.east, z);
  }

  /** Where the water ring crosses the world's north and south edges (for the backdrop frame). */
  edgeGap(z: number): XZ[] {
    const xs = this.waterSpans(z);
    return xs.length >= 2 ? [{ x: xs[0], z }, { x: xs[xs.length - 1], z }] : [];
  }
}
