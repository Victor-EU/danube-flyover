// The Danube bridges from public/data/bridges.json (built by tools/build-bridges.ts from
// OpenStreetMap): deck slabs on their real outlines, river piers, placeholder towers and
// ironwork until M4's hero models, plus the queries the vehicles need (deck under/over,
// solid obstacles). The deck sits at full height over the water and the quays, then ramps
// down to street level on land.

import earcut from "earcut";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Group,
  Mesh,
  MeshStandardMaterial,
  TubeGeometry,
  Vector3,
} from "three";
import { WORLD } from "../config";
import type { XZ } from "../geo";
import type { River } from "./river";
import type { Terrain } from "./terrain";

export interface BridgeJson {
  name: string;
  osm: string;
  /** Deck outline ring, flat [x, z, ...]. */
  outline: number[];
  /** Road centreline, Buda to Pest, flat [x, z, ...]. */
  axis: number[];
  width: number;
  /** Deck top over the water, metres above the river. */
  top: number;
  thickness: number;
  ramp: number;
  color: string;
  deckColor: string;
  /** Tower centres on the deck, with the deck direction there. */
  towers: { x: number; z: number; ux: number; uz: number }[];
  tower?: { height: number; along: number; thick: number };
  /** River piers as oriented boxes (half extents along u and across it). */
  piers: { cx: number; cz: number; ux: number; uz: number; halfU: number; halfV: number }[];
  cables?: "chain" | "suspension" | "truss";
}

export interface BridgesJson {
  license: string;
  bridges: BridgeJson[];
}

/** A solid block in the water or on the deck (oriented box footprint). */
export interface Obstacle {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  halfAlong: number;
  halfAcross: number;
  top: number;
  /** Towers rise above the deck and go into the floor grid; piers stay under it. */
  tower: boolean;
}

export interface DeckHit {
  bridge: number;
  underside: number;
  top: number;
}

/** Over land the deck stays level this far past the bank (over the quay road), then descends. */
const LEVEL_PAST_BANK = 30;
const RAMP_SLOPE = 0.09;

interface Deck {
  def: BridgeJson;
  ring: Float64Array;
  box: [number, number, number, number];
}

/** What the night lights hang on a bridge (browser only). */
export interface BridgeLights {
  name: string;
  /** The tower, pier and cable material, and the chains' own (Chain Bridge). */
  material: MeshStandardMaterial;
  chain: MeshStandardMaterial | null;
  /** Cable or chain curves, one per side. */
  cables: Vector3[][];
  /** Lamp posts along both deck edges where the deck is at full height, every ~22 m. */
  deckLamps: Vector3[];
  /** Tower tops and bases, for the floodlights' height range. */
  towerTop: number;
}

export class Bridges {
  readonly group = new Group();
  readonly obstacles: Obstacle[] = [];
  readonly names: string[];
  readonly lights: BridgeLights[] = [];
  private readonly decks: Deck[];

