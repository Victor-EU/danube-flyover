// A 2D FFT on the GPU: Stockham radix-R passes (one output per fragment, so log_R(N) passes
// an axis), rows then columns, in RGBA32F targets. Each texel holds two complex numbers (RG
// and BA), transformed together. N must be a power of R: 512 = 8³, 256 = 16². Forward is
// X(k) = Σ x(n) e^(-2πi nk/N); inverse has e^(+2πi nk/N) and the 1/N per axis.

import { FloatType, GLSL3, NearestFilter, RGBAFormat, ShaderMaterial, type Texture, WebGLRenderTarget, type WebGLRenderer } from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

/** A float target for the FFT and the passes around it: no filtering, no depth. */
export function floatTarget(n: number): WebGLRenderTarget {
  return new WebGLRenderTarget(n, n, { type: FloatType, format: RGBAFormat, minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: false, generateMipmaps: false });
}

const FFT_FS = /* glsl */ `
precision highp float;
precision highp int;
uniform highp sampler2D uSrc;
uniform int uN;
uniform int uR;
uniform int uNs;
uniform int uAxis;
uniform float uSign;
uniform float uScale;
out vec4 outColor;
const float TAU = 6.283185307179586;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int o = uAxis == 0 ? c.x : c.y;
  int nsr = uNs * uR;
  // Output o of a radix-R butterfly: inputs j + m N/R, twiddled by e^(±2πi m (o mod Ns R) / (Ns R)).
  int j = (o / nsr) * uNs + o % uNs;
  int q = o % nsr;
  int stride = uN / uR;
  vec4 sum = vec4(0.0);
  for (int m = 0; m < 16; m++) {
    if (m >= uR) break;
    int idx = j + m * stride;
    vec4 x = texelFetch(uSrc, uAxis == 0 ? ivec2(idx, c.y) : ivec2(c.x, idx), 0);
    float a = uSign * TAU * float((q * m) % nsr) / float(nsr);
    vec2 w = vec2(cos(a), sin(a));
    sum += vec4(x.x * w.x - x.y * w.y, x.x * w.y + x.y * w.x, x.z * w.x - x.w * w.y, x.z * w.y + x.w * w.x);
  }
  outColor = sum * uScale;
}`;

const QUAD_VS = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** A full-screen pass in GLSL ES 3.0 (the fragment shader declares its own outputs). */
export function passMaterial(fragmentShader: string, uniforms: ShaderMaterial["uniforms"]): ShaderMaterial {
  return new ShaderMaterial({ glslVersion: GLSL3, vertexShader: QUAD_VS, fragmentShader, uniforms, depthTest: false, depthWrite: false });
}

export class GpuFft {
  private readonly quad: FullScreenQuad;
  private readonly mat: ShaderMaterial;
  private n = 0;
  private radix = 0;
  /** Ping-pong targets; a transform's result is one of them. */
  readonly a: WebGLRenderTarget;
  readonly b: WebGLRenderTarget;

  constructor(n: number) {
    this.a = floatTarget(n);
    this.b = floatTarget(n);
    this.mat = passMaterial(FFT_FS, {
      uSrc: { value: null },
      uN: { value: n },
      uR: { value: 8 },
      uNs: { value: 1 },
      uAxis: { value: 0 },
      uSign: { value: -1 },
      uScale: { value: 1 },
    });
    this.quad = new FullScreenQuad(this.mat);
    this.setSize(n);
  }

  setSize(n: number): void {
    this.n = n;
    // The largest radix up to 16 that N is a power of.
    const powerOf = (r: number) => {
      let m = n;
      while (m % r === 0) m /= r;
      return m === 1;
    };
    this.radix = [16, 8, 4, 2].find(powerOf) ?? 2;
    this.a.setSize(n, n);
    this.b.setSize(n, n);
  }

  /** Transforms `src` (forward, or inverse with the 1/N² scale) and returns the target holding the result. */
  run(renderer: WebGLRenderer, src: Texture, inverse: boolean): WebGLRenderTarget {
    const u = this.mat.uniforms;
    u.uN.value = this.n;
    u.uR.value = this.radix;
    u.uSign.value = inverse ? 1 : -1;
    let input = src;
    let out = this.a;
    for (let axis = 0; axis < 2; axis++)
      for (let ns = 1; ns < this.n; ns *= this.radix) {
        u.uSrc.value = input;
        u.uNs.value = ns;
        u.uAxis.value = axis;
        u.uScale.value = inverse && ns * this.radix >= this.n ? 1 / this.n : 1;
        renderer.setRenderTarget(out);
        this.quad.render(renderer);
        input = out.texture;
        out = out === this.a ? this.b : this.a;
      }
    return out === this.a ? this.b : this.a;
  }

  dispose(): void {
    this.a.dispose();
    this.b.dispose();
    this.mat.dispose();
    this.quad.dispose();
  }
}
