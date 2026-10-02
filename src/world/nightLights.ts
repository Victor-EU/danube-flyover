// The night light groups: floodlit landmarks (Parliament from the water side, the castle,
// the Bastion, the Liberty Statue...), the Chain Bridge's string lights along both chains,
// lamps along the decks of the other bridges and along both embankments. Each is emissive
// geometry or a glowing sprite, faded in on the shared night ramp; every light near the water
// also lays a stretched streak on it. A pool of four real point lights (one of them the
// boat's lamp) is always in the scene, faded and handed to the groups nearest the camera.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  type Material,
  Mesh,
  type MeshStandardMaterial,
  type PerspectiveCamera,
  PointLight,
  Points,
  ShaderMaterial,
  Vector3,
} from "three";
import { WORLD } from "../config";
import { forwardOf } from "../geo";
import type { State } from "../state";
import type { Bridges } from "./bridges";
import type { Heroes } from "./heroes";
import type { Landmarks, Sight } from "./landmarks";
import { SHARED } from "./night";
import type { River } from "./river";
import { patchFloodlit } from "./surfaces";
import { LAYER } from "./water";

const c = (hex: string, k: number) => new Color(hex).multiplyScalar(k);

/** Floodlit landmarks: colour, strength, and whether the light comes from the water side. */
const FLOODS: Record<string, { color: string; k: number; water: boolean; streak?: number }> = {
  parliament: { color: "#ffcf86", k: 1.15, water: true, streak: 46 },
  palace: { color: "#ffd59c", k: 1.0, water: true, streak: 34 },
  bastion: { color: "#fff0d6", k: 1.08, water: true },
  matthias: { color: "#ffdcae", k: 0.55, water: false },
  libertyStatue: { color: "#e9f0ff", k: 1.35, water: false },
  citadella: { color: "#ffd9aa", k: 0.63, water: true },
  academy: { color: "#ffdcad", k: 0.85, water: true, streak: 16 },
  gresham: { color: "#ffd59e", k: 0.85, water: true, streak: 16 },
  vigado: { color: "#ffd8a2", k: 0.85, water: true, streak: 14 },
  gellertHotel: { color: "#ffe2b4", k: 0.81, water: true, streak: 16 },
  marketHall: { color: "#ffd29a", k: 0.72, water: false },
};

/** Bridges: deck lamp colour, tower/structure floodlight, and the Chain Bridge's bulbs. */
const BRIDGES: Record<string, { lamp: string; flood?: [string, number]; bulbs?: string }> = {
  "Chain Bridge": { lamp: "#ffd08a", flood: ["#ffd79a", 1.0], bulbs: "#ffc35a" },
  "Elisabeth Bridge": { lamp: "#eef2ff", flood: ["#e8efff", 0.8] },
  "Liberty Bridge": { lamp: "#ffd690", flood: ["#ffe2a8", 0.7] },
  "Margaret Bridge": { lamp: "#ffcf86", flood: ["#ffd8a0", 0.45] },
  "Árpád Bridge": { lamp: "#ffb661" },
};

const LAMP = "#ffcf8a";
/** Embankment lamps between Margaret Bridge and Liberty Bridge, both banks, this far apart. */
const EMBANKMENT = { z0: -1850, z1: 1650, step: 30, setback: 3, height: 4.6 };

interface Anchor {
  pos: Vector3;
  color: Color;
  intensity: number;
  distance: number;
  /** Larger anchors win the pool from further away. */
  weight: number;
}

const POOL = 3; // plus the boat's lamp
/** On a short mast ahead of the cabin (local -z is forward), lighting the deck and the water. */
const BOAT_LAMP = { intensity: 2.5, distance: 30, offset: new Vector3(0, 2.8, -1.4) };

export class NightLights {
  readonly group = new Group();
  readonly floodlit: string[] = [];
  private readonly emitters: Points;
  private readonly streaks: Mesh;
  private readonly emitterMat: ShaderMaterial;
  private readonly streakMat: ShaderMaterial;
  private readonly anchors: Anchor[] = [];
  private readonly pool: { light: PointLight; anchor: Anchor | null; next: Anchor | null; fade: number }[] = [];
  private readonly boat = new PointLight("#ffd9a0", 0, BOAT_LAMP.distance, 2);
  private poolT = 0;
  readonly counts = { lamps: 0, bulbs: 0, streaks: 0 };

