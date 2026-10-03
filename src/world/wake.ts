// The boat's wake: linear deep-water waves simulated on the GPU in a square of QUALITY.wake
// cells (WAKE.cell metres each) that follows the boat on a leash and drifts with the current.
//
// Each frame: the hulls press on the water and splashes punch craters, the square's edges and
// the land absorb the waves (all in space) → FFT → each wave advances by its own phase,
// ω = √(g|k|): that dispersion is what turns a moving hull's waves into the Kelvin V with its
// feathered crests → inverse FFT, which also gives the horizontal displacement that sharpens
// the crests → the surface pass: the slopes for the water's normal, and the foam (the hulls'
// wash, spray and bow waves, crests breaking, waves on the quays and ships), which ages from
// white water into lace and spreads. The water (water.ts) reads the surface everywhere in the
// square; `patch`, a dense mesh around the camera, is displaced by it; and a probe reads the
// heights under the boat back (a few frames late) to rock it on the waves.

import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  DoubleSide,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  OrthographicCamera,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  type ShaderMaterial,
  type Texture,
  UnsignedByteType,
  Vector2,
  type Vector3,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { QUALITY, WAKE } from "../config";
import { forwardOf } from "../geo";
import { floatTarget, GpuFft, passMaterial } from "./fft";
import { HASH_GLSL } from "./shaderPatch";
import type { River } from "./river";

/** A hull pressing on the water. Positions in world metres. */
export interface WakeHull {
  /** Stable across frames: a hull's pressure eases in when it first presses on the square. */
  id: string;
  x: number;
  z: number;
  heading: number;
  /** Metres forward of (x, z) to the front of the wetted hull, and to the transom (negative). */
  front: number;
  back: number;
  /** Half the beam at the waterline. */
  halfBeam: number;
  /** Displaced volume (m³): the pressure's integral over the hull. */
  volume: number;
  /** Foam made per second: the wash behind the transom, the spray sheets beside the hull, the bow wave. */
  wash: number;
  spray: number;
  bow: number;
  /** 0 afloat (the pressure follows the draft), 1 planing (it peaks at the spray root). */
  planing: number;
}

/** A crater punched in the water (a landing, a take-off), which rings out; `depth` in metres. */
export interface WakeSplash {
  x: number;
  z: number;
  radius: number;
  depth: number;
}

/** An oriented box the waves can't cross (a bridge pier): centre, unit axis, half extents. */
export interface WakeBlock {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  halfAlong: number;
  halfAcross: number;
}

const MAX = 4;

/** GLSL shared by the passes: the hulls, the splashes, and their footprints. */
const SOURCES_GLSL = /* glsl */ `
uniform vec4 uHullPos[${MAX}];  // x, z in the square (metres); forward x, z
uniform vec4 uHullDim[${MAX}];  // front, back (metres along the hull), waterline half beam, pressure head (m)
uniform vec4 uHullFoam[${MAX}]; // wash, spray, bow wave (foam per second); planing (0 to 1)
uniform int uHulls;
uniform vec4 uSplash[${MAX}];   // x, z, radius, depth
uniform int uSplashes;

/** p in a hull's frame: metres forward of its centre, and across (to starboard). */
vec2 hullFrame(vec2 p, vec4 pos) {
  vec2 d = p - pos.xy;
  return vec2(dot(d, pos.zw), dot(d, vec2(-pos.w, pos.z)));
}
/** The waterline's half width: full aft, fining toward the bow. */
float hullHalfWidth(float a, vec4 dim) {
  float t = clamp((a - dim.y) / (dim.x - dim.y), 0.0, 1.0);
  return dim.z * (1.0 - 0.5 * t * t);
}
/**
 * The pressure's shape along and across the hull. Afloat, it follows the draft: level along
 * the middle and across the flat bottom, easing out at the bow and the transom. Planing, it is a
 * planing plate's: peaked at the spray root in front, falling to nothing at the transom where
 * the flow leaves clean, and highest along the keel.
 */
float hullShape(vec2 p, vec4 pos, vec4 dim, float planing) {
  vec2 h = hullFrame(p, pos);
  float len = dim.x - dim.y;
  float afloat = smoothstep(dim.y, dim.y + max(0.6, 0.1 * len), h.x) * (1.0 - smoothstep(dim.x - max(1.0, 0.3 * len), dim.x, h.x));
  float u = clamp((h.x - dim.y) / len, 0.0, 1.0);
  float plate = sqrt(u / (1.08 - u)) * (1.0 - smoothstep(0.86, 1.0, u)) * step(dim.y, h.x) * step(h.x, dim.x);
  float wa = mix(afloat, plate, planing);
  // Across: flat under a displacement hull's bottom, keeled under a planing V.
  float v = clamp(h.y / (hullHalfWidth(h.x, dim) + 0.3), -1.0, 1.0);
  float wb = mix(1.0 - v * v * v * v, (1.0 - v * v) * (1.0 - v * v), planing);
  return wa * wb;
}
/** Foam made per second at p by one hull. */
float hullFoam(vec2 p, vec4 pos, vec4 dim, vec4 foam) {
  vec2 h = hullFrame(p, pos);
  float len = dim.x - dim.y;
  float side = abs(h.y);
  // The wash: churned water from the transom aft, widening as it goes.
  float aft = dim.y - h.x;
  float wash = smoothstep(-0.4, 0.4, aft) * (1.0 - smoothstep(0.25 * len + 1.0, 0.6 * len + 2.0, aft))
    * (1.0 - smoothstep(dim.z * 0.9 + aft * 0.1, dim.z * 1.3 + aft * 0.15 + 0.4, side));
  // The spray sheets, landing in two lines beside the hull.
  float off = side - hullHalfWidth(h.x, dim);
  float sheet = smoothstep(0.4, 1.0, off) * (1.0 - smoothstep(1.4, 2.4, off))
    * smoothstep(dim.y - 1.0, dim.y + 0.5, h.x) * (1.0 - smoothstep(dim.y + 0.5 * len, dim.y + 0.8 * len, h.x));
  // The bow wave, heaped at the stem and peeling along both sides.
  float bow = smoothstep(dim.x - 0.4 * len, dim.x - 0.1 * len, h.x) * (1.0 - smoothstep(dim.x, dim.x + 1.2, h.x))
    * smoothstep(-0.3, 0.3, off) * (1.0 - smoothstep(0.7, 1.8, off));
  return foam.x * wash + foam.y * sheet + foam.z * bow;
}`;

