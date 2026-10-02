// Effects and ambient life: the boat's wake and foam, the splash ring and spray when the glider
// lands and the burst when the boat takes off, flocks of gulls over the river, two tour boats
// on loops up and down it, and the trams along both embankments (life.json). Everything is
// created once; per frame only positions, counts and fades change, so nothing recompiles.

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  Quaternion,
  RingGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { forwardOf, headingOf } from "./geo";
import type { State } from "./state";
import type { River } from "./world/river";
import { SHARED } from "./world/night";
import { HASH_GLSL, patchMaterial } from "./world/shaderPatch";
import { LAYER } from "./world/water";

export interface LifeJson {
  trams: { name: string; path: number[] }[];
}

const tmpM = new Matrix4();
const tmpQ = new Quaternion();
const tmpE = new Euler();
const tmpP = new Vector3();
const tmpS = new Vector3();

export class Effects {
  readonly group = new Group();
  private readonly wake = new Wake();
  private readonly spray = new Spray();
  private readonly gulls = new Gulls();
  private readonly boats: TourBoats;
  private readonly trams: Trams;

  constructor(river: River, life: LifeJson) {
    this.boats = new TourBoats(river);
    this.trams = new Trams(life);
    this.group.add(this.wake.mesh, this.spray.points, this.spray.ring, this.gulls.mesh, this.boats.group, this.trams.group);
    this.group.name = "effects";
  }

  private life = true;

  /** Ambient life (boats, trams, gulls) on or off; the wake and spray always show. */
  setLife(on: boolean): void {
    this.life = on;
    this.boats.group.visible = this.trams.group.visible = on;
    if (!on) this.gulls.mesh.visible = false;
  }

  /** `light`: how bright the scene is (0 at night, 1 in daylight), for the unlit spray. */
  update(st: State, dt: number, light: number): void {
    this.wake.update(st);
    this.spray.update(st, dt, light);
    if (!this.life) return;
    this.gulls.update(st.t, SHARED.uNight.value);
    this.boats.update(dt, SHARED.uNight.value);
    this.trams.update(dt, SHARED.uNight.value);
  }

  /** For the debug panel. */
  describe(): string {
    if (!this.life) return `wake ${this.wake.count}, spray ${this.spray.alive}, no ambient life`;
    return `wake ${this.wake.count}, spray ${this.spray.alive}, gulls ${this.gulls.count}, boats ${this.boats.count}, trams ${this.trams.count}`;
  }
}

// --- The boat's wake ------------------------------------------------------------------------

/** GLSL: foam broken into patches that drift and churn. */
const FOAM_GLSL = /* glsl */ `
${HASH_GLSL}
float foamNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}`;

function foamMaterial(): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ color: "#ffffff", roughness: 0.9, transparent: true, depthWrite: false, vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2 });
  patchMaterial(mat, {
    key: "foam",
    uniforms: { uTime: SHARED.uTime },
    vertexPars: "varying vec2 vFoamPos;",
    vertex: [["begin_vertex", "vFoamPos = (modelMatrix * vec4(transformed, 1.0)).xz;"]],
    fragmentPars: `uniform float uTime;\nvarying vec2 vFoamPos;\n${FOAM_GLSL}`,
    fragment: [
      [
        "color_fragment",
        /* glsl */ `
        // Fresh foam (high alpha) is nearly solid; as it fades it breaks into patches and lace.
        float fn = foamNoise(vFoamPos * 1.1 + vec2(uTime * 0.3, 0.0)) * 0.55 + foamNoise(vFoamPos * 3.4 - vec2(0.0, uTime * 0.6)) * 0.45;
        float a = diffuseColor.a;
        diffuseColor.a = a * smoothstep(0.62 - 0.35 * a, 0.9 - 0.3 * a, fn);`,
      ],
    ],
  });
  return mat;
}

const WAKE_POINTS = 64;
const WAKE_STEP = 1.6; // metres between history points

class Wake {
  readonly mesh: Mesh;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly hist: { x: number; z: number; t: number }[] = [];
  count = 0;

