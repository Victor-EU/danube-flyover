// The river surface: MeshStandardMaterial with two layers of the normal map scrolling with
// the flow (the river mesh's u runs downstream in metres), the sky's cube map for reflections,
// the sun's own glint, and near the two money shots (Parliament and the Chain Bridge) a
// planar reflection of the lit scene, mixed in by distance so it never pops. Night light
// streaks are separate sprites (nightLights.ts).

import {
  Color,
  HalfFloatType,
  type Layers,
  Matrix4,
  type MeshStandardMaterial,
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
import { QUALITY, TEXTURES } from "../config";
import { SHARED } from "./night";
import { patchMaterial } from "./shaderPatch";

/**
 * Layers kept out of the reflection: the water itself, its streaks, the trees, the labels, and
 * the full terrain, which a coarse one (on MIRROR_ONLY) stands in for there.
 */
export const LAYER = { water: 1, trees: 2, labels: 3, terrain: 4 };
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

export class Water {
  readonly mirror: Mirror;
  private readonly uniforms = {
    uTime: SHARED.uTime,
    uNight: SHARED.uNight,
    uMirror: { value: null as Texture | null },
    uMirrorMatrix: { value: new Matrix4() },
    uMirrorWeight: { value: 0 },
    uFlow: { value: FLOW },
  };

  constructor(
    readonly material: MeshStandardMaterial,
    readonly pond: MeshStandardMaterial,
    normalMap: Texture,
    env: Texture,
    private readonly zones: MirrorZone[],
  ) {
    this.mirror = new Mirror();
    this.uniforms.uMirror.value = this.mirror.target.texture;
    for (const m of [material, pond]) {
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
    patchMaterial(material, {
      key: "water",
      uniforms: this.uniforms,
      vertexPars: "uniform mat4 uMirrorMatrix;\nvarying vec4 vMirrorCoord;",
      vertex: [["begin_vertex", "vMirrorCoord = uMirrorMatrix * (modelMatrix * vec4(transformed, 1.0));"]],
      fragmentPars: "uniform float uTime;\nuniform float uNight;\nuniform float uFlow;\nuniform sampler2D uMirror;\nuniform float uMirrorWeight;\nvarying vec4 vMirrorCoord;",
      fragment: [
        [
          "normal_fragment_maps",
          /* glsl */ `
          vec2 waterSlope = vec2(0.0);
          #ifdef USE_NORMALMAP_TANGENTSPACE
            // Three layers at different scales and angles, so no one ripple direction lines up.
            vec2 uvA = vNormalMapUv - vec2(uTime * uFlow, 0.0);
            vec2 uvB = mat2(0.8, 0.6, -0.6, 0.8) * vNormalMapUv * 2.3 + vec2(-uTime * uFlow * 1.6, uTime * 0.01);
            vec2 uvC = mat2(0.34, -0.94, 0.94, 0.34) * vNormalMapUv * 0.37 + vec2(-uTime * uFlow * 0.5, 0.0);
            vec3 n1 = texture2D(normalMap, uvA).xyz * 2.0 - 1.0;
            vec3 n2 = texture2D(normalMap, uvB).xyz * 2.0 - 1.0;
            vec3 n3 = texture2D(normalMap, uvC).xyz * 2.0 - 1.0;
            waterSlope = n1.xy * 0.6 + n2.xy * 0.5 + n3.xy * 0.8;
            normal = normalize(tbn * normalize(vec3(waterSlope * normalScale, 1.0)));
          #endif`,
          true,
        ],
        [
          "lights_fragment_maps",
          /* glsl */ `
          #if defined(USE_ENVMAP) && defined(RE_IndirectSpecular)
            if (uMirrorWeight > 0.001) {
              vec2 muv = vMirrorCoord.xy / vMirrorCoord.w + waterSlope * 0.008;
              radiance = mix(radiance, texture2D(uMirror, muv).rgb, uMirrorWeight);
            }
            // The river's own dark teal shows through what it reflects.
            radiance *= vec3(0.64, 0.82, 0.8);
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
    });
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
  return (main.mask & ~((1 << LAYER.water) | (1 << LAYER.trees) | (1 << LAYER.labels) | (1 << LAYER.terrain))) | (1 << MIRROR_ONLY);
}
