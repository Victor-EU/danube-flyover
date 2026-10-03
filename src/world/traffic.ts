// Cars (tools/build-ground.ts): the parked ones along the side streets' kerbs
// (ground/parked.bin) and the traffic on the main roads (ground/traffic.json), which wanders
// the road graph, keeping right and taking a random road at each junction, with its head and
// tail lamps lit after dusk. Five body types are lofted in code from a side profile and a
// narrower glasshouse; each instance has its own paint. Only the cars in or near the view,
// within DRAW m, are drawn, re-sorted a few times a second like the trees.

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Frustum,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  type PerspectiveCamera,
  Quaternion,
  Sphere,
  type Texture,
  Vector3,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { SHARED } from "./night";
import { patchMaterial } from "./shaderPatch";
import type { Terrain } from "./terrain";

export interface TrafficJson {
  ways: { pts: number[]; fwd: number; back: number; laneW: number }[];
}

/** Length, width, beltline, roof height, bonnet and boot heights, and where the roof starts and ends (shares of the length). */
interface Body {
  name: string;
  L: number;
  W: number;
  belt: number;
  roof: number;
  nose: number;
  tail: number;
  roofFrom: number;
  roofTo: number;
  glassFrom: number;
  glassTo: number;
}
const BODIES: Body[] = [
  { name: "saloon", L: 4.7, W: 1.82, belt: 0.92, roof: 1.45, nose: 0.78, tail: 0.98, roofFrom: 0.38, roofTo: 0.72, glassFrom: 0.28, glassTo: 0.84 },
  { name: "hatch", L: 4.1, W: 1.76, belt: 0.95, roof: 1.48, nose: 0.8, tail: 1.3, roofFrom: 0.35, roofTo: 0.86, glassFrom: 0.27, glassTo: 0.94 },
  { name: "suv", L: 4.6, W: 1.88, belt: 1.08, roof: 1.68, nose: 0.98, tail: 1.5, roofFrom: 0.33, roofTo: 0.9, glassFrom: 0.25, glassTo: 0.95 },
  { name: "van", L: 5.2, W: 1.95, belt: 1.12, roof: 2.15, nose: 1.0, tail: 2.1, roofFrom: 0.2, roofTo: 0.98, glassFrom: 0.12, glassTo: 0.3 },
  { name: "bus", L: 12, W: 2.55, belt: 1.25, roof: 3.05, nose: 2.95, tail: 3.0, roofFrom: 0.02, roofTo: 0.98, glassFrom: 0.02, glassTo: 0.98 },
];
/** Paint (sRGB) with weights: the white, grey and black most streets are full of. */
const PAINT: [string, number][] = [
  ["#e8e8e6", 5], ["#1b1c1e", 4], ["#a7aaad", 4], ["#5e6266", 3], ["#22324d", 2], ["#7a1b1b", 1], ["#b02a24", 1],
  ["#c9c0ab", 1], ["#2d4a3a", 1], ["#8fa4b8", 1], ["#3a3a40", 2], ["#e0d9c8", 1],
];
const BUS = "#1f5aa6";
const DRAW = 650;
const RESORT = 0.15;
const MOVING = 1400;