  constructor() {
    // Three strips (the churned trail behind the stern, and the two arms of the V), each a
    // ribbon of WAKE_POINTS pairs.
    const n = WAKE_POINTS * 2 * 3;
    this.pos = new Float32Array(n * 3);
    this.col = new Float32Array(n * 4);
    const idx: number[] = [];
    for (let s = 0; s < 3; s++)
      for (let i = 0; i < WAKE_POINTS - 1; i++) {
        const a = (s * WAKE_POINTS + i) * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    g.setAttribute("color", new BufferAttribute(this.col, 4).setUsage(DynamicDrawUsage));
    const nor = new Float32Array(n * 3);
    for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
    g.setAttribute("normal", new BufferAttribute(nor, 3));
    g.setIndex(idx);
    this.mesh = new Mesh(g, foamMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(LAYER.water);
    this.mesh.renderOrder = 1;
    this.mesh.name = "wake";
  }

  update(st: State): void {
    const v = st.vehicle;
    const f = forwardOf(v.heading);
    const onWater = v.boatness > 0.5 && v.y < 0.6;
    const sx = v.x - f.x * 2.2;
    const sz = v.z - f.z * 2.2;
    const last = this.hist[0];
    if (onWater && (!last || Math.hypot(sx - last.x, sz - last.z) >= WAKE_STEP)) {
      this.hist.unshift({ x: sx, z: sz, t: st.t });
      if (this.hist.length > WAKE_POINTS - 1) this.hist.pop();
    }
    // Old points fade out whether or not the boat still moves.
    while (this.hist.length && st.t - this.hist[this.hist.length - 1].t > 14) this.hist.pop();
    const pts = onWater ? [{ x: sx, z: sz, t: st.t }, ...this.hist] : this.hist;
    this.count = pts.length;
    this.mesh.visible = pts.length > 1;
    if (!this.mesh.visible) return;
    const speedK = Math.min(1, v.speed / 8) * (onWater ? 1 : 0.6);
    let d = 0;
    for (let i = 0; i < WAKE_POINTS; i++) {
      const last = pts.length - 1;
      const p = pts[Math.min(i, last)];
      if (i > 0 && i <= last) d += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
      const q = pts[Math.min(i + 1, last)];
      const o = pts[Math.min(Math.max(i - 1, 0), last - 1)];
      let tx = o.x - q.x;
      let tz = o.z - q.z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const nx = -tz;
      const nz = tx;
      const age = st.t - p.t;
      const alive = i < pts.length ? 1 : 0;
      const fade = alive * Math.max(0, 1 - age / 14) * Math.max(0, 1 - d / 100);
      // The trail: churned foam widening behind the stern.
      const w = 0.75 + d * 0.035;
      this.strip(0, i, p.x, p.z, nx, nz, 0, w, fade * fade * 0.85 * Math.max(speedK, 0.3));
      // The arms: spreading at about 19° either side, thinner and fainter.
      const spread = 0.8 + d * 0.34;
      const aw = 0.3 + d * 0.008;
      const armA = fade * fade * 0.6 * speedK * Math.min(1, d / 6);
      this.strip(1, i, p.x, p.z, nx, nz, spread, aw, armA);
      this.strip(2, i, p.x, p.z, nx, nz, -spread, aw, armA);
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  private strip(s: number, i: number, x: number, z: number, nx: number, nz: number, off: number, w: number, a: number): void {
    const k = (s * WAKE_POINTS + i) * 2;
    const cx = x + nx * off;
    const cz = z + nz * off;
    this.pos.set([cx - nx * w, 0.05, cz - nz * w, cx + nx * w, 0.05, cz + nz * w], k * 3);
    this.col.set([1, 1, 1, a, 1, 1, 1, a], k * 4);
  }
}

// --- Splash and spray ---------------------------------------------------------------------

const SPRAY_MAX = 220;

function dropTexture(): CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.45, "rgba(255,255,255,0.6)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 32, 32);
  return new CanvasTexture(c);
}

class Spray {
  readonly points: Points;
  readonly ring: Mesh;
  private readonly pos = new Float32Array(SPRAY_MAX * 3);
  private readonly col = new Float32Array(SPRAY_MAX * 4);
  private readonly vel = new Float32Array(SPRAY_MAX * 3);
  private readonly life = new Float32Array(SPRAY_MAX);
  private readonly age = new Float32Array(SPRAY_MAX).fill(Infinity);
  private next = 0;
  private lastMode = "GLIDER";
  private lastT = 0;
  private ringAge = Infinity;
  private seed = 1;
  alive = 0;

  constructor() {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    g.setAttribute("color", new BufferAttribute(this.col, 4).setUsage(DynamicDrawUsage));
    const mat = new PointsMaterial({ size: 0.55, map: dropTexture(), vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true });
    this.points = new Points(g, mat);
    this.points.frustumCulled = false;
    this.points.name = "spray";
    const rm = new MeshStandardMaterial({ color: "#ffffff", roughness: 0.9, transparent: true, depthWrite: false, opacity: 0, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 });
    this.ring = new Mesh(new RingGeometry(0.75, 1, 48, 1).rotateX(-Math.PI / 2), rm);
    this.ring.layers.set(LAYER.water);
    this.ring.visible = false;
    this.ring.name = "splash ring";
  }

  private rand(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  private emit(n: number, x: number, z: number, fx: number, fz: number, up: [number, number], out: [number, number], back: number): void {
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % SPRAY_MAX;
      const a = this.rand() * Math.PI * 2;
      const o = out[0] + this.rand() * (out[1] - out[0]);
      this.pos.set([x + Math.cos(a) * 0.8, 0.2, z + Math.sin(a) * 0.8], i * 3);
      this.vel.set([Math.cos(a) * o - fx * back, up[0] + this.rand() * (up[1] - up[0]), Math.sin(a) * o - fz * back], i * 3);
      this.life[i] = 0.8 + this.rand() * 0.7;
      this.age[i] = 0;
    }
  }

  update(st: State, dt: number, light: number): void {
    const v = st.vehicle;
    const f = forwardOf(v.heading);
    // The landing splash at 0.6 s, the take-off spray at 0.3 s (the design's transition specs).
    const crossed = (mode: string, at: number) => v.mode === mode && v.transitionT >= at && (this.lastMode !== mode || this.lastT < at);
    if (crossed("LANDING", 0.6)) {
      this.emit(120, v.x, v.z, f.x, f.z, [2, 6.5], [1.5, 5], -2);
      this.ringAge = 0;
      this.ring.position.set(v.x, 0.06, v.z);
    }
    if (crossed("TAKEOFF", 0.3)) {
      this.emit(90, v.x - f.x * 2, v.z - f.z * 2, f.x, f.z, [1.5, 4.5], [0.5, 2.5], 5);
      this.ringAge = 0.4;
      this.ring.position.set(v.x - f.x * 2, 0.06, v.z - f.z * 2);
    }
    this.lastMode = v.mode;
    this.lastT = v.transitionT;

    let alive = 0;
    for (let i = 0; i < SPRAY_MAX; i++) {
      if (this.age[i] >= this.life[i]) {
        this.col[i * 4 + 3] = 0;
        continue;
      }
      alive++;
      this.age[i] += dt;
      this.vel[i * 3 + 1] -= 9.8 * dt;
      for (let k = 0; k < 3; k++) this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
      if (this.pos[i * 3 + 1] < 0) this.age[i] = this.life[i];
      const t = this.age[i] / this.life[i];
      const c = 0.35 + 0.65 * light;
      this.col.set([c, c, c, (1 - t) * 0.9], i * 4);
    }
    this.alive = alive;
    this.points.visible = alive > 0;
    if (alive > 0) {
      this.points.geometry.attributes.position.needsUpdate = true;
      this.points.geometry.attributes.color.needsUpdate = true;
    }
    this.ringAge += dt;
    const rt = this.ringAge / 2.2;
    this.ring.visible = rt < 1;
    if (this.ring.visible) {
      const r = 1.5 + 8 * Math.sqrt(rt);
      this.ring.scale.set(r, 1, r);
      (this.ring.material as MeshStandardMaterial).opacity = (1 - rt) * 0.85;
    }
  }
}

// --- Gulls ----------------------------------------------------------------------------------

/** Flocks circling over the river: centre x, z, altitude, radius, direction. */
const FLOCKS: [number, number, number, number, number][] = [
  [60, -2350, 30, 45, 1],
  [-20, -1100, 38, 55, -1],
  [10, 150, 26, 40, 1],
  [380, 760, 34, 50, -1],
  [880, 1240, 30, 45, 1],
];
const PER_FLOCK = 7;

class Gulls {
  readonly mesh: InstancedMesh;
  private readonly birds: { flock: number; r: number; phase: number; speed: number; dy: number }[] = [];
  count = 0;

  constructor() {
    // Body and two wings; `aTip` marks the wingtips, which flap in the vertex shader.
    const pos = [
      0, 0, -0.45, 0.12, 0, 0, 0, 0, 0.4, 0, 0, -0.45, 0, 0, 0.4, -0.12, 0, 0,
      0.1, 0, -0.12, 1.1, 0.05, 0.05, 0.1, 0, 0.16,
      -0.1, 0, -0.12, -0.1, 0, 0.16, -1.1, 0.05, 0.05,
    ];
    const tip = [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1];
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute("aTip", new BufferAttribute(new Float32Array(tip), 1));
    g.computeVertexNormals();
    const phases = new Float32Array(FLOCKS.length * PER_FLOCK);
    for (let i = 0; i < phases.length; i++) phases[i] = (i * 2.399) % (Math.PI * 2);
    g.setAttribute("aPhase", new InstancedBufferAttribute(phases, 1));
    const mat = new MeshStandardMaterial({ color: "#f3f1ec", roughness: 0.8, side: DoubleSide, flatShading: true });
    patchMaterial(mat, {
      key: "gulls",
      uniforms: { uTime: SHARED.uTime },
      vertexPars: "attribute float aTip;\nattribute float aPhase;\nuniform float uTime;",
      vertex: [["begin_vertex", "transformed.y += aTip * sin(uTime * 7.0 + aPhase) * 0.45;"]],
    });
    this.mesh = new InstancedMesh(g, mat, FLOCKS.length * PER_FLOCK);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.name = "gulls";
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    FLOCKS.forEach((fl, k) => {
      for (let i = 0; i < PER_FLOCK; i++) this.birds.push({ flock: k, r: fl[3] * (0.6 + rand() * 0.6), phase: rand() * Math.PI * 2, speed: 8 + rand() * 3, dy: (rand() - 0.5) * 14 });
    });
  }

  update(t: number, night: number): void {
    // Gulls roost at night.
    const scale = Math.max(0, 1 - night * 1.4);
    this.mesh.visible = scale > 0.01;
    this.count = this.mesh.visible ? this.birds.length : 0;
    if (!this.mesh.visible) return;
    this.birds.forEach((b, i) => {
      const [cx, cz, alt, , dir] = FLOCKS[b.flock];
      const a = b.phase + (dir * b.speed * t) / b.r;
      const x = cx + Math.cos(a) * b.r;
      const z = cz + Math.sin(a) * b.r;
      // Flying along the circle, banked into it.
      const tx = -Math.sin(a) * dir;
      const tz = Math.cos(a) * dir;
      tmpE.set(0, -headingOf(tx, tz), dir * 0.35, "YXZ");
      tmpQ.setFromEuler(tmpE);
      tmpP.set(x, alt + b.dy + Math.sin(t * 0.4 + b.phase) * 2, z);
      tmpS.setScalar(scale);
      this.mesh.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// --- Tour boats -----------------------------------------------------------------------------

/** A path as cumulative arc length, for sampling positions and headings. */
class Path {
  readonly len: number;
  private readonly cum: number[] = [0];
  constructor(readonly pts: { x: number; y: number; z: number }[], readonly closed: boolean) {
    const all = closed ? [...pts, pts[0]] : pts;
    for (let i = 1; i < all.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(all[i].x - all[i - 1].x, all[i].z - all[i - 1].z));
    this.len = this.cum[this.cum.length - 1];
  }
  at(s: number, out: Vector3): number {
    const all = this.closed ? [...this.pts, this.pts[0]] : this.pts;
    s = this.closed ? ((s % this.len) + this.len) % this.len : Math.min(this.len, Math.max(0, s));
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const a = all[lo];
    const b = all[hi];
    const u = (s - this.cum[lo]) / (this.cum[hi] - this.cum[lo] || 1);
    out.set(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u);
    return headingOf(b.x - a.x, b.z - a.z);
  }
}

/** Vertex-coloured boxes merged into one geometry: [w, h, d, x, y, z, colour]. */
function blocks(list: [number, number, number, number, number, number, string][]): BufferGeometry {
  const parts = list.map(([w, h, d, x, y, z, c]) => {
    const g = new BoxGeometry(w, h, d).toNonIndexed();
    g.translate(x, y, z);
    const col = new Color(c);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) arr.set([col.r, col.g, col.b], i * 3);
    g.setAttribute("color", new BufferAttribute(arr, 3));
    g.deleteAttribute("uv");
    return g;
  });
  return mergeGeometries(parts)!;
}

class TourBoats {
  readonly group = new Group();
  private readonly hull: InstancedMesh;
  private readonly glass: InstancedMesh;
  private readonly wakes: InstancedMesh;
  private readonly glassMat: MeshStandardMaterial;
  private readonly path: Path;
  private readonly s: number[];
  private readonly scales = [1, 0.62];
  count = 0;

  constructor(river: River) {
    // A loop down the east side of the river and back up the west, from below Margaret
    // Bridge to above Liberty Bridge, kept 30 m off the banks.
    const c = river.centreline;
    const raw: { x: number; z: number }[] = [];
    for (let i = 0; i < c.length - 2; i += 2) {
      const ax = c[i];
      const az = c[i + 1];
      const l = Math.hypot(c[i + 2] - ax, c[i + 3] - az);
      for (let d = 0; d < l; d += 10) raw.push({ x: ax + ((c[i + 2] - ax) * d) / l, z: az + ((c[i + 3] - az) * d) / l });
    }
    const span = raw.filter((p) => p.z > -1450 && p.z < 1300);
    const side = (sign: number) =>
      span.map((p, i) => {
        const q = span[Math.min(i + 1, span.length - 1)];
        const o = span[Math.max(i - 1, 0)];
        const tl = Math.hypot(q.x - o.x, q.z - o.z) || 1;
        const nx = -(q.z - o.z) / tl;
        const nz = (q.x - o.x) / tl;
        let off = 55;
        while (off > 0 && !(river.isWater(p.x + nx * sign * (off + 30), p.z + nz * sign * (off + 30)) && river.isWater(p.x + nx * sign * off, p.z + nz * sign * off))) off -= 5;
        return { x: p.x + nx * sign * off, y: 0, z: p.z + nz * sign * off };
      });
    // The centreline runs north to south: its left-hand normal points east.
    const down = side(-1);
    const up = side(1).reverse();
    this.path = new Path([...down, ...up], true);
    this.s = [0, this.path.len * 0.5];

    const hull = blocks([
      [6, 1.6, 30, 0, 0.5, 0, "#f1efe9"],
      [6.1, 0.35, 30.1, 0, 0.9, 0, "#2c5d86"],
      [5.4, 0.25, 26, 0, 3.75, 1.5, "#d8d5cc"],
      [3.2, 0.25, 4, 0, 5.3, -8, "#d8d5cc"],
      [5.6, 0.6, 3, 0, 1.6, -15.6, "#f1efe9"],
    ]);
    // Taper the bow.
    const p = hull.attributes.position as BufferAttribute;
    for (let i = 0; i < p.count; i++) if (p.getZ(i) < -12 && p.getY(i) < 2.2) p.setX(i, p.getX(i) * (0.35 + 0.65 * Math.max(0, (p.getZ(i) + 17) / 5)));
    hull.computeVertexNormals();
    const glass = blocks([
      [5.3, 1.9, 25.5, 0, 2.7, 1.5, "#ffffff"],
      [3.0, 1.3, 3.8, 0, 4.55, -8, "#ffffff"],
    ]);
    const hullMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, flatShading: true });
    this.glassMat = new MeshStandardMaterial({ color: "#3d4a55", roughness: 0.25, emissive: "#ffcf8f", emissiveIntensity: 0 });
    this.hull = new InstancedMesh(hull, hullMat, 2);
    this.glass = new InstancedMesh(glass, this.glassMat, 2);
    // A foam V behind each boat.
    const wg = new BufferGeometry();
    const wp = [0, 0.05, 15, -12, 0.05, 70, -9, 0.05, 72, 0, 0.05, 15, 9, 0.05, 72, 12, 0.05, 70, -2.5, 0.05, 15, 2.5, 0.05, 15, 0, 0.05, 48];
    const wc = [1, 1, 1, 0.8, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0.8, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0.9, 1, 1, 1, 0.9, 1, 1, 1, 0];
    wg.setAttribute("position", new BufferAttribute(new Float32Array(wp), 3));
    wg.setAttribute("color", new BufferAttribute(new Float32Array(wc), 4));
    wg.computeVertexNormals();
    const nor = wg.attributes.normal as BufferAttribute;
    for (let i = 0; i < nor.count; i++) nor.setXYZ(i, 0, 1, 0);
    const wm = foamMaterial();
    wm.side = DoubleSide;
    this.wakes = new InstancedMesh(wg, wm, 2);
    this.wakes.layers.set(LAYER.water);
    this.wakes.renderOrder = 1;
    for (const m of [this.hull, this.glass, this.wakes]) {
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.frustumCulled = false;
    }
    this.hull.castShadow = this.glass.castShadow = true;
    this.hull.name = "tour boats";
    this.group.add(this.hull, this.glass, this.wakes);
  }

  update(dt: number, night: number): void {
    this.glassMat.emissiveIntensity = night * 1.6;
    this.count = this.s.length;
    this.s.forEach((s, i) => {
      this.s[i] = s + dt * (i === 0 ? 4.5 : 5.5);
      const h = this.path.at(this.s[i], tmpP);
      tmpE.set(0, -h, 0, "YXZ");
      tmpQ.setFromEuler(tmpE);
      tmpS.setScalar(this.scales[i]);
      tmpM.compose(tmpP, tmpQ, tmpS);
      this.hull.setMatrixAt(i, tmpM);
      this.glass.setMatrixAt(i, tmpM);
      this.wakes.setMatrixAt(i, tmpM);
    });
    for (const m of [this.hull, this.glass, this.wakes]) m.instanceMatrix.needsUpdate = true;
  }
}

// --- Trams ----------------------------------------------------------------------------------

const TRAMS_PER_LINE = 3;
const TRAM = { speed: 7, section: 13.6 };

class Trams {
  readonly group = new Group();
  private readonly body: InstancedMesh;
  private readonly glass: InstancedMesh;
  private readonly glassMat: MeshStandardMaterial;
  private readonly lines: Path[];
  private readonly cars: { line: number; s: number; dir: number }[] = [];
  count = 0;

  constructor(life: LifeJson) {
    this.lines = life.trams.map((t) => {
      const pts: { x: number; y: number; z: number }[] = [];
      for (let i = 0; i < t.path.length; i += 3) pts.push({ x: t.path[i], y: t.path[i + 1], z: t.path[i + 2] });
      return new Path(pts, false);
    });
    this.lines.forEach((p, line) => {
      for (let k = 0; k < TRAMS_PER_LINE; k++) this.cars.push({ line, s: ((k + 0.3) / TRAMS_PER_LINE) * p.len, dir: k % 2 ? -1 : 1 });
    });
    // One section of a yellow Budapest tram (two per car, articulated).
    const body = blocks([
      [2.1, 0.42, 11.6, 0, 0.21, 0, "#2c2c2b"],
      [2.4, 1.15, 13, 0, 0.95, 0, "#f2c32f"],
      [2.4, 0.5, 13, 0, 2.95, 0, "#f2c32f"],
      [2.2, 0.25, 12.4, 0, 3.32, 0, "#8a8a86"],
      [2.42, 0.18, 13.02, 0, 1.55, 0, "#d9d6ce"],
    ]);
    const glass = blocks([[2.36, 1.25, 12.6, 0, 2.08, 0, "#ffffff"]]);
    this.glassMat = new MeshStandardMaterial({ color: "#3a4650", roughness: 0.3, emissive: "#fff0d0", emissiveIntensity: 0 });
    const n = this.cars.length * 2;
    this.body = new InstancedMesh(body, new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, flatShading: true }), n);
    this.glass = new InstancedMesh(glass, this.glassMat, n);
    for (const m of [this.body, this.glass]) {
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.frustumCulled = false;
      m.castShadow = true;
    }
    this.body.name = "trams";
    this.group.add(this.body, this.glass);
  }

  update(dt: number, night: number): void {
    this.glassMat.emissiveIntensity = night * 1.3;
    this.count = this.cars.length;
    this.cars.forEach((c, k) => {
      const p = this.lines[c.line];
      c.s += c.dir * TRAM.speed * dt;
      // Back and forth along the line, turning at the ends (the loops beyond the world).
      if (c.s > p.len) (c.s = p.len), (c.dir = -1);
      if (c.s < TRAM.section * 2) (c.s = TRAM.section * 2), (c.dir = 1);
      for (let sec = 0; sec < 2; sec++) {
        const s = c.s - c.dir * sec * (TRAM.section + 0.4) - c.dir * TRAM.section * 0.5;
        const h = p.at(s, tmpP);
        tmpE.set(0, -h + (c.dir < 0 ? Math.PI : 0), 0, "YXZ");
        tmpQ.setFromEuler(tmpE);
        tmpS.setScalar(1);
        tmpM.compose(tmpP, tmpQ, tmpS);
        this.body.setMatrixAt(k * 2 + sec, tmpM);
        this.glass.setMatrixAt(k * 2 + sec, tmpM);
      }
    });
    this.body.instanceMatrix.needsUpdate = true;
    this.glass.instanceMatrix.needsUpdate = true;
  }
}
