// Small additions to three's built-in materials through onBeforeCompile: extra uniforms,
// declarations, and code inserted after (or in place of) named shader chunks. Materials that
// share a patch `key` share one program; their uniform values stay their own.

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

export function patchMaterial(mat: Material, p: ShaderPatch): void {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, p.uniforms);
    let vs = shader.vertexShader.replace("#include <common>", `#include <common>\n${p.vertexPars ?? ""}`);
    for (const [chunk, code] of p.vertex ?? []) vs = insert(vs, chunk, code, false);
    let fs = shader.fragmentShader.replace("#include <common>", `#include <common>\n${p.fragmentPars ?? ""}`);
    for (const [chunk, code, replace] of p.fragment ?? []) fs = insert(fs, chunk, code, !!replace);
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => p.key;
}

function insert(src: string, chunk: string, code: string, replace: boolean): string {
  const tag = `#include <${chunk}>`;
  if (!src.includes(tag)) throw new Error(`shader patch: no ${tag}`);
  return src.replace(tag, replace ? code : `${tag}\n${code}`);
}

/** GLSL: a stable hash of a 2D cell to [0, 1). */
export const HASH_GLSL = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}`;