/** A car body lofted along its length from the profile; `lamp` marks the head (1) and tail (2) lamps. */
function carGeometry(b: Body): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const pos: number[] = [];
  const col: number[] = [];
  const lamp: number[] = [];
  const N = 14;
  const glassCol = [0.07, 0.08, 0.09];
  // Top line along the length (from the front, z = -L/2).
  const top = (t: number) => {
    if (t < b.glassFrom) return b.nose + (b.belt - b.nose) * (t / b.glassFrom) * 0.4;
    if (t < b.roofFrom) return b.belt + (b.roof - b.belt) * ((t - b.glassFrom) / (b.roofFrom - b.glassFrom));
    if (t <= b.roofTo) return b.roof;
    if (t < b.glassTo) return b.roof + (b.belt - b.roof) * ((t - b.roofTo) / (b.glassTo - b.roofTo));
    return b.belt + (b.tail - b.belt) * ((t - b.glassTo) / (1 - b.glassTo + 1e-6)) * 0.6;
  };
  const section = (t: number) => {
    const z = -b.L / 2 + t * b.L;
    const y = top(t);
    const glass = y > b.belt + 0.02;
    const end = Math.min(t, 1 - t) < 0.04 ? 0.92 : 1;
    const w = (b.W / 2) * end;
    const wr = glass ? w * (b.name === "bus" || b.name === "van" ? 0.97 : 0.8) : w;
    const yb = Math.min(y, b.belt);
    // Bottom, sill, beltline, roof edge: a ring of six points (x, y).
    return { z, pts: [[-w, 0.32], [w, 0.32], [w, yb], [wr, y], [-wr, y], [-w, yb]] as [number, number][], glass };
  };
  const secs = Array.from({ length: N + 1 }, (_, k) => section(k / N));
  for (let k = 0; k < N; k++) {
    const a = secs[k];
    const c = secs[k + 1];
    for (let i = 0; i < 6; i++) {
      const j = (i + 1) % 6;
      const isGlass = (i === 2 || i === 4) && a.glass && c.glass;
      const colour = isGlass ? glassCol : [1, 1, 1];
      const quad = [[a.pts[i], a.z], [c.pts[i], c.z], [c.pts[j], c.z], [a.pts[j], a.z]] as [[number, number], number][];
      for (const q of [0, 2, 1, 0, 3, 2]) {
        const [[x, y], z] = quad[q];
        pos.push(x, y, z);
        col.push(...colour);
        lamp.push(0);
      }
    }
  }
  // End caps (front and back), with the lamps in them.
  for (const [s, front] of [[secs[0], true], [secs[N], false]] as const) {
    const p = s.pts;
    for (const tri of [[0, 1, 2], [0, 2, 5], [5, 2, 3], [5, 3, 4]]) {
      const ids = front ? tri : [tri[0], tri[2], tri[1]];
      for (const i of ids) {
        pos.push(p[i][0], p[i][1], s.z);
        const lampRow = p[i][1] > 0.45 && p[i][1] < b.belt + 0.05 && Math.abs(p[i][0]) > b.W * 0.25;
        col.push(1, 1, 1);
        lamp.push(lampRow && b.name !== "bus" ? (front ? 1 : 2) : 0);
      }
    }
  }
  const body = new BufferGeometry();
  body.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  body.setAttribute("color", new BufferAttribute(new Float32Array(col), 3));
  body.setAttribute("_lamp", new BufferAttribute(new Float32Array(lamp), 1));
  body.computeVertexNormals();
  parts.push(body);
  // Wheels: dark blocks under the sills.
  for (const z of [-b.L * 0.32, b.L * 0.32])
    for (const x of [-b.W / 2 + 0.12, b.W / 2 - 0.12]) {
      const w = new BoxGeometry(0.24, 0.62, 0.66).toNonIndexed();
      w.translate(x, 0.31, z);
      const n = w.attributes.position.count;
      w.setAttribute("color", new BufferAttribute(new Float32Array(n * 3).fill(0.03), 3));
      w.setAttribute("_lamp", new BufferAttribute(new Float32Array(n), 1));
      w.deleteAttribute("uv");
      parts.push(w);
    }
  return mergeGeometries(parts)!;
}

function material(env: Texture, lamps: boolean): MeshStandardMaterial {
  // Double-sided: the lofted shell and its end caps aren't wound consistently.
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.4, envMap: env, envMapIntensity: 0.8, side: DoubleSide });
  patchMaterial(m, {
    key: lamps ? "carLamps" : "car",
    uniforms: { uNight: SHARED.uNight, uLamps: { value: lamps ? 1 : 0 } },
    vertexPars: "attribute float _lamp;\nvarying float vLamp;",
    vertex: [["begin_vertex", "vLamp = _lamp;"]],
    fragmentPars: "uniform float uNight;\nuniform float uLamps;\nvarying float vLamp;",
    fragment: [
      [
        "emissivemap_fragment",
        `totalEmissiveRadiance += (vLamp > 1.5 ? vec3(2.2, 0.15, 0.08) : vLamp > 0.5 ? vec3(3.0, 2.8, 2.4) : vec3(0.0)) * uLamps * (0.15 + 0.85 * uNight);`,
      ],
    ],
  });
  return m;
}

interface Way {
  pts: Float32Array;
  cum: Float32Array;
  len: number;
  fwd: number;
  back: number;
  laneW: number;
  a: string;
  b: string;
}
interface Mover {
  way: number;
  dir: 1 | -1;
  lane: number;
  s: number;
  speed: number;
  type: number;
  colour: Color;
}