/** Space: last frame's waves (shifted when the square moved), the hulls' pressure, splashes, absorption. */
const SPACE_FS = /* glsl */ `
precision highp float;
precision highp int;
uniform highp sampler2D uState;
uniform sampler2D uMask;
uniform vec4 uMaskXform;
uniform vec2 uOrigin;
uniform ivec2 uShift;
uniform int uN;
uniform float uCell;
uniform float uDt;
uniform float uSponge;
uniform float uFresh;
uniform vec2 uWater;
uniform float uTime;
${SOURCES_GLSL}
${HASH_GLSL}
out vec4 outColor;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 s = c + uShift;
  // Height and velocity potential.
  vec2 hp = vec2(0.0);
  if (uFresh < 0.5 && all(greaterThanEqual(s, ivec2(0))) && all(lessThan(s, ivec2(uN)))) hp = texelFetch(uState, s, 0).xy;
  vec2 p = (vec2(c) + 0.5) * uCell;
  float L = float(uN) * uCell;
  // The hulls press the water down: dφ/dt = -g (h + pressure head).
  float head = 0.0;
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= uHulls) break;
    head += uHullDim[i].w * hullShape(p, uHullPos[i], uHullDim[i], uHullFoam[i].w);
    // The wash boils: churned water heaving at random just behind the transom.
    vec2 hf = hullFrame(p, uHullPos[i]);
    float aft = uHullDim[i].y - hf.x;
    float boil = smoothstep(-0.3, 0.8, aft) * (1.0 - smoothstep(3.0, 9.0, aft)) * (1.0 - smoothstep(0.6, 1.0, abs(hf.y) / (uHullDim[i].z + 0.4 + aft * 0.12)));
    if (boil > 0.0) {
      vec2 q = p + uWater;
      float nz = vnoise(q * 1.1 + vec2(uTime * 1.3, -uTime * 0.9)) + vnoise(q * 2.3 - vec2(uTime * 1.1, uTime * 1.7)) - 1.0;
      head += uHullFoam[i].x * 0.03 * boil * nz;
    }
  }
  hp.y -= 9.81 * head * uDt;
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= uSplashes) break;
    vec2 d = (p - uSplash[i].xy) / uSplash[i].z;
    hp.x -= uSplash[i].w * exp(-dot(d, d));
  }
  // The square's edges absorb what leaves it; the land and the ships' hulls take what reaches them.
  float edge = min(min(p.x, p.y), min(L - p.x, L - p.y));
  float sp = clamp(1.0 - edge / uSponge, 0.0, 1.0);
  float water = textureLod(uMask, (p + uOrigin - uMaskXform.xy) * uMaskXform.zw, 0.0).r;
  hp *= exp(-(5.0 * sp * sp + 40.0 * (1.0 - smoothstep(0.3, 0.8, water))) * uDt);
  outColor = vec4(hp, 0.0, 0.0);
}`;

/**
 * The spectrum: split FFT(h + iφ) into the height's and the potential's, advance every wave by
 * ω dt (deep water: ω² = g|k|), damp the short ones, and pack the inverse transform's input:
 * RG = h + iφ, BA = Dx + iDz (the horizontal displacement, i k/|k| ĥ).
 */
const SPECTRAL_FS = /* glsl */ `
precision highp float;
precision highp int;
uniform highp sampler2D uSpec;
uniform int uN;
uniform float uL;
uniform float uDt;
uniform vec2 uDamp;
out vec4 outColor;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 cm = (ivec2(uN) - c) % uN;
  vec2 z = texelFetch(uSpec, c, 0).xy;
  vec2 zm = texelFetch(uSpec, cm, 0).xy;
  zm.y = -zm.y;
  vec2 h = 0.5 * (z + zm);
  vec2 d = 0.5 * (z - zm);
  vec2 phi = vec2(d.y, -d.x);
  ivec2 f = c - ivec2(greaterThanEqual(c, ivec2(uN / 2))) * uN;
  vec2 kv = vec2(f) * (6.283185307179586 / uL);
  float k = length(kv);
  vec4 o = vec4(0.0);
  if (k > 0.0) {
    float w = sqrt(9.81 * k);
    float cs = cos(w * uDt);
    float sn = sin(w * uDt);
    float damp = exp(-(uDamp.x + uDamp.y * k * k) * uDt);
    vec2 h2 = (h * cs + (k / w) * sn * phi) * damp;
    vec2 p2 = (phi * cs - (9.81 / w) * sn * h) * damp;
    o.xy = vec2(h2.x - p2.y, h2.y + p2.x);
    if (f.x != -uN / 2 && f.y != -uN / 2) {
      vec2 ih = vec2(-h2.y, h2.x) / k;
      vec2 fx = ih * kv.x;
      vec2 fz = ih * kv.y;
      o.zw = vec2(fx.x - fz.y, fx.y + fz.x);
    }
  }
  outColor = o;
}`;

