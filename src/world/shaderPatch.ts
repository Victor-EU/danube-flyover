// Small additions to three's built-in materials through onBeforeCompile: extra uniforms,
// declarations, and code inserted after (or in place of) named shader chunks. A material can
// take several patches (applied in the order given); materials whose patch keys match share
// one program, while their uniform values stay their own.

import type { IUniform, Material } from "three";

export interface ShaderPatch {
  key: string;
  uniforms?: Record<string, IUniform>;
  vertexPars?: string;
  /** [chunk, code]: code inserted after `#include <chunk>` in the vertex shader. */
  vertex?: [string, string][];
  fragmentPars?: string;
  /** [chunk, code, replace]: inserted after the chunk, or in its place when `replace`. */
  fragment?: [string, string, boolean?][];
}

/** Adds a patch to the material (after any it already has). */
export function patchMaterial(mat: Material, p: ShaderPatch): void {
  const patches: ShaderPatch[] = (mat.userData.patches ??= []);
  patches.push(p);
  mat.onBeforeCompile = (shader) => {
    // Declarations go in once, in patch order (a later patch may test an earlier one's #defines).
    let vs = shader.vertexShader.replace("#include <common>", `#include <common>\n${patches.map((q) => q.vertexPars ?? "").join("\n")}`);
    let fs = shader.fragmentShader.replace("#include <common>", `#include <common>\n${patches.map((q) => q.fragmentPars ?? "").join("\n")}`);
    for (const q of patches) {
      Object.assign(shader.uniforms, q.uniforms);
      for (const [chunk, code] of q.vertex ?? []) vs = insert(vs, chunk, code, false);
      for (const [chunk, code, replace] of q.fragment ?? []) fs = insert(fs, chunk, code, !!replace);
    }
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  const key = patches.map((q) => q.key).join("+");
  mat.customProgramCacheKey = () => key;
  mat.needsUpdate = true;
}

function insert(src: string, chunk: string, code: string, replace: boolean): string {
  const tag = `#include <${chunk}>`;
  if (!src.includes(tag)) throw new Error(`shader patch: no ${tag}`);
  return src.replace(tag, replace ? code : `${tag}\n${code}`);
}

/** GLSL: a stable hash of a 2D cell to [0, 1); safe to include twice. */
export const HASH_GLSL = /* glsl */ `
#ifndef HASH_GLSL
#define HASH_GLSL
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
/** Smooth value noise in [0, 1]. */
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
#endif`;