export class Traffic {
  readonly group = new Group();
  private readonly parkedMeshes: InstancedMesh[] = [];
  private readonly movingMeshes: InstancedMesh[] = [];
  private readonly parked: { x: number; y: number; z: number; m: Float32Array; type: number; colour: Color }[] = [];
  private readonly ways: Way[] = [];
  private readonly nodes = new Map<string, { way: number; dir: 1 | -1 }[]>();
  private readonly movers: Mover[] = [];
  private t = 0;
  private readonly frustum = new Frustum();
  private readonly pv = new Matrix4();
  private readonly sphere = new Sphere(new Vector3(), 4);
  private readonly rand: () => number;
  private share = 1;
  readonly counts = { parked: 0, moving: 0 };

  constructor(
    data: TrafficJson,
    parkedBytes: ArrayBuffer | Uint8Array,
    private readonly terrain: Terrain,
    env: Texture,
  ) {
    let seed = 7731;
    this.rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const paints = PAINT.flatMap(([hex, w]) => Array<Color>(w).fill(new Color(hex)));
    const geos = BODIES.map(carGeometry);
    const still = material(env, false);
    const lit = material(env, true);
    const bytes = parkedBytes instanceof Uint8Array ? parkedBytes : new Uint8Array(parkedBytes);
    const f = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const p = new Vector3();
    const one = new Vector3(1, 1, 1);
    for (let k = 0; k < f.length; k += 4) {
      const [x, z, h, c] = [f[k], f[k + 1], f[k + 2], f[k + 3]];
      const type = c % 7 < 3 ? 0 : c % 7 < 5 ? 1 : c % 7 < 6 ? 2 : 3;
      const y = terrain.heightAt(x, z);
      q.setFromAxisAngle(up, -h);
      m.compose(p.set(x, y, z), q, one);
      this.parked.push({ x, y, z, m: Float32Array.from(m.elements), type, colour: paints[Math.floor(this.rand() * paints.length)] });
    }
    for (let t = 0; t < 4; t++) this.parkedMeshes.push(this.instanced(geos[t], still, this.parked.filter((c) => c.type === t).length, `parked ${BODIES[t].name}`));
    for (let t = 0; t < BODIES.length; t++) this.movingMeshes.push(this.instanced(geos[t], lit, MOVING, `traffic ${BODIES[t].name}`));

    // The road graph: ways meet at shared end points.
    const key = (x: number, z: number) => `${Math.round(x * 2)},${Math.round(z * 2)}`;
    for (const w of data.ways) {
      const pts = Float32Array.from(w.pts);
      const n = pts.length / 2;
      const cum = new Float32Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
      const way: Way = { pts, cum, len: cum[n - 1], fwd: w.fwd, back: w.back, laneW: w.laneW, a: key(pts[0], pts[1]), b: key(pts[n * 2 - 2], pts[n * 2 - 1]) };
      if (way.len < 5) continue;
      const i = this.ways.push(way) - 1;
      if (way.fwd) (this.nodes.get(way.a) ?? this.nodes.set(way.a, []).get(way.a)!).push({ way: i, dir: 1 });
      if (way.back) (this.nodes.get(way.b) ?? this.nodes.set(way.b, []).get(way.b)!).push({ way: i, dir: -1 });
    }
    // Spread the traffic over the ways by length.
    const total = this.ways.reduce((s, w) => s + w.len * (w.fwd + w.back), 0);
    for (let k = 0; k < MOVING && this.ways.length; k++) {
      let r = this.rand() * total;
      let wi = 0;
      for (; wi < this.ways.length - 1; wi++) if ((r -= this.ways[wi].len * (this.ways[wi].fwd + this.ways[wi].back)) < 0) break;
      const w = this.ways[wi];
      const dir: 1 | -1 = w.fwd && (!w.back || this.rand() < w.fwd / (w.fwd + w.back)) ? 1 : -1;
      const lanes = dir > 0 ? w.fwd : w.back;
      const bus = this.rand() < 0.04;
      this.movers.push({
        way: wi,
        dir,
        lane: Math.floor(this.rand() * lanes),
        s: this.rand() * w.len,
        speed: bus ? 8 : 9 + this.rand() * 5,
        type: bus ? 4 : this.rand() < 0.45 ? 0 : this.rand() < 0.6 ? 1 : this.rand() < 0.7 ? 2 : 3,
        colour: bus ? new Color(BUS) : paints[Math.floor(this.rand() * paints.length)],
      });
    }
    this.group.name = "traffic";
  }

  private instanced(geo: BufferGeometry, mat: MeshStandardMaterial, n: number, name: string): InstancedMesh {
    const mesh = new InstancedMesh(geo, mat, Math.max(1, n));
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.setColorAt(0, new Color(1, 1, 1));
    mesh.instanceColor!.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = name;
    this.group.add(mesh);
    return mesh;
  }