/** The surface the water reads: displacement; slopes; foam, made, aged and spread. */
const SURFACE_FS = /* glsl */ `
precision highp float;
precision highp int;
uniform highp sampler2D uState;
uniform highp sampler2D uPrev;
uniform sampler2D uMask;
uniform vec4 uMaskXform;
uniform vec2 uOrigin;
uniform ivec2 uShift;
uniform int uN;
uniform float uCell;
uniform float uDt;
uniform float uChop;
uniform float uFresh;
${SOURCES_GLSL}
layout(location = 0) out vec4 oShape; // height, displacement x, z (metres)
layout(location = 1) out vec4 oSurf;  // slope x, z; fresh foam; old foam (lace)
vec4 state(ivec2 c) {
  return texelFetch(uState, clamp(c, ivec2(0), ivec2(uN - 1)), 0);
}
vec4 prev(ivec2 c) {
  ivec2 s = clamp(c, ivec2(0), ivec2(uN - 1)) + uShift;
  if (uFresh > 0.5 || any(lessThan(s, ivec2(0))) || any(greaterThanEqual(s, ivec2(uN)))) return vec4(0.0);
  return texelFetch(uPrev, s, 0);
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s0 = state(c);
  vec4 x1 = state(c + ivec2(1, 0));
  vec4 x0 = state(c - ivec2(1, 0));
  vec4 z1 = state(c + ivec2(0, 1));
  vec4 z0 = state(c - ivec2(0, 1));
  float k = 0.5 / uCell;
  float hx = (x1.x - x0.x) * k;
  float hz = (z1.x - z0.x) * k;
  float dxx = (x1.z - x0.z) * k * uChop;
  float dxz = (z1.z - z0.z) * k * uChop;
  float dzx = (x1.w - x0.w) * k * uChop;
  float dzz = (z1.w - z0.w) * k * uChop;
  // The displaced surface's tangents along the grid, its normal, and how far it folds (J < 1).
  vec3 n = cross(vec3(dxz, hz, 1.0 + dzz), vec3(1.0 + dxx, hx, dzx));
  vec2 slope = -n.xz / max(n.y, 0.05);
  float J = (1.0 + dxx) * (1.0 + dzz) - dxz * dzx;

  // Last frame's foam, spreading (fresh white water fast, lace slowly), and the white ageing into lace.
  vec4 p0 = prev(c);
  vec4 pn = prev(c + ivec2(1, 0)) + prev(c - ivec2(1, 0)) + prev(c + ivec2(0, 1)) + prev(c - ivec2(0, 1));
  float spread = uDt / (uCell * uCell);
  float fresh = mix(p0.z, pn.z * 0.25, clamp(1.2 * spread, 0.0, 1.0));
  float old = mix(p0.w, pn.w * 0.25, clamp(0.2 * spread, 0.0, 1.0));
  float age = 1.0 - exp(-uDt / 2.5);
  old = old * exp(-uDt / 25.0) + fresh * age * 0.6;
  fresh *= 1.0 - age;

  // New foam: the hulls, crests steep enough to break, waves on the quays, splashes.
  vec2 p = (vec2(c) + 0.5) * uCell;
  float src = 0.0;
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= uHulls) break;
    src += hullFoam(p, uHullPos[i], uHullDim[i], uHullFoam[i]);
  }
  src += clamp((0.5 - J) * 5.0, 0.0, 2.5) + clamp((length(slope) - 0.42) * 5.0, 0.0, 2.5);
  vec2 muv = (p + uOrigin - uMaskXform.xy) * uMaskXform.zw;
  float water = textureLod(uMask, muv, 0.0).r;
  float near = textureLod(uMask, muv, 2.5).r;
  src += (1.0 - smoothstep(0.7, 0.97, near)) * smoothstep(0.05, 0.22, abs(s0.x)) * 4.0;
  fresh += src * uDt;
  for (int i = 0; i < ${MAX}; i++) {
    if (i >= uSplashes) break;
    vec2 d = (p - uSplash[i].xy) / (uSplash[i].z * 1.6);
    fresh += uSplash[i].w * 3.0 * exp(-dot(d, d));
  }
  float wet = smoothstep(0.2, 0.6, water);
  oShape = vec4(s0.x, s0.z * uChop, s0.w * uChop, 0.0);
  oSurf = vec4(slope, min(fresh, 1.6) * wet, min(old, 1.0) * wet);
}`;

/** The heights at the probe points (uv in the square), for the boat's motion. */
const PROBE_FS = /* glsl */ `
precision highp float;
uniform sampler2D uShape;
uniform vec2 uProbe[8];
out vec4 outColor;
void main() {
  outColor = vec4(textureLod(uShape, uProbe[int(gl_FragCoord.x)], 0.0).x, 0.0, 0.0, 1.0);
}`;

/**
 * The foam's detail, painted once: tileable lace (the thin marbled filaments old foam leaves,
 * two sizes), froth (white water pocked with bubbles, in clumps), and a slow noise for patchiness.
 */
