// Sun, moon, hemisphere light, sky, fog, exposure and bloom, all driven by one number
// (timeOfDay) through curves over the sun's elevation, so dawn mirrors dusk. The hemisphere's
// colours and the fog's are sampled from the sky dome as it is this frame. Lights are created
// once and only their intensities change: adding or removing lights would recompile every
// material.

import {
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  type Scene,
  Vector3,
  type WebGLRenderer,
} from "three";
import { QUALITY } from "./config";
import type { SkyDome } from "./sky";
import type { State } from "./state";
import { sunPosition } from "./sun";
import { nightRamp, SHARED } from "./world/night";

type Keys = [number, number][];
type ColorKeys = [number, string][];

// All keyed on sun elevation in degrees, ascending.
const SUN_INTENSITY: Keys = [[-90, 0], [0, 0], [2, 0.7], [6, 1.5], [15, 2.3], [39, 3]];
const SUN_COLOR: ColorKeys = [[0, "#ff6a2a"], [2, "#ff8c42"], [6, "#ffb469"], [10, "#ffdcae"], [20, "#fff1de"]];
/**
 * The hemisphere's colours come from the sky at unit luminance; this is its strength. Night
 * is a dim moonlit blue now that lit windows and the light groups carry the city.
 */
const HEMI_INTENSITY: Keys = [[-18, 0.06], [-12, 0.07], [-6, 0.15], [0, 0.32], [6, 0.5], [10, 0.6], [40, 0.66]];
/** The ground half is the haze below the horizon, this much darker than the sky half. */
const HEMI_GROUND: Keys = [[-12, 0.2], [0, 0.25], [10, 0.33]];
const FOG_DENSITY: Keys = [[-18, 0.00034], [-6, 0.00032], [0, 0.00028], [6, 0.00022], [15, 0.00017], [40, 0.00016]];
const EXPOSURE: Keys = [[-12, 0.5], [0, 0.7], [6, 0.7], [10, 1], [40, 1]];
const TURBIDITY: Keys = [[0, 9], [10, 5], [40, 3]];
const RAYLEIGH: Keys = [[-6, 3], [0, 2.6], [10, 1.4], [40, 1]];
/**
 * Bloom: the design's threshold 0.9 and strength 0.6 at night. By day the threshold rises with
 * the light, or every sunlit wall would bloom (the threshold applies before the exposure).
 */
const BLOOM_STRENGTH: Keys = [[-12, 0.6], [-3, 0.55], [2, 0.42], [10, 0.3], [40, 0.25]];
const BLOOM_THRESHOLD: Keys = [[-12, 0.9], [-6, 1.0], [0, 1.5], [6, 2.2], [15, 3.0], [40, 3.4]];
/** The moon: cool blue, at most 0.15, rising in the east as the sun sets. */
const MOON = { color: "#9fb4ff", intensity: 0.15, azimuth: 124 };

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

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A direction from compass azimuth and elevation (degrees): +X east, +Y up, +Z south. */
function direction(azimuth: number, elevation: number, out: Vector3): Vector3 {
  const az = (azimuth * Math.PI) / 180;
  const el = (elevation * Math.PI) / 180;
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
}

const SHADOW_HALF = 300; // 600 m box around the camera focus
/** Far enough up-sun to catch the long shadows of a low sun (a 30 m roof at 2° reaches 860 m). */
const SUN_DISTANCE = 1100;

export class Lighting {
  readonly sun = new DirectionalLight("#ffffff", 3);
  readonly moon = new DirectionalLight(MOON.color, 0);
  readonly hemi = new HemisphereLight("#bcd2ea", "#8b7a63", 1);
  readonly fog = new FogExp2("#c8d4df", 0.0002);
  /** Exposure and bloom for the post chain, set each frame. */
  readonly post = { exposure: 1, bloomStrength: 0.3, bloomThreshold: 2, bloomRadius: 0.45 };
  private readonly dir = new Vector3();
  private readonly moonDir = new Vector3();
  private readonly sample = new Color();
  private shadows = true;

  constructor(
    scene: Scene,
    private readonly sky: SkyDome,
  ) {
    this.sun.castShadow = true;
    const sh = this.sun.shadow;
    sh.mapSize.set(QUALITY.shadowMapSize, QUALITY.shadowMapSize);
    sh.camera.left = -SHADOW_HALF;
    sh.camera.right = SHADOW_HALF;
    sh.camera.top = SHADOW_HALF;
    sh.camera.bottom = -SHADOW_HALF;
    // The light sits SUN_DISTANCE from the focus; the frustum ends 400 m past it.
    sh.camera.near = 10;
    sh.camera.far = SUN_DISTANCE + 400;
    sh.bias = -0.0004;
    sh.normalBias = 0.8;
    // The moon never casts shadows; it stays in the scene by day at intensity 0.
    scene.add(this.sun, this.sun.target, this.moon, this.moon.target, this.hemi, sky.mesh);
    scene.fog = this.fog;
  }

  /**
   * The sun's shadow map size; 0 turns shadows off by intensity (a tiny map, rendered once
   * and never again), so no program changes.
   */
  setShadows(size: number): void {
    const sh = this.sun.shadow;
    this.shadows = size > 0;
    sh.intensity = this.shadows ? 1 : 0;
    const n = Math.max(16, size);
    if (sh.mapSize.x === n) return;
    sh.mapSize.set(n, n);
    sh.map?.dispose();
    sh.map = null;
  }

