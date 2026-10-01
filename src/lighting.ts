// Sun, hemisphere light, three.js Sky and fog, all driven by one number (timeOfDay) through
// curves over the sun's elevation, so dawn mirrors dusk. Lights are created once and only
// their intensities change: adding or removing lights would recompile every material.

import {
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  type MeshStandardMaterial,
  type Scene,
  Vector3,
  type WebGLRenderer,
} from "three";
import { Sky } from "three/addons/objects/Sky.js";
import type { State } from "./state";
import { sunPosition } from "./sun";

type Keys = [number, number][];
type ColorKeys = [number, string][];

// All keyed on sun elevation in degrees, ascending.
const SUN_INTENSITY: Keys = [[-90, 0], [0, 0], [2, 0.7], [6, 1.5], [15, 2.3], [39, 3]];
const SUN_COLOR: ColorKeys = [[0, "#ff6a2a"], [2, "#ff8c42"], [6, "#ffb469"], [10, "#ffdcae"], [20, "#fff1de"]];
// Night stays legible as a blue, moonlit grey box; M3 replaces this with emissive windows and light groups.
const HEMI_SKY: ColorKeys = [[-18, "#34436f"], [-12, "#3a4a78"], [-6, "#56608c"], [0, "#c99079"], [4, "#e6b78d"], [10, "#bcd2ea"], [40, "#a9c8ec"]];
const HEMI_GROUND: ColorKeys = [[-12, "#1a1d28"], [0, "#5a4636"], [10, "#8b7a63"], [40, "#8f8068"]];
const HEMI_INTENSITY: Keys = [[-18, 2.2], [-12, 2.0], [-6, 1.4], [0, 1.0], [6, 1.05], [10, 1.0], [40, 1.1]];
/** How much of the horizon colour the water picks up, standing in for sky reflection until M3. */
const WATER_SKY: Keys = [[-18, 0.25], [-6, 0.2], [0, 0.15], [10, 0.08], [40, 0.05]];
const FOG_COLOR: ColorKeys = [[-18, "#0b1020"], [-12, "#161d33"], [-6, "#4b4d6b"], [0, "#d6a283"], [4, "#e6bf98"], [10, "#c8d4df"], [40, "#c0d0df"]];
const FOG_DENSITY: Keys = [[-18, 0.00034], [-6, 0.00032], [0, 0.00028], [6, 0.00022], [15, 0.00017], [40, 0.00016]];
const EXPOSURE: Keys = [[-12, 0.5], [0, 0.7], [6, 0.7], [10, 1], [40, 1]];
const TURBIDITY: Keys = [[0, 9], [10, 5], [40, 3]];
const RAYLEIGH: Keys = [[-6, 3], [0, 2.6], [10, 1.4], [40, 1]];

function curve(keys: Keys, e: number): number {
  if (e <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [e0, v0] = keys[i];
    const [e1, v1] = keys[i + 1];
    if (e <= e1) return v0 + ((v1 - v0) * (e - e0)) / (e1 - e0);
  }
  return keys[keys.length - 1][1];
}

const tmpA = new Color();
const tmpB = new Color();
function colorCurve(keys: ColorKeys, e: number, out: Color): Color {
  if (e <= keys[0][0]) return out.set(keys[0][1]);
  for (let i = 0; i < keys.length - 1; i++) {
    const [e0, c0] = keys[i];
    const [e1, c1] = keys[i + 1];
    if (e <= e1) return out.copy(tmpA.set(c0)).lerp(tmpB.set(c1), (e - e0) / (e1 - e0));
  }
  return out.set(keys[keys.length - 1][1]);
}

const SHADOW_HALF = 300; // 600 m box around the camera focus

export class Lighting {
  readonly sun = new DirectionalLight("#ffffff", 3);
  readonly hemi = new HemisphereLight("#bcd2ea", "#8b7a63", 1);
  readonly sky = new Sky();
  readonly fog = new FogExp2("#c8d4df", 0.0002);
  private readonly dir = new Vector3();

  constructor(scene: Scene, private readonly water?: MeshStandardMaterial) {
    this.sun.castShadow = true;
    const sh = this.sun.shadow;
    sh.mapSize.set(2048, 2048);
    sh.camera.left = -SHADOW_HALF;
    sh.camera.right = SHADOW_HALF;
    sh.camera.top = SHADOW_HALF;
    sh.camera.bottom = -SHADOW_HALF;
    sh.camera.near = 10;
    sh.camera.far = 4000;
    sh.bias = -0.0004;
    sh.normalBias = 0.8;
    scene.add(this.sun, this.sun.target, this.hemi);

    this.sky.scale.setScalar(15000);
    const u = this.sky.material.uniforms;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.82;
    u.cloudCoverage.value = 0.32;
    u.cloudDensity.value = 0.35;
    scene.add(this.sky);
    scene.fog = this.fog;
  }

  update(st: State, renderer: WebGLRenderer, focus: Vector3, cameraPos: Vector3, dt: number): void {
    const sp = sunPosition(st.timeOfDay);
    st.sun.elevation = sp.elevation;
    st.sun.azimuth = sp.azimuth;
    const e = sp.elevation;
    const az = (sp.azimuth * Math.PI) / 180;
    const el = (e * Math.PI) / 180;
    // Scene frame: +X east, +Y up, +Z south.
    this.dir.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));

    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(this.dir);
    u.turbidity.value = curve(TURBIDITY, e);
    u.rayleigh.value = curve(RAYLEIGH, e);
    u.time.value += dt;
    this.sky.position.copy(cameraPos);

    this.sun.intensity = curve(SUN_INTENSITY, e);
    colorCurve(SUN_COLOR, e, this.sun.color);
    this.placeShadow(focus);

    this.hemi.intensity = curve(HEMI_INTENSITY, e);
    colorCurve(HEMI_SKY, e, this.hemi.color);
    colorCurve(HEMI_GROUND, e, this.hemi.groundColor);

    colorCurve(FOG_COLOR, e, this.fog.color);
    this.fog.density = curve(FOG_DENSITY, e);
    if (this.water) this.water.emissive.copy(this.fog.color).multiplyScalar(curve(WATER_SKY, e));
    renderer.toneMappingExposure = curve(EXPOSURE, e);
  }

  /** Centre the shadow box on the focus, snapped to shadow-map texels so edges don't shimmer. */
  private placeShadow(focus: Vector3): void {
    const d = this.dir.y < 0.05 ? tmpDir.copy(this.dir).setY(0.05).normalize() : this.dir;
    const right = tmpRight.crossVectors(UP, d).normalize();
    const up = tmpUp.crossVectors(d, right);
    const texel = (SHADOW_HALF * 2) / this.sun.shadow.mapSize.x;
    const px = focus.dot(right);
    const py = focus.dot(up);
    const target = tmpTarget
      .copy(focus)
      .addScaledVector(right, Math.round(px / texel) * texel - px)
      .addScaledVector(up, Math.round(py / texel) * texel - py);
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(d, 1500);
  }
}

const UP = new Vector3(0, 1, 0);
const tmpDir = new Vector3();
const tmpRight = new Vector3();
const tmpUp = new Vector3();
const tmpTarget = new Vector3();
