// The skydome: three.js's Preetham sky (the Sky shader, minus its clouds) mixed with the four
// painted panoramas, which carry the clouds and the colour. Dawn or golden hour blend into day
// by sun elevation; below -6° the night panorama takes over by -12°, and the moon and stars
// come out. A CPU twin of the same blend gives the hemisphere and fog colours ("sampled from
// the current skydome"), and a small cube render of the dome is the water's environment map.
// The Preetham code is from three.js (examples/jsm/objects/Sky.js, MIT licence).

import {
  BackSide,
  BoxGeometry,
  Color,
  CubeCamera,
  HalfFloatType,
  LinearMipmapLinearFilter,
  Mesh,
  Scene,
  ShaderMaterial,
  type Texture,
  Vector3,
  Vector4,
  WebGLCubeRenderTarget,
  type WebGLRenderer,
} from "three";
import type { SkyProbe, TextureSet } from "./textures";

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Blend parameters for a sun elevation (degrees) and time of day. */
export interface SkyBlend {
  /** Painted weights: dawn, day, golden, night. */
  weights: Vector4;
  /** Painted sky over the Preetham sky (0..1) before the night crossfade. */
  painted: number;
  /** Brightness of the painted day skies (they dim through blue hour)... */
  gain: number;
  /** ...and turn blue: blue hour is the one sky without a panorama of its own. */
  tint: Color;
  /** Crossfade to the night panorama, -6° → -12°. */
  night: number;
  stars: number;
  moon: number;
}

const BLUE_HOUR = new Color(0.5, 0.64, 1.1);

export function skyBlend(elevation: number, morning: boolean, out: SkyBlend): SkyBlend {
  const e = elevation;
  const low = 1 - smooth(4, 14, e); // golden (or dawn) instead of day
  out.night = smooth(-6, -12, e);
  out.weights.set(morning ? low : 0, 1 - low, morning ? 0 : low, out.night);
  // The Preetham sky goes black a degree or two below the horizon: the painted sky carries
  // blue hour, dimming as it goes.
  out.painted = 0.55 + 0.45 * smooth(6, -1.5, e);
  out.gain = 0.3 + 0.7 * smooth(-7, -0.5, e);
  out.tint.setRGB(1, 1, 1).lerp(BLUE_HOUR, smooth(0.5, -6, e));
  out.stars = smooth(-8, -16, e);
  out.moon = smooth(-1, -8, e);
  return out;
}

const VERTEX = /* glsl */ `
uniform vec3 sunPosition;
uniform float rayleigh;
uniform float turbidity;
uniform float mieCoefficient;
varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;
const float e = 2.71828182845904523536028747135266249775724709369995957;
const float pi = 3.141592653589793238462643383279502884197169;
const vec3 totalRayleigh = vec3( 5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5 );
const vec3 MieConst = vec3( 1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14 );
const float cutoffAngle = 1.6110731556870734;
const float steepness = 1.5;
const float EE = 1000.0;
float sunIntensity( float zenithAngleCos ) {
  zenithAngleCos = clamp( zenithAngleCos, -1.0, 1.0 );
  return EE * max( 0.0, 1.0 - pow( e, -( ( cutoffAngle - acos( zenithAngleCos ) ) / steepness ) ) );
}
void main() {
  vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
  vWorldPosition = worldPosition.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  gl_Position.z = gl_Position.w;
  vSunDirection = normalize( sunPosition );
  vSunE = sunIntensity( vSunDirection.y );
  vBetaR = totalRayleigh * rayleigh;
  vBetaM = 0.434 * ( 0.2 * turbidity ) * 10E-18 * MieConst * mieCoefficient;
}`;

/** Luminance where the Preetham sky's soft knee starts (shader and CPU twin). */
const KNEE = 6;