  constructor(river: River, bridges: Bridges, landmarks: Landmarks, sights: Sight[], heroes: Heroes) {
    const emit: { p: Vector3; color: Color; size: number }[] = [];
    const streak: { x: number; z: number; h: number; color: Color; width: number }[] = [];
    /** A streak foot on the water under (or just off the bank from) a light. */
    const foot = (x: number, z: number, into: number): { x: number; z: number } | null => {
      if (river.isWater(x, z)) return { x, z };
      const b = river.nearestBank(x, z, 60);
      if (!b) return null;
      for (const s of [1, -1]) {
        const fx = b.x - b.uz * s * into;
        const fz = b.z + b.ux * s * into;
        if (river.isWater(fx, fz)) return { x: fx, z: fz };
      }
      return null;
    };

    // Embankment lamps on both main banks.
    river.banks.forEach((bank) => {
      const n = bank.length / 2;
      const closed = bank[0] === bank[bank.length - 2] && bank[1] === bank[bank.length - 1];
      if (closed || n < 10) return; // islands and the Óbuda fragments
      let next = 0;
      let run = 0;
      for (let i = 0; i < n - 1; i++) {
        const ax = bank[i * 2];
        const az = bank[i * 2 + 1];
        const ex = bank[i * 2 + 2] - ax;
        const ez = bank[i * 2 + 3] - az;
        const l = Math.hypot(ex, ez);
        while (next <= run + l) {
          const t = (next - run) / l;
          next += EMBANKMENT.step;
          const x = ax + ex * t;
          const z = az + ez * t;
          if (z < EMBANKMENT.z0 || z > EMBANKMENT.z1) continue;
          // Inland of the bank, on the quay.
          let nx = -ez / l;
          let nz = ex / l;
          if (river.isWater(x + nx * 6, z + nz * 6)) (nx = -nx), (nz = -nz);
          const lx = x + nx * EMBANKMENT.setback;
          const lz = z + nz * EMBANKMENT.setback;
          if (bridges.onFootprint(lx, lz, 8)) continue;
          const p = new Vector3(lx, WORLD.quayHeight + EMBANKMENT.height, lz);
          emit.push({ p, color: c(LAMP, 3), size: 0.9 });
          streak.push({ x: x - nx * 2.5, z: z - nz * 2.5, h: p.y, color: c(LAMP, 0.55), width: 1.1 });
          this.anchors.push({ pos: p.clone().setY(p.y - 0.5), color: c(LAMP, 1), intensity: 9, distance: 38, weight: 1 });
          this.counts.lamps++;
        }
        run += l;
      }
    });

    // Bridges: deck lamps, the Chain Bridge's bulbs along the chains, floodlit towers.
    for (const b of bridges.lights) {
      const def = BRIDGES[b.name];
      if (!def) continue;
      b.deckLamps.forEach((p, i) => {
        emit.push({ p, color: c(def.lamp, 3), size: 0.8 });
        const f = foot(p.x, p.z, 0);
        if (f) streak.push({ x: f.x, z: f.z, h: p.y, color: c(def.lamp, 0.5), width: 1.2 });
        if (i % 2 === 0) this.anchors.push({ pos: p, color: c(def.lamp, 1), intensity: 14, distance: 46, weight: 1.3 });
        this.counts.lamps++;
      });
      if (def.bulbs)
        for (const cable of b.cables) {
          let since = 0;
          let sinceAnchor = 0;
          for (let i = 1; i < cable.length; i++) {
            const a = cable[i - 1];
            const d = a.distanceTo(cable[i]);
            for (let t = 0; t < d; t += 0.5) {
              since += 0.5;
              sinceAnchor += 0.5;
              if (since < 5) continue;
              since = 0;
              const p = a.clone().lerp(cable[i], t / d).setY(a.y + (cable[i].y - a.y) * (t / d) + 0.9);
              emit.push({ p, color: c(def.bulbs, 2.4), size: 0.5 });
              const f = river.isWater(p.x, p.z) ? { x: p.x, z: p.z } : null;
              if (f) streak.push({ x: f.x, z: f.z, h: p.y, color: c(def.bulbs, 0.22), width: 0.9 });
              if (sinceAnchor > 45) {
                sinceAnchor = 0;
                this.anchors.push({ pos: p.clone(), color: c(def.bulbs, 1), intensity: 40, distance: 70, weight: 2 });
              }
              this.counts.bulbs++;
            }
          }
        }
      // A hero bridge is lit through its own material (towers, chains and all).
      const material = b.material ?? heroes.byName.get(b.name)?.material;
      if (def.flood && material) {
        const flood = { color: c(def.flood[0], def.flood[1]), from: new Vector3(), base: 0, top: b.towerTop };
        patchFloodlit(material, flood);
        if (b.chain) patchFloodlit(b.chain, { ...flood, color: c(def.bulbs ?? def.flood[0], 1.2) });
        this.floodlit.push(b.name);
      }
    }

    // Landmarks: floodlight each hero (or placeholder part), from the water side where there is one.
    const byId = new Map<string, Mesh[]>();
    for (const o of landmarks.group.children) if ((o as Mesh).isMesh) (byId.get(o.name) ?? byId.set(o.name, []).get(o.name)!).push(o as Mesh);
    for (const [id, h] of heroes.byId) byId.set(id, h.meshes);
    for (const [id, def] of Object.entries(FLOODS)) {
      const meshes = byId.get(id);
      const sight = sights.find((s) => s.id === id);
      if (!meshes || !sight) continue;
      let base = Infinity;
      let top = -Infinity;
      for (const m of meshes) {
        m.geometry.computeBoundingBox();
        const bb = m.geometry.boundingBox!;
        base = Math.min(base, m.position.y + bb.min.y);
        top = Math.max(top, m.position.y + bb.max.y);
      }
      const bank = river.nearestBank(sight.x, sight.z, 2500);
      const from = new Vector3();
      if (def.water && bank) from.set(bank.x - sight.x, 0, bank.z - sight.z).normalize().setY(0.35).normalize();
      const color = c(def.color, def.k);
      const flood = { color, from, base, top };
      for (const mat of new Set(meshes.map((m) => m.material as MeshStandardMaterial))) patchFloodlit(mat, flood);
      this.floodlit.push(id);
      if (bank) {
        const f = foot(bank.x, bank.z, 6);
        if (f && def.streak) streak.push({ x: f.x, z: f.z, h: top, color: c(def.color, 0.3 * def.k), width: def.streak });
        // Out over the water, lighting the quay and the foot of the facade.
        const out = foot(bank.x, bank.z, 30);
        if (out) this.anchors.push({ pos: new Vector3(out.x, WORLD.quayHeight + 6, out.z), color: c(def.color, 1), intensity: 90, distance: 160, weight: 3 });
      }
    }

    this.emitterMat = emitterMaterial();
    this.emitters = new Points(emitterGeometry(emit), this.emitterMat);
    this.emitters.frustumCulled = false;
    this.emitters.name = "night lights";
    this.streakMat = streakMaterial();
    this.streaks = new Mesh(streakGeometry(streak), this.streakMat);
    this.streaks.frustumCulled = false;
    this.streaks.name = "light streaks";
    this.streaks.layers.set(LAYER.water);
    this.counts.streaks = streak.length;
    this.group.add(this.emitters, this.streaks);

    // The point-light pool: lights are never added or removed, only faded and moved.
    for (let i = 0; i < POOL; i++) {
      const light = new PointLight("#ffd9a0", 0, 40, 2);
      this.pool.push({ light, anchor: null, next: null, fade: 0 });
      this.group.add(light);
    }
    this.group.add(this.boat);
  }