const FOAM_FS = /* glsl */ `
precision highp float;
uniform float uSize;
out vec4 outColor;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
/** Value noise with period P (in cells). */
float noiseT(vec2 p, float P) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(mod(i, P));
  float b = hash12(mod(i + vec2(1.0, 0.0), P));
  float c = hash12(mod(i + vec2(0.0, 1.0), P));
  float d = hash12(mod(i + vec2(1.0, 1.0), P));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbmT(vec2 p, float P) {
  float s = 0.0;
  float a = 0.5;
  for (int o = 0; o < 4; o++) {
    s += a * noiseT(p, P);
    p *= 2.0;
    P *= 2.0;
    a *= 0.5;
  }
  return s / 0.9375;
}
/** Distances to the nearest and second-nearest feature points, period P. */
vec2 worleyT(vec2 p, float P) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      float d = length(g + hash22(mod(i + g, P)) - f);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) f2 = d;
    }
  return vec2(f1, f2);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec2 w = vec2(fbmT(uv * 4.0, 4.0), fbmT(uv * 4.0 + 17.0, 4.0)) - 0.5;
  // Lace: thin curving filaments, where a strongly warped noise crosses its middle (marbling), two sizes.
  vec2 w2 = vec2(fbmT(uv * 6.0 + 31.0, 6.0), fbmT(uv * 6.0 + 47.0, 6.0)) - 0.5;
  float r1 = 1.0 - abs(2.0 * fbmT(uv * 5.0 + w * 2.2 + w2 * 0.8, 5.0) - 1.0);
  float r2 = 1.0 - abs(2.0 * fbmT(uv * 13.0 + w * 3.5 + w2 * 2.0, 13.0) - 1.0);
  float vary = fbmT(uv * 8.0 + 5.0, 8.0);
  float laceA = pow(r1, 9.0) * smoothstep(0.25, 0.65, vary + 0.15);
  float laceB = pow(r2, 7.0) * (0.6 + 0.4 * vary);
  // Froth: white, pocked with fine bubbles of two sizes, in clumps.
  float b1 = worleyT(uv * 48.0 + w * 4.0, 48.0).x;
  float b2 = worleyT(uv * 96.0 + w * 6.0, 96.0).x;
  float froth = 1.0 - 0.55 * (1.0 - smoothstep(0.1, 0.32, b1)) - 0.4 * (1.0 - smoothstep(0.08, 0.28, b2));
  float clump = fbmT(uv * 7.0 + 3.0, 7.0);
  outColor = vec4(laceA, laceB, clamp(froth * 0.55 + clump * 0.45, 0.0, 1.0), fbmT(uv * 3.0 + 9.0, 3.0));
}`;

/** JS twin of hullShape's area (m² of full pressure), for the pressure head a volume needs. */
function hullArea(front: number, back: number, hb: number, planing: number): number {
  const ss = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const len = front - back;
  const d = 0.05;
  let s = 0;
  for (let a = back; a <= front; a += d) {
    const afloat = ss(back, back + Math.max(0.6, 0.1 * len), a) * (1 - ss(front - Math.max(1, 0.3 * len), front, a));
    const u = Math.min(1, Math.max(0, (a - back) / len));
    const plate = Math.sqrt(u / (1.08 - u)) * (1 - ss(0.86, 1, u));
    const hw = hb * (1 - 0.5 * u * u) + 0.3;
    // Across, ∫ (1 - v⁴) dv over [-1, 1] is 8/5 and ∫ (1 - v²)² dv is 16/15.
    s += (afloat + (plate - afloat) * planing) * hw * (8 / 5 + (16 / 15 - 8 / 5) * planing);
  }
  return s * d;
}

/**
 * The patch's mesh: rings around the camera, from 12 cm out to 100 m, square cells all the way
 * (so the detail on screen stays about even), and a last ring far out that the vertex shader
 * clamps to the square's edge. `position.y` holds each ring's spacing, for the mip to sample.
 */