  update(st: State, renderer: WebGLRenderer, focus: Vector3, cameraPos: Vector3, dt: number): void {
    const sp = sunPosition(st.timeOfDay);
    st.sun.elevation = sp.elevation;
    st.sun.azimuth = sp.azimuth;
    const e = sp.elevation;
    direction(sp.azimuth, e, this.dir);
    const morning = sp.azimuth < 180;

    // The moon rises in the east-south-east as the sun goes down (and sets again toward dawn).
    const moonEl = Math.min(36, 6 - e * 0.9);
    direction(MOON.azimuth, moonEl, this.moonDir);
    this.moon.intensity = MOON.intensity * smooth(-1, -8, e) * smooth(-2, 6, moonEl);
    this.moon.position.copy(focus).addScaledVector(this.moonDir, 1000);
    this.moon.target.position.copy(focus);

    SHARED.uSunElevation.value = e;
    SHARED.uNight.value = smooth(0, 1, nightRamp(e));
    SHARED.uTime.value += dt;

    this.sky.update(this.dir, e, morning, curve(TURBIDITY, e), curve(RAYLEIGH, e), this.moonDir, SHARED.uTime.value);
    this.sky.mesh.position.copy(cameraPos);
    this.sky.renderEnv(renderer, e);

    this.sun.intensity = curve(SUN_INTENSITY, e);
    // With the sun down (or shadows off on the low tier) the shadow map is unused: stop
    // re-rendering it (toggling castShadow instead would recompile every material). It must
    // still be rendered once, or the shadowed materials sample a depth texture that doesn't
    // exist and every draw fails (a first frame at night, e.g. a jump straight to a night beat).
    renderer.shadowMap.autoUpdate = this.sun.intensity > 0 && this.shadows;
    if (this.sun.shadow.map === null) renderer.shadowMap.needsUpdate = true;
    colorCurve(SUN_COLOR, e, this.sun.color);
    this.placeShadow(focus);

    this.sampleSky();
    this.hemi.intensity = curve(HEMI_INTENSITY, e);
    this.fog.density = curve(FOG_DENSITY, e);

    const p = this.post;
    p.exposure = curve(EXPOSURE, e);
    p.bloomStrength = curve(BLOOM_STRENGTH, e);
    p.bloomThreshold = curve(BLOOM_THRESHOLD, e);
    renderer.toneMappingExposure = p.exposure;
  }

  /**
   * The hemisphere's sky colour is the dome's average over the upper sky, its ground colour
   * the haze under the horizon (both as hues: the curves set the strength); the fog is the
   * horizon itself, so distant land fades into the sky behind it.
   */
  private sampleSky(): void {
    const s = this.sample;
    const up = tmpUp.setRGB(0, 0, 0);
    const horizon = tmpHorizon.setRGB(0, 0, 0);
    const below = tmpBelow.setRGB(0, 0, 0);
    for (let k = 0; k < 8; k++) {
      const az = k * 45;
      for (const el of [18, 45, 75]) up.add(this.sky.sample(...dirArgs(az, el), s));
      // Each horizon sample is capped, so the glow round a low sun doesn't wash out all the haze.
      horizon.add(capLuminance(this.sky.sample(...dirArgs(az, 1.5), s), FOG_CAP));
      below.add(this.sky.sample(...dirArgs(az, -8), s));
    }
    up.multiplyScalar(1 / 24);
    horizon.multiplyScalar(1 / 8);
    below.multiplyScalar(1 / 8);
    hue(up, this.hemi.color, 0.75);
    hue(below, this.hemi.groundColor, 0.6).multiplyScalar(curve(HEMI_GROUND, SHARED.uSunElevation.value));
    this.fog.color.copy(horizon);
  }

  /** Centre the shadow box on the focus, snapped to shadow-map texels so edges don't shimmer. */
  private placeShadow(focus: Vector3): void {
    const d = this.dir.y < 0.05 ? tmpDir.copy(this.dir).setY(0.05).normalize() : this.dir;
    const right = tmpRight.crossVectors(UP, d).normalize();
    const up = tmpUp3.crossVectors(d, right);
    const texel = (SHADOW_HALF * 2) / this.sun.shadow.mapSize.x;
    const px = focus.dot(right);
    const py = focus.dot(up);
    const target = tmpTarget
      .copy(focus)
      .addScaledVector(right, Math.round(px / texel) * texel - px)
      .addScaledVector(up, Math.round(py / texel) * texel - py);
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(d, SUN_DISTANCE);
  }
}

const tmpV = new Vector3();
function dirArgs(azimuth: number, elevation: number): [number, number, number] {
  direction(azimuth, elevation, tmpV);
  return [tmpV.x, tmpV.y, tmpV.z];
}

const FOG_CAP = 0.6;

function capLuminance(c: Color, cap: number): Color {
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return lum > cap ? c.multiplyScalar(cap / lum) : c;
}

/** A colour's hue at unit luminance, partly desaturated (`saturation` 1 keeps it). */
function hue(c: Color, out: Color, saturation: number): Color {
  const lum = Math.max(1e-5, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
  out.setRGB(c.r / lum, c.g / lum, c.b / lum);
  return out.lerp(tmpGrey.setRGB(1, 1, 1), 1 - saturation);
}

const UP = new Vector3(0, 1, 0);
const tmpDir = new Vector3();
const tmpRight = new Vector3();
const tmpUp3 = new Vector3();
const tmpTarget = new Vector3();
const tmpUp = new Color();
const tmpHorizon = new Color();
const tmpBelow = new Color();
const tmpGrey = new Color();
