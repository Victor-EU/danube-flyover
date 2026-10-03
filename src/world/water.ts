// The river surface: MeshStandardMaterial with three layers of the normal map scrolling with
// the flow (the river mesh's u runs downstream in metres), the sky's cube map for reflections,
// the sun's own glint, and near the two money shots (Parliament and the Chain Bridge) a
// planar reflection of the lit scene, mixed in by distance so it never pops. In the wake's
// square (wake.ts) the ripples drift with the water instead, and the simulated waves tilt the
// surface and foam whitens it; a dense patch of the same material around the camera is
// displaced by the waves, and the river gives way to it there. Night light streaks are
// separate sprites (nightLights.ts).

import {
  Color,
  HalfFloatType,
  type IUniform,
  type Layers,
  Matrix4,
  type Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Plane,
  type Scene,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from "three";
import { QUALITY, TEXTURES, WAKE } from "../config";
import { SHARED } from "./night";
import { patchMaterial, type ShaderPatch } from "./shaderPatch";
import type { Wake } from "./wake";

/**
 * Layers kept out of the reflection: the water itself, its streaks, the trees, the labels, the
 * roofs' small detail (chimneys, rooftop units), and the full terrain, which a coarse one (on
 * MIRROR_ONLY) stands in for there.
 */
export const LAYER = { water: 1, trees: 2, labels: 3, terrain: 4, details: 6 };
/** Drawn only in the reflection. */
export const MIRROR_ONLY = 5;
/**
 * The reflection's terrain takes every 4th sample (40 m): the full one was two thirds of the
 * pass's triangles, for detail the ripples and the half resolution blur away.
 */
export const MIRROR_TERRAIN_STRIDE = 4;

export interface MirrorZone {
  x: number;
  z: number;
  /** Full reflection within `inner` metres of the camera, none beyond `outer`. */
  inner: number;
  outer: number;
}

const FLOW = 0.6 / TEXTURES.waterTile; // tiles per second downstream

/** The wake's uniforms when there is no wake: never on. */
function idleWake(): Record<string, IUniform> {
  const tex = { value: null };
  return {
    uWakeOn: { value: 0 },
    uWakeShape: tex,
    uWakeSurf: tex,
    uWakeOrigin: { value: new Vector2() },
    uWakeSize: { value: 1 },
    uWakeDrift: { value: new Vector2() },
    uWakeFlow: { value: new Vector2(0, 1) },
    uWakeBlend: { value: new Vector2(1, 2) },
    uFoamTex: tex,
    uPatchOn: { value: 0 },
    uPatchRect: { value: new Vector4() },
    uPatchCentre: { value: new Vector2() },
    uHull: { value: new Vector4() },
    uHullOn: { value: 0 },
  };
}

/** The three ripple layers' slope in tangent space, at the flow coordinates uv (in tiles). */
const RIPPLES_GLSL = /* glsl */ `
vec2 ripples(vec2 uvA, vec2 uvB, vec2 uvC) {
  vec2 n1 = texture2D(normalMap, uvA).xy * 2.0 - 1.0;
  vec2 n2 = texture2D(normalMap, uvB).xy * 2.0 - 1.0;
  vec2 n3 = texture2D(normalMap, uvC).xy * 2.0 - 1.0;
  return n1 * 0.6 + n2 * 0.5 + n3 * 0.8;
}`;

/**
 * The river's shader (and the patch's, with WAKE_PATCH): the ripples, the wake's waves and
 * foam, the planar reflection and the night cap on highlights.
 */
function waterPatch(key: string, uniforms: Record<string, IUniform>): ShaderPatch {
  const tile = TEXTURES.waterTile.toFixed(1);
  return {
    key,
    uniforms,
    vertexPars: /* glsl */ `
      uniform mat4 uMirrorMatrix;
      varying vec4 vMirrorCoord;
      varying vec2 vWakeWorld;
      #ifdef WAKE_PATCH
        uniform sampler2D uWakeShape;
        uniform vec2 uWakeOrigin;
        uniform float uWakeSize;
        uniform vec4 uPatchRect;
        uniform vec2 uPatchCentre;
        uniform vec4 uHull;
        uniform float uHullOn;
      #endif`,
    vertex: [
      [
        "begin_vertex",
        /* glsl */ `
        #ifdef WAKE_PATCH
        {
          // Rings around the camera, clamped to the patch's rectangle; position.y is the ring's spacing.
          vec2 wp = clamp(uPatchCentre + transformed.xz, uPatchRect.xy, uPatchRect.zw);
          float lod = log2(max(transformed.y / ${WAKE.cell.toFixed(2)}, 1.0));
          vec3 s = textureLod(uWakeShape, (wp - uWakeOrigin) / uWakeSize, lod).xyz;
          // The relief fades out toward the rectangle's edge, where the river carries on flat.
          vec2 e = min(wp - uPatchRect.xy, uPatchRect.zw - wp);
          float fade = smoothstep(0.0, 6.0, min(e.x, e.y));
          vWakeWorld = wp;
          transformed = vec3(wp.x + s.y * fade, s.x * fade, wp.y + s.z * fade);
          // Inside the runabout's waterline the water stays under its V bottom.
          if (uHullOn > 0.5) {
            vec2 d = wp - uHull.xy;
            float a = dot(d, uHull.zw);
            float b = abs(dot(d, vec2(-uHull.w, uHull.z)));
            if (a > -2.45 && a < 3.0 && b < 0.68 * pow(clamp((3.1 - a) / 4.9, 0.0, 1.0), 0.45)) transformed.y = min(transformed.y, -0.4 + 0.46 * b);
          }
        }
        #else
          vWakeWorld = (modelMatrix * vec4(transformed, 1.0)).xz;
        #endif
        vMirrorCoord = uMirrorMatrix * (modelMatrix * vec4(transformed, 1.0));`,
      ],
    ],
    fragmentPars: /* glsl */ `
      uniform float uTime;
      uniform float uNight;
      uniform float uFlow;
      uniform sampler2D uMirror;
      uniform float uMirrorWeight;
      varying vec4 vMirrorCoord;
      varying vec2 vWakeWorld;
      uniform float uWakeOn;
      uniform sampler2D uWakeSurf;
      uniform vec2 uWakeOrigin;
      uniform float uWakeSize;
      uniform vec2 uWakeDrift;
      uniform vec2 uWakeFlow;
      uniform vec2 uWakeBlend;
      uniform sampler2D uFoamTex;
      uniform float uPatchOn;
      uniform vec4 uPatchRect;
      float gWakeFoam;`,
    fragment: [
      // ripples() reads normalMap, which three declares after <common>.
      ["normalmap_pars_fragment", RIPPLES_GLSL],
      [
        "clipping_planes_fragment",
        /* glsl */ `
        #ifndef WAKE_PATCH
          // The patch draws the water here.
          if (uPatchOn > 0.5 && all(greaterThan(vWakeWorld, uPatchRect.xy)) && all(lessThan(vWakeWorld, uPatchRect.zw))) discard;
        #endif`,
      ],
      [
        "normal_fragment_maps",
        /* glsl */ `
        vec2 waterSlope = vec2(0.0); // the surface's world slope (x, z): ripples and waves
        gWakeFoam = 0.0;
        #ifdef USE_NORMALMAP_TANGENTSPACE
        {
          vec2 wuv = (vWakeWorld - uWakeOrigin) / uWakeSize;
          #ifdef WAKE_PATCH
            float wIn = 1.0;
          #else
            vec2 e = min(wuv, 1.0 - wuv) * uWakeSize;
            float wIn = uWakeOn * smoothstep(uWakeBlend.x, uWakeBlend.y, min(e.x, e.y));
          #endif
          vec2 ripple = vec2(0.0);
          #ifndef WAKE_PATCH
          if (wIn < 0.999) {
            // The river's flow coordinates; three layers at different scales and angles, so no one ripple direction lines up.
            vec2 ts = ripples(
              vNormalMapUv - vec2(uTime * uFlow, 0.0),
              mat2(0.8, 0.6, -0.6, 0.8) * vNormalMapUv * 2.3 + vec2(-uTime * uFlow * 1.6, uTime * 0.01),
              mat2(0.34, -0.94, 0.94, 0.34) * vNormalMapUv * 0.37 + vec2(-uTime * uFlow * 0.5, 0.0));
            vec3 nw = inverseTransformDirection(tbn * normalize(vec3(ts * normalScale, 1.0)), viewMatrix);
            ripple += (1.0 - wIn) * -nw.xz / max(nw.y, 0.2);
          }
          #endif
          vec4 wb = vec4(0.0);
          if (wIn > 0.001) {
            // In the wake's square the ripples ride the drifting water, like its waves and foam.
            vec2 q = vWakeWorld - uWakeDrift;
            vec2 left = vec2(uWakeFlow.y, -uWakeFlow.x);
            vec2 uv0 = vec2(dot(q, uWakeFlow), dot(q, left)) / ${tile};
            vec2 ts = ripples(uv0,
              mat2(0.8, 0.6, -0.6, 0.8) * uv0 * 2.3 + vec2(-uTime * uFlow * 0.6, uTime * 0.01),
              mat2(0.34, -0.94, 0.94, 0.34) * uv0 * 0.37 + vec2(uTime * uFlow * 0.5, 0.0)) * normalScale;
            ripple -= wIn * (uWakeFlow * ts.x + left * ts.y);
            wb = texture2D(uWakeSurf, wuv) * wIn;
          }
          // Crossfading two unrelated ripple fields would flatten them: keep the strength.
          ripple /= sqrt((1.0 - wIn) * (1.0 - wIn) + wIn * wIn);
          // The churn behind a boat smooths the ripples: its scar is glassy.
          ripple *= 1.0 - 0.5 * clamp(wb.w * 1.5 + wb.z, 0.0, 1.0);
          waterSlope = ripple + wb.xy;
          normal = normalize((viewMatrix * vec4(-waterSlope.x, 1.0, -waterSlope.y, 0.0)).xyz);
          // Foam: white water thinning to froth, and the lace it leaves, from the surface's amounts.
          if (wb.z + wb.w > 0.003) {
            vec2 q = vWakeWorld - uWakeDrift;
            vec4 d1 = texture2D(uFoamTex, q / 13.0);
            vec4 d2 = texture2D(uFoamTex, mat2(0.8, 0.6, -0.6, 0.8) * q / 5.1 + 0.31);
            vec4 d3 = texture2D(uFoamTex, mat2(0.34, -0.94, 0.94, 0.34) * q / 2.2 + 0.67);
            float lace = max(d1.r, d2.g * 0.85);
            float froth = d2.b * 0.5 + d3.b * 0.5;
            float t = 1.05 - wb.z * 0.9;
            float cw = smoothstep(t - 0.12, t + 0.12, froth);
            // Old foam: the filaments, fewer and fainter as it thins, over a faint scum.
            float cl = smoothstep(0.85 - wb.w * 0.5, 1.0 - wb.w * 0.5, lace) * (0.3 + 0.35 * wb.w) * smoothstep(0.02, 0.25, wb.w) + wb.w * 0.05;
            float cover = max(cw, cl) * mix(0.6, 1.0, d1.a);
            // Far off, the detail is finer than a pixel: its average.
            float far = clamp(max(length(dFdx(q)), length(dFdy(q))) * 1.5 - 0.2, 0.0, 1.0);
            gWakeFoam = mix(cover, clamp(max(wb.z * 0.85, wb.w * 0.12), 0.0, 1.0), far);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.86, 0.86), gWakeFoam);
            roughnessFactor = mix(roughnessFactor, 0.7, gWakeFoam);
          }
          // Bubbles under the surface light the churned water pale jade.
          diffuseColor.rgb += vec3(0.03, 0.1, 0.085) * clamp(wb.z * 0.8 + wb.w * 0.3, 0.0, 1.0) * (1.0 - gWakeFoam);
        }
        #endif`,
        true,
      ],
      [
        "lights_fragment_maps",
        /* glsl */ `
        #if defined(USE_ENVMAP) && defined(RE_IndirectSpecular)
          float mirrorW = uMirrorWeight * (1.0 - gWakeFoam);
          if (mirrorW > 0.001) {
            vec2 muv = vMirrorCoord.xy / vMirrorCoord.w + waterSlope * 0.06;
            radiance = mix(radiance, texture2D(uMirror, muv).rgb, mirrorW);
          }
          // The river's own dark teal shows through what it reflects; foam reflects as itself.
          radiance *= mix(vec3(0.64, 0.82, 0.8), vec3(0.8), gWakeFoam);
        #endif`,
      ],
      [
        "lights_fragment_end",
        /* glsl */ `
        // A low sun's glitter path may burn; the moon's (and the lamps') must stay a glitter,
        // so at night the direct highlights are capped.
        {
          float cap = mix(5.0, 0.22, uNight);
          float l = dot(reflectedLight.directSpecular, vec3(0.2126, 0.7152, 0.0722));
          if (l > cap) reflectedLight.directSpecular *= cap / l;
        }`,
      ],
    ],
  };
}

export class Water {
  readonly mirror: Mirror;
  /** The displaced water around the camera (the wake's patch), with the river's material; null without a wake. */
  readonly patch: Mesh | null;
  private readonly uniforms: Record<string, IUniform> & { uMirrorMatrix: { value: Matrix4 }; uMirrorWeight: { value: number } };

  constructor(
    readonly material: MeshStandardMaterial,
    readonly pond: MeshStandardMaterial,
    normalMap: Texture,
    env: Texture,
    private readonly zones: MirrorZone[],
    wake: Wake | null,
  ) {
    this.mirror = new Mirror();
    this.uniforms = {
      uTime: SHARED.uTime,
      uNight: SHARED.uNight,
      uMirror: { value: this.mirror.target.texture as Texture | null },
      uMirrorMatrix: { value: new Matrix4() },
      uMirrorWeight: { value: 0 },
      uFlow: { value: FLOW },
      ...(wake?.uniforms ?? idleWake()),
    };
    const patchMat = wake ? new MeshStandardMaterial({ name: "river patch" }) : null;
    for (const m of [material, pond, patchMat]) {
      if (!m) continue;
      // Water has almost no diffuse colour of its own: what shows is mostly what it reflects.
      m.color = new Color("#10313a");
      m.roughness = 0.09;
      m.metalness = 0;
      m.envMap = env;
      m.envMapIntensity = 0.8;
      m.normalMap = normalMap;
      m.normalScale = new Vector2(0.13, 0.13);
    }
    normalMap.repeat.set(1 / TEXTURES.waterTile, 1 / TEXTURES.waterTile);
    patchMaterial(material, waterPatch("water", this.uniforms));
    this.patch = null;
    if (wake && patchMat) {
      patchMat.defines = { WAKE_PATCH: "" };
      patchMaterial(patchMat, waterPatch("water-patch", this.uniforms));
      wake.patch.material = patchMat;
      wake.patch.layers.set(LAYER.water);
      this.patch = wake.patch;
    }
  }

  /** The planar reflection's weight for this camera: 1 near a zone, 0 away from them. */
  mirrorWeight(camera: Vector3): number {
    if (!QUALITY.reflections) return 0;
    let w = 0;
    for (const z of this.zones) {
      const d = Math.hypot(camera.x - z.x, camera.z - z.z);
      w = Math.max(w, 1 - Math.min(1, Math.max(0, (d - z.inner) / (z.outer - z.inner))));
    }
    // Looking down from high up, the reflection is mostly sky anyway.
    return w * (1 - Math.min(1, Math.max(0, (camera.y - 120) / 80)));
  }

  /** Render the reflection (when it's in use) before the main pass. */
  update(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, width: number, height: number): void {
    const w = this.mirrorWeight(camera.position);
    this.uniforms.uMirrorWeight.value = w;
    if (w <= 0.001) return;
    this.mirror.render(renderer, scene, camera, width, height, this.uniforms.uMirrorMatrix.value);
  }

  get active(): boolean {
    return this.uniforms.uMirrorWeight.value > 0.001;
  }
}

/** A mirror camera for the water plane y = 0, after three's Reflector (oblique near plane). */
class Mirror {
  readonly target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 0 });
  private readonly camera = new PerspectiveCamera();
  private readonly plane = new Plane();
  private readonly clip = new Vector4();
  private readonly q = new Vector4();
  private readonly view = new Vector3();
  private readonly look = new Vector3();
  private readonly tgt = new Vector3();
  private readonly rot = new Matrix4();

  render(renderer: WebGLRenderer, scene: Scene, main: PerspectiveCamera, width: number, height: number, textureMatrix: Matrix4): void {
    const w = Math.max(1, Math.round(width * QUALITY.reflectionScale));
    const h = Math.max(1, Math.round(height * QUALITY.reflectionScale));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    const cam = this.camera;
    const pos = this.view.setFromMatrixPosition(main.matrixWorld);
    if (pos.y <= 0.05) return;
    this.rot.extractRotation(main.matrixWorld);
    this.look.set(0, 0, -1).applyMatrix4(this.rot).add(pos);
    // Reflect the eye, the look point and the up vector in y = 0.
    cam.position.set(pos.x, -pos.y, pos.z);
    this.tgt.set(this.look.x, -this.look.y, this.look.z);
    cam.up.set(0, 1, 0).applyMatrix4(this.rot);
    cam.up.y = -cam.up.y;
    cam.lookAt(this.tgt);
    cam.near = main.near;
    cam.far = main.far;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(main.projectionMatrix);
    cam.layers.mask = mirrorLayers(main.layers);

    textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    textureMatrix.multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);

    // Oblique near plane at the water, so nothing below it ends up in the reflection.
    this.plane.set(UP, 0).applyMatrix4(cam.matrixWorldInverse);
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const p = cam.projectionMatrix.elements;
    this.q.set((Math.sign(this.clip.x) + p[8]) / p[0], (Math.sign(this.clip.y) + p[9]) / p[5], -1, (1 + p[10]) / p[14]);
    this.clip.multiplyScalar(2 / this.clip.dot(this.q));
    p[2] = this.clip.x;
    p[6] = this.clip.y;
    p[10] = this.clip.z + 1 - 0.003;
    p[14] = this.clip.w;

    const prevTarget = renderer.getRenderTarget();
    const autoUpdate = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false; // the main pass renders the shadow map this frame
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = autoUpdate;
  }
}

const UP = new Vector3(0, 1, 0);

function mirrorLayers(main: Layers): number {
  return (main.mask & ~((1 << LAYER.water) | (1 << LAYER.trees) | (1 << LAYER.labels) | (1 << LAYER.terrain) | (1 << LAYER.details))) | (1 << MIRROR_ONLY);
}