  update(st: State, camera: PerspectiveCamera, focus: Vector3, viewHeight: number, fogDensity: number, mirror: number, dt: number): void {
    const night = SHARED.uNight.value;
    const visible = night > 0.001;
    this.emitters.visible = this.streaks.visible = visible;
    const scale = viewHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    for (const m of [this.emitterMat, this.streakMat]) {
      m.uniforms.uScale.value = scale;
      m.uniforms.uFog.value = fogDensity;
    }
    // Inside the planar reflection's zones the reflection shows the lights itself.
    this.streakMat.uniforms.uStrength.value = 1 - 0.55 * mirror;

    // The boat's lamp rides on the cabin roof.
    const v = st.vehicle;
    const f = forwardOf(v.heading);
    const o = BOAT_LAMP.offset;
    this.boat.position.set(v.x - f.x * o.z, v.y + o.y, v.z - f.z * o.z);
    this.boat.intensity = v.boatness * night * BOAT_LAMP.intensity;

    // Re-pick the nearest anchors four times a second; swap a light only for a clearly
    // better one, fading it out before it moves.
    this.poolT -= dt;
    if (this.poolT <= 0 && visible) {
      this.poolT = 0.25;
      const score = (a: Anchor) => a.pos.distanceTo(focus) / a.weight;
      const best = [...this.anchors].sort((a, b) => score(a) - score(b)).slice(0, POOL);
      const held = () => this.pool.map((p) => p.next ?? p.anchor);
      for (const a of best) {
        if (held().includes(a)) continue;
        // Take the slot whose anchor has dropped out of the best, the worst first.
        let slot = -1;
        let worst = -1;
        this.pool.forEach((p, i) => {
          const h = p.next ?? p.anchor;
          if (h && best.includes(h)) return;
          const s = h ? score(h) : Infinity;
          if (s > worst) (worst = s), (slot = i);
        });
        if (slot < 0) break;
        if (worst !== Infinity && score(a) * 1.25 > worst) continue; // not clearly better
        this.pool[slot].next = a;
      }
    }
    for (const p of this.pool) {
      if (p.next && p.next !== p.anchor) {
        p.fade = Math.max(0, p.fade - dt * 4);
        if (p.fade === 0) {
          p.anchor = p.next;
          p.next = null;
          p.light.position.copy(p.anchor.pos);
          p.light.color.copy(p.anchor.color);
          p.light.distance = p.anchor.distance;
        }
      } else {
        p.next = null;
        p.fade = Math.min(1, p.fade + dt * 2);
      }
      p.light.intensity = p.anchor ? p.anchor.intensity * p.fade * night : 0;
    }
  }

