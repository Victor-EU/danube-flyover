// M0 city stand-ins: flat-coloured filler blocks, simple landmark blocks at their real
// positions, instanced trees for the parks, and the quay strips along both banks.

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
} from "three";
import { WORLD } from "../config";
import { latLonToLocal, type XZ } from "../geo";
import type { Bridges } from "./bridges";
import { LANDMARK_POINTS, type LatLon } from "./osmPlaceholder";
import type { River } from "./river";
import {
  castleAxisDistance,
  gellertFactor,
  isCastlePlateau,
  type Bounds,
  type Terrain,
} from "./terrain";

/** A solid footprint for the floor grid: oriented box, top height above the river. */
export interface Solid {
  x: number;
  z: number;
  /** Half extents across (local x) and along (local z). */
  hw: number;
  hd: number;
  /** Rotation about Y (radians), as applied to the mesh. */
  rot: number;
  top: number;
}

interface Part {
  shape: "box" | "cyl" | "cone";
  w?: number;
  d?: number;
  r?: number;
  h: number;
  y?: number;
  along?: number;
  color: string;
}

interface LandmarkDef {
  at: LatLon;
  /** "bank": long axis along the nearest bank; "castle": along Castle Hill; or radians. */
  orient: "bank" | "castle" | number;
  parts: Part[];
}

const LANDMARKS: Record<string, LandmarkDef> = {
  parliament: {
    at: LANDMARK_POINTS.parliament,
    orient: "bank",
    parts: [
      { shape: "box", w: 118, d: 268, h: 34, color: "#e6dcc6" },
      { shape: "box", w: 64, d: 126, h: 44, color: "#e3d8c0" },
      { shape: "cyl", r: 21, h: 74, color: "#dcd0b6" },
      { shape: "cone", r: 23, h: 22, y: 74, color: "#8a3b33" },
    ],
  },
  academy: { at: LANDMARK_POINTS.academy, orient: "bank", parts: [{ shape: "box", w: 48, d: 72, h: 26, color: "#d8c7a6" }] },
  gresham: { at: LANDMARK_POINTS.gresham, orient: "bank", parts: [{ shape: "box", w: 60, d: 70, h: 30, color: "#d3c09d" }] },
  vigado: { at: LANDMARK_POINTS.vigado, orient: "bank", parts: [{ shape: "box", w: 42, d: 80, h: 26, color: "#e1d2b5" }] },
  matthias: {
    at: LANDMARK_POINTS.matthias,
    orient: "castle",
    parts: [
      { shape: "box", w: 30, d: 66, h: 26, color: "#e7e1d3" },
      { shape: "cyl", r: 7, h: 60, along: 24, color: "#e7e1d3" },
      { shape: "cone", r: 7.5, h: 18, y: 60, along: 24, color: "#7d6b4f" },
    ],
  },
  bastion: {
    at: LANDMARK_POINTS.bastion,
    orient: "castle",
    parts: [
      { shape: "box", w: 14, d: 150, h: 10, color: "#f0ebe0" },
      ...[-60, -30, 0, 30, 60].flatMap((a): Part[] => [
        { shape: "cyl", r: 5, h: 14, along: a, color: "#f0ebe0" },
        { shape: "cone", r: 6, h: 8, y: 14, along: a, color: "#b9b2a4" },
      ]),
    ],
  },
  palace: {
    at: LANDMARK_POINTS.palace,
    orient: "castle",
    parts: [
      { shape: "box", w: 90, d: 300, h: 36, color: "#d6c8a8" },
      { shape: "cyl", r: 15, h: 44, color: "#d6c8a8" },
      { shape: "cone", r: 17, h: 18, y: 44, color: "#7d9e8f" },
    ],
  },
  libertyStatue: {
    at: LANDMARK_POINTS.libertyStatue,
    orient: 0,
    parts: [
      { shape: "cyl", r: 4, h: 26, color: "#ddd7c7" },
      { shape: "box", w: 3, d: 3, h: 14, y: 26, color: "#6f6a5a" },
    ],
  },
  citadella: { at: LANDMARK_POINTS.citadella, orient: Math.PI / 2, parts: [{ shape: "box", w: 70, d: 200, h: 10, color: "#bfb193" }] },
  gellertHotel: { at: LANDMARK_POINTS.gellertHotel, orient: "bank", parts: [{ shape: "box", w: 60, d: 110, h: 30, color: "#e0d3b5" }] },
  marketHall: {
    at: LANDMARK_POINTS.marketHall,
    orient: Math.PI / 2,
    parts: [
      { shape: "box", w: 62, d: 150, h: 22, color: "#d9b88d" },
      { shape: "box", w: 50, d: 146, h: 9, y: 22, color: "#b5653a" },
    ],
  },
  shoes: { at: LANDMARK_POINTS.shoes, orient: "bank", parts: [{ shape: "box", w: 1.5, d: 40, h: 1.2, color: "#3a3530" }] },
};