  constructor(data: BridgesJson, private readonly river: River, private readonly terrain: Terrain, withMeshes = true) {
    this.names = data.bridges.map((b) => b.name);
    this.decks = data.bridges.map((def) => {
      const ring = Float64Array.from(def.outline);
      const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < ring.length; i += 2) {
        box[0] = Math.min(box[0], ring[i]);
        box[1] = Math.min(box[1], ring[i + 1]);
        box[2] = Math.max(box[2], ring[i]);
        box[3] = Math.max(box[3], ring[i + 1]);
      }
      return { def, ring, box };
    });
    for (const d of this.decks) this.build(d, withMeshes);
  }

  /** Deck top at (x, z) for a bridge: full height over the water, ramping to the street on land. */
  topAt(def: BridgeJson, x: number, z: number): number {
    if (this.river.isWater(x, z)) return def.top;
    // Past this distance from the bank every deck has reached the street.
    const reach = LEVEL_PAST_BANK + def.top / RAMP_SLOPE;
    const d = this.river.nearestBank(x, z, reach)?.d ?? reach;
    const ground = Math.max(this.terrain.heightAt(x, z), WORLD.quayHeight) + 0.3;
    return Math.max(ground, def.top - RAMP_SLOPE * Math.max(0, d - LEVEL_PAST_BANK));
  }

  private build(deck: Deck, withMeshes: boolean): void {
    const def = deck.def;
    const mat = new MeshStandardMaterial({ color: def.color, roughness: 0.7, flatShading: true });
    if (withMeshes) {
      const m = new Mesh(this.deckGeometry(def), new MeshStandardMaterial({ color: def.deckColor, roughness: 0.8, flatShading: true }));
      m.castShadow = m.receiveShadow = true;
      m.name = def.name;
      this.group.add(m);
      this.lights.push({ name: def.name, material: mat, chain: null, cables: [], deckLamps: this.deckLamps(def), towerTop: def.tower?.height ?? def.top + 8 });
    }

    for (const p of def.piers) {
      const underside = this.topAt(def, p.cx, p.cz) - def.thickness;
      this.addBlock(mat, p.cx, p.cz, p.ux, p.uz, p.halfU * 2, p.halfV * 2, -2, underside, false, withMeshes);
    }

    const tw = def.tower;
    if (!tw) return;
    // Order the towers Buda to Pest along the axis, for the cables.
    const a0 = { x: def.axis[0], z: def.axis[1] };
    const towers = [...def.towers].sort((p, q) => Math.hypot(p.x - a0.x, p.z - a0.z) - Math.hypot(q.x - a0.x, q.z - a0.z));
    for (const t of towers) {
      const off = def.width / 2 + tw.thick / 2;
      for (const side of [-1, 1])
        this.addBlock(mat, t.x - t.uz * off * side, t.z + t.ux * off * side, t.ux, t.uz, tw.along, tw.thick, -2, tw.height, true, withMeshes);
      if (withMeshes) {
        const lintel = new Mesh(new BoxGeometry(def.width + tw.thick * 2, 4, tw.along), mat);
        lintel.position.set(t.x, tw.height - 2, t.z);
        lintel.rotation.y = Math.atan2(t.ux, t.uz);
        lintel.castShadow = true;
        this.group.add(lintel);
      }
    }
    if (withMeshes && def.cables && towers.length === 2) this.addCables(def, towers, mat);
  }

  /** The deck slab: the outline triangulated with extra points so the ramps bend smoothly. */
  private deckGeometry(def: BridgeJson): BufferGeometry {
    const ring: XZ[] = [];
    const n = def.outline.length / 2;
    for (let i = 0; i < n; i++) {
      const a = { x: def.outline[i * 2], z: def.outline[i * 2 + 1] };
      const b = { x: def.outline[((i + 1) % n) * 2], z: def.outline[((i + 1) % n) * 2 + 1] };
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 4));
      for (let k = 0; k < steps; k++) ring.push({ x: a.x + ((b.x - a.x) * k) / steps, z: a.z + ((b.z - a.z) * k) / steps });
    }
    const flat: number[] = [];
    for (const p of ring) flat.push(p.x, p.z);
    const holes: number[] = [];
    const inside = (x: number, z: number) => {
      let r = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = def.outline[i * 2];
        const zi = def.outline[i * 2 + 1];
        const xj = def.outline[j * 2];
        const zj = def.outline[j * 2 + 1];
        if (zi <= z !== zj <= z && x < xi + ((z - zi) / (zj - zi)) * (xj - xi)) r = !r;
      }
      return r;
    };
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const p of ring) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    for (let z = Math.ceil(minZ / 6) * 6; z < maxZ; z += 6)
      for (let x = Math.ceil(minX / 6) * 6; x < maxX; x += 6) {
        if (!inside(x, z)) continue;
        if (ring.some((p) => Math.hypot(p.x - x, p.z - z) < 2.5)) continue;
        holes.push(flat.length / 2);
        flat.push(x, z);
      }
    const tris = earcut(flat, holes, 2);
    const top = (k: number) => this.topAt(def, flat[k * 2], flat[k * 2 + 1]);
    const tops = Array.from({ length: flat.length / 2 }, (_, k) => top(k));
    const pos: number[] = [];
    const vtx = (k: number, dy: number) => pos.push(flat[k * 2], tops[k] + dy, flat[k * 2 + 1]);
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
      const cross = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
      const [p, q] = cross < 0 ? [b, c] : [c, b]; // top faces up
      vtx(a, 0), vtx(p, 0), vtx(q, 0);
      vtx(a, -def.thickness), vtx(q, -def.thickness), vtx(p, -def.thickness);
    }
    // Side faces along the outline (the first ring.length points of `flat`), wound to face out.
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
    for (let i = 0; i < ring.length; i++) {
      let j = (i + 1) % ring.length;
      let k = i;
      if (area < 0) [k, j] = [j, k];
      const [xa, za, xb, zb] = [flat[k * 2], flat[k * 2 + 1], flat[j * 2], flat[j * 2 + 1]];
      const [ta, tb] = [tops[k], tops[j]];
      const [ba, bb] = [ta - def.thickness, tb - def.thickness];
      pos.push(xa, ba, za, xb, tb, zb, xb, bb, zb, xa, ba, za, xa, ta, za, xb, tb, zb);
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
    geo.computeVertexNormals();
    return geo;
  }

  private addBlock(mat: MeshStandardMaterial, cx: number, cz: number, ux: number, uz: number, along: number, across: number, y0: number, y1: number, tower: boolean, withMesh: boolean): void {
    if (withMesh) {
      const m = new Mesh(new BoxGeometry(across, y1 - y0, along), mat);
      m.position.set(cx, (y0 + y1) / 2, cz);
      // Box depth (local z) runs along (ux, uz).
      m.rotation.y = Math.atan2(ux, uz);
      m.castShadow = m.receiveShadow = true;
      this.group.add(m);
    }
    this.obstacles.push({ cx, cz, ux, uz, halfAlong: along / 2, halfAcross: across / 2, top: y1, tower });
  }

  private addCables(def: BridgeJson, towers: BridgeJson["towers"], mat0: MeshStandardMaterial): void {
    const tw = def.tower!;
    // Deck ends: where the axis first and last reaches full deck height.
    const axis: XZ[] = [];
    for (let i = 0; i < def.axis.length / 2 - 1; i++) {
      const a = { x: def.axis[i * 2], z: def.axis[i * 2 + 1] };
      const b = { x: def.axis[i * 2 + 2], z: def.axis[i * 2 + 3] };
      const l = Math.hypot(b.x - a.x, b.z - a.z);
      for (let d = 0; d < l; d += 2) axis.push({ x: a.x + ((b.x - a.x) * d) / l, z: a.z + ((b.z - a.z) * d) / l });
    }
    const full = axis.filter((p) => this.topAt(def, p.x, p.z) > def.top - 0.5);
    if (full.length < 2) return;
    const ends = [full[0], full[full.length - 1]];
    const anchors = [ends[0], towers[0], towers[1], ends[1]];
    const deckY = def.top + 1;
    const peakY = def.cables === "truss" ? def.top + 14 : tw.height - 3;
    const lowY = def.cables === "truss" ? def.top + 2.5 : deckY + 2;
    const mat = def.cables === "chain" ? new MeshStandardMaterial({ color: "#3b3a37", roughness: 0.6, flatShading: true }) : mat0;
    const lights = this.lights.find((l) => l.name === def.name)!;
    if (def.cables === "chain") lights.chain = mat;
    const ux = towers[0].ux;
    const uz = towers[0].uz;
    for (const side of [-1, 1]) {
      const off = def.width / 2 + 0.6;
      const pts: Vector3[] = [];
      for (let k = 0; k < 3; k++) {
        const a = anchors[k];
        const b = anchors[k + 1];
        const ya = k === 0 ? deckY : peakY;
        const yb = k === 2 ? deckY : peakY;
        for (let i = k === 0 ? 0 : 1; i <= 12; i++) {
          const u = i / 12;
          const sag = (k === 1 ? peakY - lowY : (peakY - deckY) * 0.35) * 4 * u * (1 - u);
          pts.push(new Vector3(a.x + (b.x - a.x) * u - uz * off * side, ya + (yb - ya) * u - sag, a.z + (b.z - a.z) * u + ux * off * side));
        }
      }
      lights.cables.push(pts);
      const tube = new Mesh(new TubeGeometry(new CatmullRomCurve3(pts), 120, def.cables === "chain" ? 0.7 : 0.5, 5), mat);
      tube.castShadow = true;
      this.group.add(tube);
    }
  }

  /** Lamp positions along both edges of the deck's level span, 5 m above the deck. */
  private deckLamps(def: BridgeJson): Vector3[] {
    const out: Vector3[] = [];
    const STEP = 22;
    for (const side of [-1, 1]) {
      let next = STEP / 2;
      let run = 0;
      for (let i = 0; i < def.axis.length / 2 - 1; i++) {
        const ax = def.axis[i * 2];
        const az = def.axis[i * 2 + 1];
        const ex = def.axis[i * 2 + 2] - ax;
        const ez = def.axis[i * 2 + 3] - az;
        const l = Math.hypot(ex, ez);
        if (l < 0.01) continue;
        const nx = -ez / l;
        const nz = ex / l;
        while (next <= run + l) {
          const t = (next - run) / l;
          const x = ax + ex * t + nx * side * (def.width / 2 - 0.6);
          const z = az + ez * t + nz * side * (def.width / 2 - 0.6);
          const top = this.topAt(def, x, z);
          if (top > def.top - 0.5) out.push(new Vector3(x, top + 5, z));
          next += STEP;
        }
        run += l;
      }
    }
    return out;
  }

  /** The deck over (x, z), its outline grown by `margin`, if any. */
  deckAt(x: number, z: number, margin: number): DeckHit | null {
    for (let id = 0; id < this.decks.length; id++) {
      const { def, ring, box } = this.decks[id];
      if (x < box[0] - margin || x > box[2] + margin || z < box[1] - margin || z > box[3] + margin) continue;
      if (!inRing(ring, x, z) && (margin <= 0 || ringDistance(ring, x, z) > margin)) continue;
      const top = this.topAt(def, x, z);
      return { bridge: id, underside: top - def.thickness, top };
    }
    return null;
  }

  /** Distance ahead (along fx, fz) to the nearest deck within `range`, or null. */
  deckAhead(x: number, z: number, fx: number, fz: number, range: number): (DeckHit & { dist: number }) | null {
    for (let d = 0; d <= range; d += 4) {
      const hit = this.deckAt(x + fx * d, z + fz * d, 0);
      if (hit) return { ...hit, dist: d };
    }
    return null;
  }

  /** True if (x, z) is within `margin` of any deck outline. */
  onFootprint(x: number, z: number, margin: number): boolean {
    return this.deckAt(x, z, margin) !== null;
  }

  /** Push (x, z) out of any obstacle whose top is above `y`. Returns the push or null. */
  pushOut(x: number, z: number, y: number, margin: number): XZ | null {
    for (const o of this.obstacles) {
      if (y > o.top) continue;
      const rx = x - o.cx;
      const rz = z - o.cz;
      const a = rx * o.ux + rz * o.uz;
      const b = -rx * o.uz + rz * o.ux;
      const pa = o.halfAlong + margin - Math.abs(a);
      const pb = o.halfAcross + margin - Math.abs(b);
      if (pa <= 0 || pb <= 0) continue;
      if (pa < pb) return { x: o.ux * pa * Math.sign(a || 1), z: o.uz * pa * Math.sign(a || 1) };
      return { x: -o.uz * pb * Math.sign(b || 1), z: o.ux * pb * Math.sign(b || 1) };
    }
    return null;
  }
}

function inRing(ring: Float64Array, x: number, z: number): boolean {
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

function ringDistance(ring: Float64Array, x: number, z: number): number {
  let best = Infinity;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = ring[j * 2];
    const az = ring[j * 2 + 1];
    const ex = ring[i * 2] - ax;
    const ez = ring[i * 2 + 1] - az;
    const t = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
    best = Math.min(best, Math.hypot(ax + ex * t - x, az + ez * t - z));
  }
  return best;
}