  /** Share of the cars drawn (the quality tiers), 0 for none. */
  setShare(share: number): void {
    this.share = share;
    this.group.visible = share > 0;
  }

  private readonly at = new Vector3();
  /** Where a mover is: on its way, in its lane (keeping right), and its heading. */
  private place(c: Mover, out: Vector3): number {
    const w = this.ways[c.way];
    const s = c.dir > 0 ? c.s : w.len - c.s;
    let i = 0;
    while (i < w.cum.length - 2 && w.cum[i + 1] < s) i++;
    const u = (s - w.cum[i]) / Math.max(1e-6, w.cum[i + 1] - w.cum[i]);
    const ax = w.pts[i * 2], az = w.pts[i * 2 + 1], bx = w.pts[i * 2 + 2], bz = w.pts[i * 2 + 3];
    let dx = bx - ax;
    let dz = bz - az;
    const l = Math.hypot(dx, dz) || 1;
    dx = (dx / l) * c.dir;
    dz = (dz / l) * c.dir;
    const lanes = c.dir > 0 ? w.fwd : w.back;
    const both = w.fwd > 0 && w.back > 0;
    const off = both ? (c.lane + 0.5) * w.laneW : (c.lane + 0.5 - lanes / 2) * w.laneW;
    // The right of the direction of travel is (-dz, dx).
    out.set(ax + (bx - ax) * u - dz * off, 0, az + (bz - az) * u + dx * off);
    out.y = this.terrain.heightAt(out.x, out.z);
    return Math.atan2(dx, -dz);
  }

  update(camera: PerspectiveCamera, dt: number): void {
    if (!this.group.visible) return;
    // Drive: on to a random way at each junction (not straight back unless there's no other).
    for (const c of this.movers) {
      c.s += c.speed * dt;
      const w = this.ways[c.way];
      if (c.s < w.len) continue;
      const end = c.dir > 0 ? w.b : w.a;
      const options = (this.nodes.get(end) ?? []).filter((o) => o.way !== c.way);
      const next = options.length ? options[Math.floor(this.rand() * options.length)] : (c.dir > 0 ? w.back : w.fwd) ? { way: c.way, dir: (c.dir > 0 ? -1 : 1) as 1 | -1 } : null;
      if (!next) {
        c.s = 0;
        continue;
      }
      c.s -= w.len;
      c.way = next.way;
      c.dir = next.dir;
      const nw = this.ways[c.way];
      c.lane = Math.min(c.lane, (c.dir > 0 ? nw.fwd : nw.back) - 1);
      c.s = Math.min(c.s, nw.len - 0.1);
    }
    this.t -= dt;
    camera.updateMatrixWorld();
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    const cp = camera.position;
    const draw2 = (DRAW * Math.max(0.3, this.share)) ** 2;
    // The moving cars every frame.
    for (const mesh of this.movingMeshes) mesh.count = 0;
    const m = tmpM;
    for (const c of this.movers) {
      const h = this.place(c, this.at);
      if ((this.at.x - cp.x) ** 2 + (this.at.z - cp.z) ** 2 > draw2) continue;
      this.sphere.center.copy(this.at);
      if (!this.frustum.intersectsSphere(this.sphere)) continue;
      const mesh = this.movingMeshes[c.type];
      m.compose(this.at, tmpQ.setFromAxisAngle(UP, -h), ONE);
      mesh.setMatrixAt(mesh.count, m);
      mesh.setColorAt(mesh.count, c.colour);
      mesh.count++;
    }
    this.counts.moving = this.movingMeshes.reduce((s, x) => s + x.count, 0);
    for (const mesh of this.movingMeshes) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
    }
    // The parked ones a few times a second.
    if (this.t > 0) return;
    this.t = RESORT;
    for (const mesh of this.parkedMeshes) mesh.count = 0;
    for (const c of this.parked) {
      if ((c.x - cp.x) ** 2 + (c.z - cp.z) ** 2 > draw2) continue;
      this.sphere.center.set(c.x, c.y, c.z);
      if (!this.frustum.intersectsSphere(this.sphere)) continue;
      const mesh = this.parkedMeshes[c.type];
      (mesh.instanceMatrix.array as Float32Array).set(c.m, mesh.count * 16);
      mesh.setColorAt(mesh.count, c.colour);
      mesh.count++;
    }
    this.counts.parked = this.parkedMeshes.reduce((s, x) => s + x.count, 0);
    for (const mesh of this.parkedMeshes) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
    }
  }
}

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const UP = new Vector3(0, 1, 0);
const ONE = new Vector3(1, 1, 1);