/** Open squares and parks kept free of filler blocks: centre and radius. */
const OPEN_SPACES: [LatLon, number][] = [
  [[47.5072, 19.0478], 110], // Kossuth tér
  [[47.4998, 19.0466], 50], // Széchenyi tér
  [[47.4963, 19.049], 35], // Vigadó tér
  [[47.487, 19.0571], 70], // Fővám tér
  [[47.4984, 19.04], 50], // Clark Ádám tér
  [[47.5065, 19.039], 50], // Batthyány tér
  [[47.4922, 19.0518], 60], // Március 15. tér
  [[47.4935, 19.0405], 190], // Tabán
  [[47.4842, 19.0525], 50], // Szent Gellért tér
];

const PALETTES = {
  pest: ["#d9c9a8", "#cdb48c", "#e0d4b8", "#c8a984", "#d4bfa0", "#bfa98a"],
  buda: ["#d8cdb5", "#c9b99c", "#bfae8f", "#d1c4a6"],
  castle: ["#e2d8c2", "#d5c7a6", "#cbbd9d"],
};

/** Small deterministic PRNG so the grey box is the same every load. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class City {
  readonly group = new Group();
  readonly solids: Solid[] = [];
  private readonly river: River;
  private readonly terrain: Terrain;
  private readonly rand = mulberry32(1873);
  private readonly castleRot: number;
  private readonly landmarkZones: { p: XZ; r: number }[] = [];

  constructor(river: River, terrain: Terrain, bridges: Bridges, bounds: Bounds) {
    this.river = river;
    this.terrain = terrain;
    const a = latLonToLocal([47.5047, 19.0328]);
    const b = latLonToLocal([47.4952, 19.0393]);
    this.castleRot = Math.atan2(b.x - a.x, b.z - a.z);

    this.buildLandmarks();
    this.buildFiller(bridges, bounds);
    this.buildTrees(bounds);
    this.group.add(this.buildQuays());
    this.group.add(this.buildPond());
  }

  private ground(x: number, z: number): number {
    return Math.max(this.terrain.heightAt(x, z), WORLD.landBase);
  }

  private buildLandmarks(): void {
    for (const def of Object.values(LANDMARKS)) {
      const c = latLonToLocal(def.at);
      let rot: number;
      if (def.orient === "bank") {
        const hit = this.river.nearestBank(c.x, c.z, 600);
        rot = hit ? Math.atan2(hit.ux, hit.uz) : 0;
      } else if (def.orient === "castle") rot = this.castleRot;
      else rot = def.orient;
      const base = def === LANDMARKS.shoes ? WORLD.quayHeight : this.ground(c.x, c.z);
      let radius = 0;
      for (const part of def.parts) {
        const mat = new MeshStandardMaterial({ color: part.color, roughness: 0.85, flatShading: true });
        const y0 = base + (part.y ?? 0);
        let mesh: Mesh;
        if (part.shape === "box") {
          mesh = new Mesh(new BoxGeometry(part.w, part.h, part.d), mat);
        } else if (part.shape === "cyl") {
          mesh = new Mesh(new CylinderGeometry(part.r! * 0.92, part.r, part.h, 12), mat);
        } else {
          mesh = new Mesh(new ConeGeometry(part.r, part.h, 12), mat);
        }
        const along = part.along ?? 0;
        const px = c.x + Math.sin(rot) * along;
        const pz = c.z + Math.cos(rot) * along;
        mesh.position.set(px, y0 + part.h / 2, pz);
        mesh.rotation.y = rot;
        mesh.castShadow = mesh.receiveShadow = true;
        this.group.add(mesh);
        const hw = part.shape === "box" ? part.w! / 2 : part.r!;
        const hd = part.shape === "box" ? part.d! / 2 : part.r!;
        this.solids.push({ x: px, z: pz, hw, hd, rot, top: y0 + part.h });
        radius = Math.max(radius, Math.hypot(hw, hd) + Math.abs(along));
      }
      this.landmarkZones.push({ p: c, r: radius + 15 });
    }
  }

  private buildFiller(bridges: Bridges, bounds: Bounds): void {
    const open = OPEN_SPACES.map(([p, r]) => ({ p: latLonToLocal(p), r }));
    const spacing = 52;
    const boxes: { x: number; z: number; w: number; d: number; h: number; base: number; rot: number; color: Color }[] = [];
    for (let z = bounds.z0 + 30; z < bounds.z1 - 30; z += spacing)
      for (let x = bounds.x0 + 30; x < bounds.x1 - 30; x += spacing) {
        const px = x + (this.rand() - 0.5) * 14;
        const pz = z + (this.rand() - 0.5) * 14;
        const w = 26 + this.rand() * 14;
        const d = 30 + this.rand() * 16;
        const half = Math.hypot(w, d) / 2;
        if (this.river.isWater(px, pz)) continue;
        const bank = this.river.nearestBank(px, pz, 45 + half);
        if (bank) continue;
        if (this.inIsland(px, pz)) continue;
        if (open.some((o) => Math.hypot(px - o.p.x, pz - o.p.z) < o.r + half * 0.5)) continue;
        if (this.landmarkZones.some((o) => Math.hypot(px - o.p.x, pz - o.p.z) < o.r + half)) continue;
        if (bridges.onFootprint(px, pz, half + 8)) continue;
        if (gellertFactor(px, pz) > 0.08) continue;
        const axis = castleAxisDistance(px, pz);
        const plateau = isCastlePlateau(px, pz);
        if (!plateau && axis < 270) continue; // Castle Hill slopes stay green
        const pest = px > this.river.eastBankX(pz);
        const side = this.river.bankAt(pest ? "east" : "west", pz);
        const fromBank = Math.abs(px - side.x);
        if (fromBank > (pest ? 1100 : 1050)) continue;
        // Skip steep ground.
        const g = this.terrain;
        const slope = Math.abs(g.heightAt(px + 10, pz) - g.heightAt(px - 10, pz)) / 20 + Math.abs(g.heightAt(px, pz + 10) - g.heightAt(px, pz - 10)) / 20;
        if (!plateau && slope > 0.35) continue;

        let h: number;
        let palette: string[];
        if (plateau) {
          h = 8 + this.rand() * 6;
          palette = PALETTES.castle;
        } else if (pest) {
          h = fromBank < 200 ? 24 + this.rand() * 10 : 16 + this.rand() * 12;
          palette = PALETTES.pest;
        } else {
          h = 12 + this.rand() * 10;
          palette = PALETTES.buda;
        }
        const base = Math.min(
          this.ground(px, pz),
          this.ground(px - w / 2, pz - d / 2),
          this.ground(px + w / 2, pz + d / 2),
        );
        const rot = Math.atan2(side.ux, side.uz) + (this.rand() - 0.5) * 0.06;
        boxes.push({ x: px, z: pz, w, d, h, base, rot, color: new Color(palette[Math.floor(this.rand() * palette.length)]) });
        this.solids.push({ x: px, z: pz, hw: w / 2, hd: d / 2, rot, top: base + h });
      }

    const geo = new BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const mesh = new InstancedMesh(geo, new MeshStandardMaterial({ roughness: 0.9 }), boxes.length);
    const o = new Object3D();
    boxes.forEach((b, i) => {
      o.position.set(b.x, b.base, b.z);
      o.rotation.set(0, b.rot, 0);
      o.scale.set(b.w, b.h, b.d);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
      mesh.setColorAt(i, b.color);
    });
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = "filler";
    this.group.add(mesh);
  }

  inIsland(x: number, z: number): boolean {
    return !this.river.isWater(x, z) && this.river.islands.some((r) => ringContains(r, x, z));
  }

  private buildTrees(bounds: Bounds): void {
    const pts: { x: number; z: number; s: number }[] = [];
    const pond = latLonToLocal(LANDMARK_POINTS.japaneseGarden);
    const peak = latLonToLocal(LANDMARK_POINTS.citadella);
    const statue = latLonToLocal(LANDMARK_POINTS.libertyStatue);
    const taban = latLonToLocal([47.4935, 19.0405]);
    const step = 22;
    for (let z = bounds.z0; z < bounds.z1; z += step)
      for (let x = bounds.x0; x < bounds.x1; x += step) {
        const px = x + (this.rand() - 0.5) * 16;
        const pz = z + (this.rand() - 0.5) * 16;
        if (this.river.isWater(px, pz)) continue;
        const island = this.inIsland(px, pz);
        const gellert = gellertFactor(px, pz) > 0.06;
        const axis = castleAxisDistance(px, pz);
        const castleSlope = axis > 125 && axis < 255;
        const inTaban = Math.hypot(px - taban.x, pz - taban.z) < 170;
        if (!(island || gellert || castleSlope || inTaban)) continue;
        if (this.river.nearestBank(px, pz, 44)) continue;
        if (Math.hypot(px - pond.x, pz - pond.z) < 45) continue;
        if (Math.hypot(px - peak.x, pz - peak.z) < 120 || Math.hypot(px - statue.x, pz - statue.z) < 40) continue;
        if (this.landmarkZones.some((o) => Math.hypot(px - o.p.x, pz - o.p.z) < o.r)) continue;
        if (!island && this.rand() < 0.25) continue;
        pts.push({ x: px, z: pz, s: 0.7 + this.rand() * 0.65 });
      }
    const geo = new ConeGeometry(4.5, 11, 7);
    geo.translate(0, 5.5 + 2, 0);
    const mesh = new InstancedMesh(geo, new MeshStandardMaterial({ roughness: 0.95, flatShading: true }), pts.length);
    const m = new Matrix4();
    const greens = ["#5f7f45", "#6b8a4c", "#55743f", "#748f52"].map((c) => new Color(c));
    pts.forEach((p, i) => {
      m.makeScale(p.s, p.s * (0.85 + this.rand() * 0.4), p.s);
      m.setPosition(p.x, this.ground(p.x, p.z), p.z);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, greens[i % greens.length]);
    });
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = "trees";
    this.group.add(mesh);
  }

  /** Quay walls at the waterline and a stone strip on the land side, so the banks read crisply. */
  private buildQuays(): Mesh {
    const pos: number[] = [];
    const col: number[] = [];
    const wall = new Color("#a89c80");
    const top = new Color("#cbbf9f");
    const quad = (a: number[], b: number[], c: number[], d: number[], colr: Color) => {
      pos.push(...a, ...b, ...c, ...a, ...c, ...d);
      for (let i = 0; i < 6; i++) col.push(colr.r, colr.g, colr.b);
    };
    const lines: { p: Float64Array; closed: boolean }[] = [
      { p: this.river.west, closed: false },
      { p: this.river.east, closed: false },
      ...this.river.islands.map((p) => ({ p, closed: true })),
    ];
    const H = WORLD.quayHeight;
    const W = WORLD.quayWidth;
    for (const { p, closed } of lines) {
      const n = p.length / 2;
      const normals: XZ[] = [];
      for (let i = 0; i < n; i++) {
        const a = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
        const b = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
        const tx = p[b * 2] - p[a * 2];
        const tz = p[b * 2 + 1] - p[a * 2 + 1];
        const l = Math.hypot(tx, tz) || 1;
        let nx = -tz / l;
        let nz = tx / l;
        if (this.river.isWater(p[i * 2] + nx * 8, p[i * 2 + 1] + nz * 8)) {
          nx = -nx;
          nz = -nz;
        }
        normals.push({ x: nx, z: nz });
      }
      const count = closed ? n : n - 1;
      for (let i = 0; i < count; i++) {
        const j = (i + 1) % n;
        const ax = p[i * 2];
        const az = p[i * 2 + 1];
        const bx = p[j * 2];
        const bz = p[j * 2 + 1];
        const na = normals[i];
        const nb = normals[j];
        const ia = [ax + na.x * W, az + na.z * W];
        const ib = [bx + nb.x * W, bz + nb.z * W];
        // Land can be on either side of a polyline, so the quay material is double-sided.
        quad([ax, H, az], [bx, H, bz], [ib[0], H, ib[1]], [ia[0], H, ia[1]], top); // strip
        quad([ax, -3, az], [bx, -3, bz], [bx, H, bz], [ax, H, az], wall); // wall, water side
        quad([ia[0], H, ia[1]], [ib[0], H, ib[1]], [ib[0], 0, ib[1]], [ia[0], 0, ia[1]], wall); // inner edge
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute("color", new BufferAttribute(new Float32Array(col), 3));
    geo.computeVertexNormals();
    const mesh = new Mesh(
      geo,
      new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true, side: DoubleSide }),
    );
    mesh.receiveShadow = true;
    mesh.name = "quays";
    return mesh;
  }

  private buildPond(): Mesh {
    const p = latLonToLocal(LANDMARK_POINTS.japaneseGarden);
    const mesh = new Mesh(
      new CircleGeometry(28, 24),
      new MeshStandardMaterial({ color: "#2c5562", roughness: 0.3 }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(p.x, this.ground(p.x, p.z) + 0.08, p.z);
    mesh.receiveShadow = true;
    return mesh;
  }
}

function ringContains(ring: Float64Array, x: number, z: number): boolean {
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