function patchGeometry(): BufferGeometry {
  const SEG = 192;
  const grow = 1 + (2 * Math.PI) / SEG;
  const radii: number[] = [];
  for (let r = 0.12; r < 100; r *= grow) radii.push(r);
  radii.push(1e5);
  const pos: number[] = [0, 0.1, 0];
  for (const r of radii)
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2;
      pos.push(r * Math.cos(a), Math.min(r * (grow - 1), 40), r * Math.sin(a));
    }
  const idx: number[] = [];
  const at = (ring: number, s: number) => 1 + ring * SEG + (s % SEG);
  for (let s = 0; s < SEG; s++) idx.push(0, at(0, s + 1), at(0, s));
  for (let k = 0; k + 1 < radii.length; k++)
    for (let s = 0; s < SEG; s++) idx.push(at(k, s), at(k, s + 1), at(k + 1, s), at(k, s + 1), at(k + 1, s + 1), at(k + 1, s));
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  const nor = new Float32Array(pos.length);
  for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  g.setAttribute("normal", new BufferAttribute(nor, 3));
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let i = 0; i < pos.length / 3; i++) uv.set([pos[i * 3] / 24, pos[i * 3 + 2] / 24], i * 2);
  g.setAttribute("uv", new BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

export class Wake {
  /** The water's uniforms (water.ts puts these very objects in its materials). */
  readonly uniforms = {
    /** 1 while the square holds waves. */
    uWakeOn: { value: 0 },
    /** Height and displacement; slopes and foam (the surface pass's two targets). */
    uWakeShape: { value: null as Texture | null },
    uWakeSurf: { value: null as Texture | null },
    /** The square's corner (world x, z) and size (m). */
    uWakeOrigin: { value: new Vector2() },
    uWakeSize: { value: 256 },
    /** How far the water has drifted (world metres), and the downstream direction the square's ripples run in. */
    uWakeDrift: { value: new Vector2() },
    uWakeFlow: { value: new Vector2(0, 1) },
    /** Metres in from the square's edge where the river's own ripples give way to the square's. */
    uWakeBlend: { value: new Vector2(2, 11) },
    uFoamTex: { value: null as Texture | null },
    /** The displaced patch: drawn (1) or not; the rectangle it covers (x0, z0, x1, z1); its centre. */
    uPatchOn: { value: 0 },
    uPatchRect: { value: new Vector4() },
    uPatchCentre: { value: new Vector2() },
    /** The runabout (x, z, forward x, z), whose hull the patch keeps the water out of. */
    uHull: { value: new Vector4() },
    uHullOn: { value: 0 },
  };
  /** The displaced water around the camera; water.ts gives it the water's material. */
  readonly patch: Mesh;
  /** The boat's motion on the waves (metres, radians: bow up, starboard up), from the probe. */
  readonly motion = { heave: 0, pitch: 0, roll: 0 };
  readonly supported: boolean;

  private n = 0;
  private readonly cell = WAKE.cell;
  private readonly fft: GpuFft | null = null;
  private readonly io: WebGLRenderTarget;
  private readonly surfaces: WebGLRenderTarget[];
  private cur = 0;
  private state: WebGLRenderTarget | null = null;
  private readonly quad = new FullScreenQuad();
  private readonly space: ShaderMaterial;
  private readonly spectral: ShaderMaterial;
  private readonly surface: ShaderMaterial;
  private readonly probeMat: ShaderMaterial;
  private readonly probe: WebGLRenderTarget;
  private readonly probeBuf = new Float32Array(32);
  private reading = false;
  private probeNew = false;
  private readonly mask: WebGLRenderTarget;
  private readonly maskScene = new Scene();
  private readonly maskCam = new OrthographicCamera();
  private readonly maskCentre = new Vector2(Infinity, Infinity);
  private readonly maskXform = new Vector4();
  private readonly sources = {
    uHullPos: { value: Array.from({ length: MAX }, () => new Vector4()) },
    uHullDim: { value: Array.from({ length: MAX }, () => new Vector4()) },
    uHullFoam: { value: Array.from({ length: MAX }, () => new Vector4()) },
    uHulls: { value: 0 },
    uSplash: { value: Array.from({ length: MAX }, () => new Vector4()) },
    uSplashes: { value: 0 },
  };
  /** The square's corner in the water's frame, in cells; the water's drift; the clock. */
  private readonly origin = { x: 0, z: 0 };
  private readonly drift = new Vector2();
  private t = 0;
  private lastBoat = -Infinity;
  private running = false;
  private hullCount = 0;
  private readonly splashes: WakeSplash[] = [];
  private readonly areas = new Map<string, number>();
  /** Each hull's pressure, easing in (0 to 1) since it came into the square: no sudden start. */
  private readonly ease = new Map<string, number>();
  /** Low-passed probe readings (the boat's own steady trim, which isn't motion) and the motion's velocity. */
  private readonly trim = { mean: 0, pitch: 0, roll: 0, set: false };
  private readonly target = { heave: 0, pitch: 0, roll: 0 };
  private readonly vel = { heave: 0, pitch: 0, roll: 0 };

  /** `water`: the river's meshes (the waves stay in them); `blocks`: what stands in it (piers, moored craft). */
  constructor(
    renderer: WebGLRenderer,
    private readonly river: River,
    water: Mesh[],
    blocks: WakeBlock[],
  ) {
    this.supported = renderer.extensions.has("EXT_color_buffer_float");
    this.patch = new Mesh(patchGeometry());
    this.patch.frustumCulled = false;
    this.patch.receiveShadow = true;
    this.patch.visible = false;
    this.patch.name = "wake patch";
    const n = QUALITY.wake || 256;
    this.io = floatTarget(n);
    const half = { type: HalfFloatType, format: RGBAFormat, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter, generateMipmaps: true, depthBuffer: false, wrapS: ClampToEdgeWrapping, wrapT: ClampToEdgeWrapping, count: 2 };
    this.surfaces = [new WebGLRenderTarget(n, n, half), new WebGLRenderTarget(n, n, half)];
    this.mask = new WebGLRenderTarget(n, n, { type: UnsignedByteType, format: RedFormat, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter, generateMipmaps: true, depthBuffer: false });
    this.probe = new WebGLRenderTarget(8, 1, { type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false });
    const common = {
      uMask: { value: this.mask.texture },
      uMaskXform: { value: this.maskXform },
      uOrigin: { value: new Vector2() },
      // An ivec2 in the shaders: cells the square moved this step.
      uShift: { value: [0, 0] },
      uN: { value: n },
      uCell: { value: this.cell },
      uDt: { value: 0 },
      uFresh: { value: 1 },
      ...this.sources,
    };
    this.space = passMaterial(SPACE_FS, { ...common, uState: { value: null }, uSponge: { value: 20 }, uWater: { value: new Vector2() }, uTime: { value: 0 } });
    this.spectral = passMaterial(SPECTRAL_FS, { uSpec: { value: null }, uN: common.uN, uL: { value: 256 }, uDt: common.uDt, uDamp: { value: new Vector2(0.008, 0.05) } });
    this.surface = passMaterial(SURFACE_FS, { ...common, uState: { value: null }, uPrev: { value: null }, uChop: { value: WAKE.chop } });
    this.probeMat = passMaterial(PROBE_FS, { uShape: { value: null }, uProbe: { value: Array.from({ length: 8 }, () => new Vector2()) } });
    if (this.supported) this.fft = new GpuFft(n);
    this.buildMask(water, blocks);
    this.uniforms.uFoamTex.value = this.paintFoam(renderer);
  }

  /** Queue a crater for the next step. */
  splash(s: WakeSplash): void {
    if (this.splashes.length < MAX) this.splashes.push(s);
  }

  /** Whether the square holds the waves at (x, z) (well inside its absorbing edge). */
  covers(x: number, z: number): boolean {
    if (!this.running) return false;
    const o = this.uniforms.uWakeOrigin.value;
    const L = this.uniforms.uWakeSize.value;
    const m = L * WAKE.sponge * 1.5;
    return x > o.x + m && x < o.x + L - m && z > o.y + m && z < o.y + L - m;
  }

  describe(): string {
    if (!this.supported) return "wake: no float targets";
    if (!this.running) return `wake ${this.n}² idle`;
    const o = this.uniforms.uWakeOrigin.value;
    return `wake ${this.n}² ${this.n * this.cell} m at ${o.x.toFixed(0)}, ${o.y.toFixed(0)}; ${this.hullCount} hulls; heave ${this.motion.heave.toFixed(2)}`;
  }

  /**
   * One step. `eye`: the camera; `boat`: the runabout (on the water or not); `hulls`: everything
   * pressing on the water this frame, the runabout first.
   */
  update(renderer: WebGLRenderer, dt: number, eye: Vector3, boat: { x: number; z: number; heading: number; onWater: boolean }, hulls: WakeHull[]): void {
    const n = this.supported ? QUALITY.wake : 0;
    if (n !== this.n) this.resize(n);
    this.t += dt;
    if (boat.onWater) this.lastBoat = this.t;
    const L = n * this.cell;
    const centre = (o: number, d: number) => (o + n / 2) * this.cell + d;
    const cx = centre(this.origin.x, this.drift.x);
    const cz = centre(this.origin.z, this.drift.y);
    const wanted = n > 0 && (boat.onWater || (this.running && this.t - this.lastBoat < WAKE.linger && Math.hypot(eye.x - cx, eye.z - cz) < 3 * L));
    if (!wanted) return this.halt(dt);
    dt = Math.min(dt, 0.05);

    // The water drifts downstream, carrying the waves and the foam with it.
    const flow = this.river.flowAt(boat.onWater ? boat.x : cx, boat.onWater ? boat.z : cz);
    this.drift.x += flow.x * WAKE.current * dt;
    this.drift.y += flow.z * WAKE.current * dt;
    // The boat in the water's frame, in cells; a fresh square when it's somewhere new.
    const bx = (boat.x - this.drift.x) / this.cell;
    const bz = (boat.z - this.drift.y) / this.cell;
    let fresh = !this.running;
    if (boat.onWater && Math.max(Math.abs(bx - (this.origin.x + n / 2)), Math.abs(bz - (this.origin.z + n / 2))) > n * 0.6) fresh = true;
    let sx = 0;
    let sz = 0;
    if (fresh) {
      this.origin.x = Math.round(bx) - n / 2;
      this.origin.z = Math.round(bz) - n / 2;
      // The square's ripples run with the river here, for as long as this square lasts.
      this.uniforms.uWakeFlow.value.set(flow.x, flow.z);
      this.trim.set = false;
    } else if (boat.onWater) {
      // On a leash: the square follows only when the boat strays too far from its centre.
      const lim = WAKE.leash * n;
      const ox = bx - (this.origin.x + n / 2);
      const oz = bz - (this.origin.z + n / 2);
      sx = ox > lim ? Math.ceil(ox - lim) : ox < -lim ? Math.floor(ox + lim) : 0;
      sz = oz > lim ? Math.ceil(oz - lim) : oz < -lim ? Math.floor(oz + lim) : 0;
      this.origin.x += sx;
      this.origin.z += sz;
    }
    this.running = true;
    const ox = this.origin.x * this.cell + this.drift.x;
    const oz = this.origin.z * this.cell + this.drift.y;
    if (fresh || Math.hypot(ox + L / 2 - this.maskCentre.x, oz + L / 2 - this.maskCentre.y) > L * 0.1) this.renderMask(renderer, ox + L / 2, oz + L / 2, L);

    // Sources, in the square's metres.
    const src = this.sources;
    let h = 0;
    if (fresh) this.ease.clear();
    const seen = new Set<string>();
    for (const hull of hulls) {
      const lx = hull.x - ox;
      const lz = hull.z - oz;
      const m = 4;
      if (h >= MAX || lx < m || lz < m || lx > L - m || lz > L - m) continue;
      seen.add(hull.id);
      const ease = Math.min(1, (this.ease.get(hull.id) ?? 0) + dt / 2.5);
      this.ease.set(hull.id, ease);
      const f = forwardOf(hull.heading);
      const planing = Math.round(hull.planing * 10) / 10;
      const key = `${hull.front.toFixed(1)} ${hull.back.toFixed(1)} ${hull.halfBeam.toFixed(2)} ${planing}`;
      let area = this.areas.get(key);
      if (area === undefined) this.areas.set(key, (area = hullArea(hull.front, hull.back, hull.halfBeam, planing)));
      src.uHullPos.value[h].set(lx, lz, f.x, f.z);
      src.uHullDim.value[h].set(hull.front, hull.back, hull.halfBeam, (WAKE.gain * hull.volume * ease * ease * (3 - 2 * ease)) / area);
      src.uHullFoam.value[h].set(hull.wash, hull.spray, hull.bow, planing);
      h++;
    }
    for (const id of this.ease.keys()) if (!seen.has(id)) this.ease.delete(id);
    src.uHulls.value = this.hullCount = h;
    src.uSplashes.value = this.splashes.length;
    this.splashes.forEach((s, i) => src.uSplash.value[i].set(s.x - ox, s.z - oz, s.radius, s.depth));
    this.splashes.length = 0;

    const prevTarget = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    // Shared by the space and surface passes.
    const u = this.space.uniforms;
    u.uOrigin.value.set(ox, oz);
    u.uShift.value = [sx, sz];
    u.uDt.value = dt;
    u.uFresh.value = fresh ? 1 : 0;
    this.space.uniforms.uWater.value.set(this.origin.x * this.cell, this.origin.z * this.cell);
    this.space.uniforms.uTime.value = this.t;
    // Space → spectrum → advanced → space again.
    const fft = this.fft!;
    this.space.uniforms.uState.value = (this.state ?? fft.a).texture;
    this.pass(renderer, this.space, this.io);
    const spec = fft.run(renderer, this.io.texture, false);
    this.spectral.uniforms.uSpec.value = spec.texture;
    this.spectral.uniforms.uDt.value = dt;
    this.pass(renderer, this.spectral, this.io);
    this.state = fft.run(renderer, this.io.texture, true);
    // The surface, from the waves and last frame's foam.
    const prev = this.surfaces[this.cur];
    this.cur = 1 - this.cur;
    const surf = this.surfaces[this.cur];
    this.surface.uniforms.uState.value = this.state.texture;
    this.surface.uniforms.uPrev.value = prev.textures[1];
    this.pass(renderer, this.surface, surf);
    this.sampleProbe(renderer, boat, surf, ox, oz, L);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = autoClear;

    const w = this.uniforms;
    w.uWakeOn.value = 1;
    w.uWakeShape.value = surf.textures[0];
    w.uWakeSurf.value = surf.textures[1];
    w.uWakeOrigin.value.set(ox, oz);
    w.uWakeSize.value = L;
    w.uWakeDrift.value.copy(this.drift);
    const sponge = L * WAKE.sponge;
    w.uWakeBlend.value.set(sponge * 0.1, sponge * 0.55);
    const inset = sponge * 0.6;
    w.uPatchRect.value.set(ox + inset, oz + inset, ox + L - inset, oz + L - inset);
    w.uPatchCentre.value.set(eye.x, eye.z);
    // The patch only near the square and low enough for the waves' relief to show.
    const dx = Math.max(0, Math.abs(eye.x - (ox + L / 2)) - L / 2);
    const dz = Math.max(0, Math.abs(eye.z - (oz + L / 2)) - L / 2);
    this.patch.visible = Math.hypot(dx, dz) < L && eye.y < 150;
    w.uPatchOn.value = this.patch.visible ? 1 : 0;
    const f = forwardOf(boat.heading);
    w.uHull.value.set(boat.x, boat.z, f.x, f.z);
    w.uHullOn.value = boat.onWater ? 1 : 0;
    this.respond(dt, boat.onWater);
  }

  private pass(renderer: WebGLRenderer, mat: ShaderMaterial, target: WebGLRenderTarget): void {
    this.quad.material = mat;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  /** Run every pass once on calm water, so no program compiles at the first landing. */
  prime(renderer: WebGLRenderer): void {
    if (!this.supported) return;
    this.update(renderer, 1 / 60, this.patch.position, { x: 0, z: 0, heading: 0, onWater: true }, []);
    this.halt(0);
    this.lastBoat = -Infinity;
  }

  /** Nothing to simulate: the water goes back to its own ripples. */
  private halt(dt: number): void {
    this.running = false;
    this.uniforms.uWakeOn.value = 0;
    this.uniforms.uPatchOn.value = 0;
    this.uniforms.uHullOn.value = 0;
    this.patch.visible = false;
    this.respond(dt, false);
  }

  private resize(n: number): void {
    this.n = n;
    this.running = false;
    this.state = null;
    if (!n) return;
    this.io.setSize(n, n);
    for (const s of this.surfaces) s.setSize(n, n);
    this.mask.setSize(n, n);
    this.fft?.setSize(n);
    this.maskCentre.set(Infinity, Infinity);
    const L = n * this.cell;
    this.space.uniforms.uN.value = n;
    this.surface.uniforms.uN.value = n;
    this.space.uniforms.uSponge.value = L * WAKE.sponge;
    this.spectral.uniforms.uL.value = L;
  }

  /** The probe points (bow, stern, port, starboard, middle) under the runabout, read back asynchronously. */
  private sampleProbe(renderer: WebGLRenderer, boat: { x: number; z: number; heading: number; onWater: boolean }, surf: WebGLRenderTarget, ox: number, oz: number, L: number): void {
    if (!boat.onWater || this.reading) return;
    const f = forwardOf(boat.heading);
    // Inboard of the bow and transom: the hollow the transom leaves isn't under the hull.
    const pts: [number, number][] = [
      [2, 0],
      [-1.5, 0],
      [0, -0.8],
      [0, 0.8],
      [0, 0],
    ];
    const uv = this.probeMat.uniforms.uProbe.value as Vector2[];
    pts.forEach(([a, b], i) => uv[i].set((boat.x + f.x * a - f.z * b - ox) / L, (boat.z + f.z * a + f.x * b - oz) / L));
    this.probeMat.uniforms.uShape.value = surf.textures[0];
    this.pass(renderer, this.probeMat, this.probe);
    this.reading = true;
    renderer
      .readRenderTargetPixelsAsync(this.probe, 0, 0, 8, 1, this.probeBuf)
      .then(() => (this.probeNew = true))
      .catch(() => {})
      .finally(() => (this.reading = false));
  }

  /** The boat answers the waves under it (not its own steady trim) like a hull with some inertia. */
  private respond(dt: number, onWater: boolean): void {
    const t = this.target;
    if (!onWater) t.heave = t.pitch = t.roll = 0;
    else if (this.probeNew) {
      this.probeNew = false;
      const v = this.probeBuf;
      const [bow, stern, port, star, mid] = [v[0], v[4], v[8], v[12], v[16]];
      // A hull spans the shorter waves and rides them out: about two thirds of the surface's motion.
      const mean = ((bow + stern + port + star + mid) / 5) * 0.7;
      const pitch = Math.atan2(bow - stern, 3.5) * 0.6;
      const roll = Math.atan2(star - port, 1.6) * 0.6;
      const r = this.trim;
      if (!r.set) Object.assign(r, { mean, pitch, roll, set: true });
      const k = 1 - Math.exp(-dt / 1.2);
      r.mean += (mean - r.mean) * k;
      r.pitch += (pitch - r.pitch) * k;
      r.roll += (roll - r.roll) * k;
      t.heave = mean - r.mean;
      t.pitch = pitch - r.pitch;
      t.roll = roll - r.roll;
    }
    const w = 7;
    for (const key of ["heave", "pitch", "roll"] as const) {
      const a = w * w * (t[key] - this.motion[key]) - 2 * 0.6 * w * this.vel[key];
      this.vel[key] += a * dt;
      this.motion[key] += this.vel[key] * dt;
    }
  }

  /** The water mask: the river white, the piers and craft standing in it black. */
  private buildMask(water: Mesh[], blocks: WakeBlock[]): void {
    const white = new MeshBasicMaterial({ color: new Color(1, 1, 1), side: DoubleSide });
    const black = new MeshBasicMaterial({ color: new Color(0, 0, 0), side: DoubleSide });
    const proxy = (m: Mesh, mat: MeshBasicMaterial, order: number) => {
      m.updateWorldMatrix(true, false);
      const p = new Mesh(m.geometry, mat);
      p.matrixAutoUpdate = false;
      p.matrix.copy(m.matrixWorld);
      p.matrixWorldNeedsUpdate = true;
      p.renderOrder = order;
      p.frustumCulled = false;
      this.maskScene.add(p);
    };
    for (const m of water) proxy(m, white, 0);
    if (blocks.length) {
      const pos: number[] = [];
      for (const b of blocks) {
        const corner = (sa: number, sb: number) => [b.cx + b.ux * b.halfAlong * sa - b.uz * b.halfAcross * sb, 0, b.cz + b.uz * b.halfAlong * sa + b.ux * b.halfAcross * sb];
        const [p0, p1, p2, p3] = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
        pos.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
      }
      const g = new BufferGeometry();
      g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
      const m = new Mesh(g, black);
      m.renderOrder = 1;
      m.frustumCulled = false;
      this.maskScene.add(m);
    }
    // Looking straight down, with the target's v running toward +z.
    this.maskCam.up.set(0, 0, -1);
    this.maskCam.near = 1;
    this.maskCam.far = 1000;
  }

  /** The mask over a square a quarter bigger than the waves', centred on (x, z). */
  private renderMask(renderer: WebGLRenderer, x: number, z: number, L: number): void {
    const size = L * 1.25;
    const cam = this.maskCam;
    cam.left = -size / 2;
    cam.right = size / 2;
    cam.top = -size / 2;
    cam.bottom = size / 2;
    cam.position.set(x, 500, z);
    cam.lookAt(x, 0, z);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.maskCentre.set(x, z);
    this.maskXform.set(x - size / 2, z - size / 2, 1 / size, 1 / size);
    const prev = renderer.getRenderTarget();
    const colour = renderer.getClearColor(new Color());
    const alpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.mask);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.maskScene, cam);
    renderer.autoClear = autoClear;
    renderer.setClearColor(colour, alpha);
    renderer.setRenderTarget(prev);
  }

  private paintFoam(renderer: WebGLRenderer): Texture {
    const size = 512;
    const rt = new WebGLRenderTarget(size, size, { minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter, generateMipmaps: true, wrapS: RepeatWrapping, wrapT: RepeatWrapping, depthBuffer: false });
    const mat = passMaterial(FOAM_FS, { uSize: { value: size } });
    const prev = renderer.getRenderTarget();
    this.pass(renderer, mat, rt);
    renderer.setRenderTarget(prev);
    mat.dispose();
    rt.texture.anisotropy = 4;
    return rt.texture;
  }
}