  /** For the debug panel: what each pool light is on. */
  describePool(): string {
    return this.pool.map((p) => (p.anchor && p.light.intensity > 0 ? `${p.anchor.intensity}` : "-")).join(" ");
  }

  dispose(): void {
    for (const m of [this.emitterMat, this.streakMat] as Material[]) m.dispose();
  }
}

function emitterGeometry(list: { p: Vector3; color: Color; size: number }[]): BufferGeometry {
  const pos = new Float32Array(list.length * 3);
  const col = new Float32Array(list.length * 3);
  const size = new Float32Array(list.length);
  list.forEach((e, i) => {
    pos.set([e.p.x, e.p.y, e.p.z], i * 3);
    col.set([e.color.r, e.color.g, e.color.b], i * 3);
    size[i] = e.size;
  });
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("aColor", new BufferAttribute(col, 3));
  g.setAttribute("aSize", new BufferAttribute(size, 1));
  return g;
}

/** Glowing dots, at least a few pixels across so far lamps still read (dimmed to match). */
function emitterMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uNight: SHARED.uNight, uScale: { value: 800 }, uFog: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aSize;
      uniform float uNight;
      uniform float uScale;
      uniform float uFog;
      varying vec3 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float d = max(-mv.z, 0.1);
        // The glow spans three times the lamp itself.
        float px = aSize * 3.0 * uScale / d;
        float minPx = 3.0;
        float k = px < minPx ? (px / minPx) * (px / minPx) : 1.0;
        gl_PointSize = clamp(px, minPx, 160.0);
        float fog = exp(-pow(uFog * d, 2.0));
        vColor = aColor * uNight * fog * mix(k, 1.0, 0.35);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        if (r > 1.0) discard;
        float core = smoothstep(0.36, 0.22, r);
        float halo = exp(-r * r * 6.0) * 0.32;
        gl_FragColor = vec4(vColor * (core + halo), 1.0);
      }`,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
}

function streakGeometry(list: { x: number; z: number; h: number; color: Color; width: number }[]): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry();
  // A strip from the far end (y = 0) to the near end (y = 1), in rows: the shader spaces the
  // rows by viewing angle, which isn't linear in distance.
  const ROWS = 10;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let r = 0; r <= ROWS; r++) pos.push(-0.5, r / ROWS, 0, 0.5, r / ROWS, 0);
  for (let r = 0; r < ROWS; r++) idx.push(r * 2, r * 2 + 1, r * 2 + 3, r * 2, r * 2 + 3, r * 2 + 2);
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  const foot = new Float32Array(list.length * 4);
  const col = new Float32Array(list.length * 3);
  list.forEach((s, i) => {
    foot.set([s.x, s.z, s.h, s.width], i * 4);
    col.set([s.color.r, s.color.g, s.color.b], i * 3);
  });
  g.setAttribute("aFoot", new InstancedBufferAttribute(foot, 4));
  g.setAttribute("aColor", new InstancedBufferAttribute(col, 3));
  g.instanceCount = list.length;
  return g;
}

/**
 * A light's reflection on rippled water. Flat water would show one point, where the line from
 * the eye to the light's mirror image (as far below the surface as the light is above it)
 * crosses the surface; ripples smear it up and down the view into a column. So the streak is
 * laid out by depression angle below the horizon, from under half the mirror image's angle to
 * twice it, brightest at the mirror image itself, and as wide as the light looks from the eye
 * at every row: a column of even width on screen.
 */
function streakMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uNight: SHARED.uNight, uTime: SHARED.uTime, uScale: { value: 800 }, uFog: { value: 0 }, uStrength: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute vec4 aFoot;
      attribute vec3 aColor;
      uniform float uScale;
      uniform float uFog;
      varying vec3 vColor;
      varying vec2 vQuad;
      varying float vPeak;
      varying float vMetres;
      void main() {
        vec2 foot = aFoot.xy;
        vec2 toCam = cameraPosition.xz - foot;
        float D = max(length(toCam), 1.0);
        vec2 dir = toCam / D;
        vec2 across = vec2(-dir.y, dir.x);
        float cam = max(cameraPosition.y, 0.6);
        float phiM = atan(cam + aFoot.z, D);
        float phi0 = phiM * 0.45;
        float phi1 = min(phiM * 2.1, 1.4);
        float phi = mix(phi0, phi1, position.y);
        float dc = min(cam / tan(phi), D);
        // The light's own angular width, at least about a pixel and a half.
        float ang = max(aFoot.w / D, 1.5 / uScale);
        vec2 p = cameraPosition.xz - dir * dc + across * position.x * ang * dc;
        vQuad = position.xy;
        vPeak = (phiM - phi0) / (phi1 - phi0);
        vMetres = dc;
        vec4 mv = viewMatrix * vec4(p.x, 0.05, p.y, 1.0);
        // Thin lights at a distance are dimmer, not wider.
        vColor = aColor * exp(-pow(uFog * D, 2.0)) * min(1.0, aFoot.w / D / ang) * smoothstep(20.0, 60.0, D);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uNight;
      uniform float uTime;
      uniform float uStrength;
      varying vec3 vColor;
      varying vec2 vQuad;
      varying float vPeak;
      varying float vMetres;
      float hash11(float p) {
        p = fract(p * 0.1031);
        p *= p + 33.33;
        p *= p + p;
        return fract(p);
      }
      float noise1(float x) {
        float i = floor(x);
        float f = fract(x);
        return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
      }
      void main() {
        float across = 1.0 - pow(abs(vQuad.x) * 2.0, 2.0);
        float t = vQuad.y;
        float along = exp(-pow((t - vPeak) / 0.32, 2.0)) * smoothstep(0.0, 0.12, t) * smoothstep(1.0, 0.8, t);
        // Broken into glints by the ripples, a few metres apart and drifting downstream.
        float m = vMetres;
        float n = noise1(m * 0.55 - uTime * 1.4 + vQuad.x * 1.3) * 0.6 + noise1(m * 1.7 + uTime * 0.8 - vQuad.x * 2.1) * 0.4;
        float ripple = 0.25 + 0.75 * smoothstep(0.3, 0.8, n);
        gl_FragColor = vec4(vColor * uNight * uStrength * across * along * ripple, 1.0);
      }`,
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
}
