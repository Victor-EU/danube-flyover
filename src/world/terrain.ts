// M0 terrain: flat Pest, a gentle Buda slope, and procedural stand-ins for Castle Hill and
// Gellért Hill, cut down below the water inside the river. Heights are metres above the river.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardMaterial,
} from "three";
import { WORLD } from "../config";
import { latLonToLocal, lonLatToLocal, type XZ } from "../geo";
import { LANDMARK_POINTS } from "./osmPlaceholder";
import type { River } from "./river";

export interface Bounds {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export function worldBounds(): Bounds {
  const nw = lonLatToLocal(WORLD.lonMin, WORLD.latMax);
  const se = lonLatToLocal(WORLD.lonMax, WORLD.latMin);
  return { x0: nw.x, x1: se.x, z0: nw.z, z1: se.z };
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Castle Hill: a capsule-shaped plateau along the hill's NNW-SSE axis.
const CASTLE_A = latLonToLocal([47.5047, 19.0328]);
const CASTLE_B = latLonToLocal([47.4952, 19.0393]);
const CASTLE = { height: 64, plateau: 120, slope: 150 };

// Gellért Hill: a mound peaking at the Citadella, steep toward the river, gentle away from it.
const GELLERT_PEAK = latLonToLocal(LANDMARK_POINTS.citadella);
const GELLERT = { height: 131, radiusNear: 420, radiusFar: 700 };
const GELLERT_AWAY = (() => {
  const toRiver = latLonToLocal([47.4875, 19.051]);
  const dx = toRiver.x - GELLERT_PEAK.x;
  const dz = toRiver.z - GELLERT_PEAK.z;
  const l = Math.hypot(dx, dz);
  return { x: -dx / l, z: -dz / l };
})();

export function castleAxisDistance(x: number, z: number): number {
  const ex = CASTLE_B.x - CASTLE_A.x;
  const ez = CASTLE_B.z - CASTLE_A.z;
  const u = Math.min(1, Math.max(0, ((x - CASTLE_A.x) * ex + (z - CASTLE_A.z) * ez) / (ex * ex + ez * ez)));
  return Math.hypot(CASTLE_A.x + ex * u - x, CASTLE_A.z + ez * u - z);
}

export function castleHill(x: number, z: number): number {
  const d = castleAxisDistance(x, z);
  return CASTLE.height * (1 - smoothstep(CASTLE.plateau, CASTLE.plateau + CASTLE.slope, d));
}

export function isCastlePlateau(x: number, z: number): boolean {
  return castleAxisDistance(x, z) < CASTLE.plateau - 10;
}

export function gellertHill(x: number, z: number): number {
  const dx = x - GELLERT_PEAK.x;
  const dz = z - GELLERT_PEAK.z;
  const r = Math.hypot(dx, dz);
  const away = r > 0 ? (dx * GELLERT_AWAY.x + dz * GELLERT_AWAY.z) / r : 0;
  const R = (GELLERT.radiusNear + GELLERT.radiusFar) / 2 + ((GELLERT.radiusFar - GELLERT.radiusNear) / 2) * away;
  if (r >= R) return 0;
  return GELLERT.height * Math.pow(1 - (r / R) ** 2, 1.5);
}

/** 0..1, how far up Gellért Hill a point is (for keeping it a park). */
export function gellertFactor(x: number, z: number): number {
  return gellertHill(x, z) / GELLERT.height;
}

const COLORS = {
  bed: new Color("#2f3f3d"),
  land: new Color("#b9ae97"),
  stone: new Color("#c4b48d"),
  park: new Color("#6f8f55"),
  island: new Color("#7c9f5b"),
};

export class Terrain {
  readonly cell = 12.5;
  readonly nx: number;
  readonly nz: number;
  readonly bounds: Bounds;
  readonly heights: Float32Array;
  readonly water: Uint8Array;
  private readonly river: River;

  constructor(river: River, bounds: Bounds) {
    this.river = river;
    this.bounds = bounds;
    this.nx = Math.ceil((bounds.x1 - bounds.x0) / this.cell) + 1;
    this.nz = Math.ceil((bounds.z1 - bounds.z0) / this.cell) + 1;
    this.heights = new Float32Array(this.nx * this.nz);
    this.water = new Uint8Array(this.nx * this.nz);
    for (let j = 0; j < this.nz; j++) {
      const z = bounds.z0 + j * this.cell;
      const spans = river.waterSpans(z);
      let k = 0;
      for (let i = 0; i < this.nx; i++) {
        const x = bounds.x0 + i * this.cell;
        while (k < spans.length && spans[k] <= x) k++;
        const wet = k % 2 === 1;
        const idx = j * this.nx + i;
        this.water[idx] = wet ? 1 : 0;
        this.heights[idx] = wet ? -3 : this.landHeight(x, z);
      }
    }
  }

  /** Analytic land height; the strip near the banks dips under the quay so the waterline stays crisp. */
  landHeight(x: number, z: number): number {
    const bank = this.river.nearestBank(x, z, 100);
    const d = bank ? bank.d : 100;
    if (d < 12) return -3;
    const near = -3 + (WORLD.landBase + 3) * smoothstep(12, 30, d);
    const fade = smoothstep(40, 90, d);
    let buda = 0;
    const wx = this.river.westBankX(z);
    if (x < wx) buda = Math.min(18, (wx - x) * 0.025);
    return near + fade * (castleHill(x, z) + gellertHill(x, z) + buda);
  }

  /** Bilinear height from the grid (fast; used for the floor grid and placing boxes). */
  heightAt(x: number, z: number): number {
    const fx = Math.min(Math.max((x - this.bounds.x0) / this.cell, 0), this.nx - 1.001);
    const fz = Math.min(Math.max((z - this.bounds.z0) / this.cell, 0), this.nz - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const h = this.heights;
    const a = h[j * this.nx + i];
    const b = h[j * this.nx + i + 1];
    const c = h[(j + 1) * this.nx + i];
    const d = h[(j + 1) * this.nx + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  buildMesh(isIsland: (p: XZ) => boolean): Mesh {
    const { nx, nz, cell, bounds } = this;
    const pos = new Float32Array(nx * nz * 3);
    const col = new Float32Array(nx * nz * 3);
    const c = new Color();
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const idx = j * nx + i;
        const x = bounds.x0 + i * cell;
        const z = bounds.z0 + j * cell;
        const h = this.heights[idx];
        pos.set([x, h, z], idx * 3);
        if (this.water[idx] || h < 0) c.copy(COLORS.bed);
        else if (isIsland({ x, z })) c.copy(COLORS.island);
        else {
          c.copy(COLORS.land);
          const castle = castleHill(x, z) / CASTLE.height;
          if (castle > 0.02) c.lerp(COLORS.stone, Math.min(1, castle * 1.5));
          const g = gellertFactor(x, z);
          if (g > 0.03) c.lerp(COLORS.park, Math.min(1, g * 4));
        }
        col.set([c.r, c.g, c.b], idx * 3);
      }
    const index = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let k = 0;
    for (let j = 0; j < nz - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const cc = a + nx;
        const d = cc + 1;
        index.set([a, cc, b, b, cc, d], k);
        k += 6;
      }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(pos, 3));
    geo.setAttribute("color", new BufferAttribute(col, 3));
    geo.setIndex(new BufferAttribute(index, 1));
    geo.computeVertexNormals();
    const mesh = new Mesh(geo, new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    mesh.receiveShadow = true;
    mesh.name = "terrain";
    return mesh;
  }
}