const FRAGMENT = /* glsl */ `
#define KNEE ${KNEE.toFixed(1)}
varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;
uniform float mieDirectionalG;
uniform float showSunDisc;
uniform sampler2D skyDawn;
uniform sampler2D skyDay;
uniform sampler2D skyGolden;
uniform sampler2D skyNight;
uniform vec4 weights;
uniform float painted;
uniform float gain;
uniform vec3 tint;
uniform float nightMix;
uniform float stars;
uniform float moon;
uniform vec3 moonDirection;
uniform float time;
const float pi = 3.141592653589793238462643383279502884197169;
const float sunAngularDiameterCos = 0.999956676946448443553574619906976478926848692873900859324;

float hash13( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}

void main() {
  vec3 direction = normalize( vWorldPosition - cameraPosition );

  // Preetham: in-scattering and extinction along the view ray.
  float zenithAngle = acos( max( 0.0, direction.y ) );
  float inverse = 1.0 / ( cos( zenithAngle ) + 0.15 * pow( 93.885 - ( ( zenithAngle * 180.0 ) / pi ), -1.253 ) );
  vec3 Fex = exp( -( vBetaR * 8.4E3 * inverse + vBetaM * 1.25E3 * inverse ) );
  float cosTheta = dot( direction, vSunDirection );
  float rPhase = 0.05968310365946075 * ( 1.0 + pow( cosTheta * 0.5 + 0.5, 2.0 ) );
  float g2 = mieDirectionalG * mieDirectionalG;
  float mPhase = 0.07957747154594767 * ( 1.0 - g2 ) / pow( 1.0 - 2.0 * mieDirectionalG * cosTheta + g2, 1.5 );
  vec3 beta = ( vBetaR * rPhase + vBetaM * mPhase ) / ( vBetaR + vBetaM );
  vec3 Lin = pow( vSunE * beta * ( 1.0 - Fex ), vec3( 1.5 ) );
  Lin *= mix( vec3( 1.0 ), pow( vSunE * beta * Fex, vec3( 0.5 ) ), clamp( pow( 1.0 - vSunDirection.y, 5.0 ), 0.0, 1.0 ) );
  vec3 physical = ( Lin + 0.1 * Fex ) * 0.04 + vec3( 0.0, 0.0003, 0.00075 );
  // A soft knee: the glow round a low sun stays bright enough to bloom without burning out.
  physical /= 1.0 + dot( physical, vec3( 0.2126, 0.7152, 0.0722 ) ) / KNEE;

  // The painted skies: equirectangular, u the compass azimuth, v = 0 at the zenith.
  vec2 uv = vec2( fract( atan( direction.x, -direction.z ) / ( 2.0 * pi ) ), 0.5 - asin( clamp( direction.y, -1.0, 1.0 ) ) / pi );
  vec3 paint = texture2D( skyDawn, uv ).rgb * weights.x + texture2D( skyDay, uv ).rgb * weights.y + texture2D( skyGolden, uv ).rgb * weights.z;
  vec3 col = mix( physical, paint * gain * tint, painted );
  vec3 night = texture2D( skyNight, uv ).rgb;
  col = mix( col, night, nightMix );

  // The sun disc over everything, the moon and stars at night.
  float sundisc = clamp( ( cosTheta - sunAngularDiameterCos ) * 50000.0, 0.0, 1.0 ) * showSunDisc;
  col += 760.0 * 0.04 * sundisc * min( vSunE * Fex, vec3( 80.0 ) ) * ( 1.0 - nightMix );
  if ( stars > 0.0 && direction.y > 0.02 ) {
    vec3 p = direction * 420.0;
    vec3 cell = floor( p );
    float h = hash13( cell );
    if ( h > 0.9965 ) {
      float d = length( fract( p ) - 0.5 );
      float tw = 0.75 + 0.25 * sin( time * ( 1.5 + h * 40.0 ) + h * 800.0 );
      // Clouds (brighter than clear night sky) hide them.
      float clear = 1.0 - smoothstep( 0.012, 0.03, dot( night, vec3( 0.3, 0.5, 0.2 ) ) );
      col += vec3( 0.9, 0.93, 1.0 ) * smoothstep( 0.3, 0.0, d ) * ( h - 0.9965 ) * 900.0 * tw * stars * clear * smoothstep( 0.02, 0.15, direction.y );
    }
  }
  if ( moon > 0.0 ) {
    float c = dot( direction, moonDirection );
    float disc = smoothstep( 0.99988, 0.99993, c );
    float halo = exp( -acos( clamp( c, -1.0, 1.0 ) ) / 0.06 ) * 0.25 + exp( -acos( clamp( c, -1.0, 1.0 ) ) / 0.3 ) * 0.06;
    col += vec3( 1.0, 0.97, 0.9 ) * ( disc * 1.6 + halo * 0.08 ) * moon;
  }
  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const ENV_SIZE = 128;

export class SkyDome {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  /** The dome rendered into a cube, for the water's reflections (re-rendered as the sky changes). */
  readonly env = new WebGLCubeRenderTarget(ENV_SIZE, { type: HalfFloatType, generateMipmaps: true, minFilter: LinearMipmapLinearFilter });
  private readonly envScene = new Scene();
  private readonly envCamera = new CubeCamera(1, 100000, this.env);
  private envKey = "";
  private readonly blend: SkyBlend = { weights: new Vector4(), painted: 0, gain: 1, tint: new Color(1, 1, 1), night: 0, stars: 0, moon: 0 };
  private readonly sunDir = new Vector3();
  private turbidity = 3;
  private rayleigh = 1;

  constructor(private readonly tex: TextureSet) {
    this.material = new ShaderMaterial({
      name: "SkyDome",
      uniforms: {
        turbidity: { value: 3 },
        rayleigh: { value: 1 },
        mieCoefficient: { value: MIE },
        mieDirectionalG: { value: MIE_G },
        sunPosition: { value: new Vector3(0, 1, 0) },
        showSunDisc: { value: 1 },
        skyDawn: { value: tex.skies.dawn },
        skyDay: { value: tex.skies.day },
        skyGolden: { value: tex.skies.golden },
        skyNight: { value: tex.skies.night },
        weights: { value: new Vector4(0, 1, 0, 0) },
        painted: { value: 0.6 },
        gain: { value: 1 },
        tint: { value: new Color(1, 1, 1) },
        nightMix: { value: 0 },
        stars: { value: 0 },
        moon: { value: 0 },
        moonDirection: { value: new Vector3(0, 1, 0) },
        time: { value: 0 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: BackSide,
      depthWrite: false,
    });
    const geo = new BoxGeometry(1, 1, 1);
    this.mesh = new Mesh(geo, this.material);
    this.mesh.scale.setScalar(15000);
    this.mesh.frustumCulled = false;
    this.mesh.name = "sky";
    const envDome = new Mesh(geo, this.material);
    envDome.scale.setScalar(1000);
    this.envScene.add(envDome);
  }

  get envTexture(): Texture {
    return this.env.texture;
  }

  update(sunDir: Vector3, elevation: number, morning: boolean, turbidity: number, rayleigh: number, moonDir: Vector3, time: number): void {
    const b = skyBlend(elevation, morning, this.blend);
    const u = this.material.uniforms;
    u.sunPosition.value.copy(sunDir);
    u.turbidity.value = this.turbidity = turbidity;
    u.rayleigh.value = this.rayleigh = rayleigh;
    u.weights.value.copy(b.weights);
    u.painted.value = b.painted;
    u.gain.value = b.gain;
    u.tint.value.copy(b.tint);
    u.nightMix.value = b.night;
    u.stars.value = b.stars;
    u.moon.value = b.moon;
    u.moonDirection.value.copy(moonDir);
    u.time.value = time;
    this.sunDir.copy(sunDir);
  }

  /** Re-render the environment cube when the sky has visibly changed (sun moved ≥ 0.1°). */
  renderEnv(renderer: WebGLRenderer, elevation: number, force = false): boolean {
    const key = (Math.round(elevation * 10) / 10).toFixed(1);
    if (!force && key === this.envKey) return false;
    this.envKey = key;
    const u = this.material.uniforms;
    // No sun disc or stars in the reflection map: the sun's glint is the water's own specular.
    const disc = u.showSunDisc.value;
    const stars = u.stars.value;
    u.showSunDisc.value = 0;
    u.stars.value = 0;
    const autoUpdate = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    this.envCamera.update(renderer, this.envScene);
    renderer.shadowMap.autoUpdate = autoUpdate;
    u.showSunDisc.value = disc;
    u.stars.value = stars;
    this.env.texture.needsPMREMUpdate = true;
    return true;
  }

  /** The dome's colour in direction (x, y, z), linear, without the sun disc, moon and stars. */
  sample(x: number, y: number, z: number, out: Color): Color {
    const b = this.blend;
    preetham(x, y, z, this.sunDir, this.turbidity, this.rayleigh, out);
    const w = b.weights;
    let r = 0;
    let g = 0;
    let bl = 0;
    const add = (p: SkyProbe, k: number) => {
      if (k <= 0) return;
      sampleProbe(p, x, y, z, tmp);
      r += tmp[0] * k;
      g += tmp[1] * k;
      bl += tmp[2] * k;
    };
    add(this.tex.skyProbes.dawn, w.x);
    add(this.tex.skyProbes.day, w.y);
    add(this.tex.skyProbes.golden, w.z);
    const t = b.tint;
    out.setRGB(out.r + (r * b.gain * t.r - out.r) * b.painted, out.g + (g * b.gain * t.g - out.g) * b.painted, out.b + (bl * b.gain * t.b - out.b) * b.painted);
    if (b.night > 0) {
      sampleProbe(this.tex.skyProbes.night, x, y, z, tmp);
      out.setRGB(out.r + (tmp[0] - out.r) * b.night, out.g + (tmp[1] - out.g) * b.night, out.b + (tmp[2] - out.b) * b.night);
    }
    return out;
  }
}

const MIE = 0.004;
const MIE_G = 0.8;
const tmp = [0, 0, 0];

/** Bilinear lookup of a downsampled panorama by direction (same mapping as the shader). */
function sampleProbe(p: SkyProbe, x: number, y: number, z: number, out: number[]): void {
  const u = (((Math.atan2(x, -z) / (2 * Math.PI)) % 1) + 1) % 1;
  const v = 0.5 - Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI;
  const fx = u * p.w - 0.5;
  const fy = Math.min(p.h - 1.001, Math.max(0, v * p.h - 0.5));
  const i0 = Math.floor(fx);
  const j0 = Math.floor(fy);
  const tx = fx - i0;
  const ty = fy - j0;
  const i = (((i0 % p.w) + p.w) % p.w);
  const i1 = (i + 1) % p.w;
  for (let k = 0; k < 3; k++) {
    const a = p.data[(j0 * p.w + i) * 3 + k];
    const b = p.data[(j0 * p.w + i1) * 3 + k];
    const c = p.data[((j0 + 1) * p.w + i) * 3 + k];
    const d = p.data[((j0 + 1) * p.w + i1) * 3 + k];
    out[k] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }
}

const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];

/** The Preetham sky of the shader above, on the CPU. */
function preetham(x: number, y: number, z: number, sun: Vector3, turbidity: number, rayleigh: number, out: Color): Color {
  const zc = Math.max(-1, Math.min(1, sun.y));
  const sunE = 1000 * Math.max(0, 1 - Math.exp(-((1.6110731556870734 - Math.acos(zc)) / 1.5)));
  const zenith = Math.acos(Math.max(0, y));
  const inv = 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - (zenith * 180) / Math.PI, -1.253));
  const cosT = x * sun.x + y * sun.y + z * sun.z;
  const rPhase = 0.05968310365946075 * (1 + (cosT * 0.5 + 0.5) ** 2);
  const g2 = MIE_G * MIE_G;
  const mPhase = (0.07957747154594767 * (1 - g2)) / Math.pow(1 - 2 * MIE_G * cosT + g2, 1.5);
  const fade = Math.min(1, Math.max(0, (1 - sun.y) ** 5));
  const c = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const bR = TOTAL_RAYLEIGH[k] * rayleigh;
    const bM = 0.434 * 0.2 * turbidity * 10e-18 * MIE_CONST[k] * MIE;
    const fex = Math.exp(-(bR * 8.4e3 * inv + bM * 1.25e3 * inv));
    const beta = (bR * rPhase + bM * mPhase) / (bR + bM);
    let lin = Math.pow(sunE * beta * (1 - fex), 1.5);
    lin *= 1 + (Math.sqrt(sunE * beta * fex) - 1) * fade;
    c[k] = (lin + 0.1 * fex) * 0.04 + [0, 0.0003, 0.00075][k];
  }
  const knee = 1 / (1 + (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / KNEE);
  return out.setRGB(c[0] * knee, c[1] * knee, c[2] * knee);
}
