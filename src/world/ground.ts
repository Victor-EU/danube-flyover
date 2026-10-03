// The city's ground (tools/build-ground.ts): a 1 m mask over the world (the carriageways'
// signed distance, grass, unpaved paths, cobbles), 2 m ambient occlusion from the buildings
// around, and the markings and tram rails. The terrain's shader paints with them, from the
// photographed surfaces (TEXTURES.ground): asphalt with a darker gutter inside the kerb, the
// kerb stones, paving slabs on the pavements and squares, lawns, gravel and setts, under the
// baked occlusion.

import { Color, DataTexture, LinearFilter, LinearMipmapLinearFilter, type Mesh, type MeshStandardMaterial, type Object3D, RGBAFormat, RedFormat, UnsignedByteType, Vector4, type IUniform, type Texture } from "three";
import { TEXTURES } from "../config";
import type { TextureSet } from "../textures";
import { decodeGrid } from "./gridFile";
import { SHARED } from "./night";
import { HASH_GLSL, patchMaterial } from "./shaderPatch";
import { LAYER } from "./water";

export interface Ground {
  mask: Texture;
  ao: Texture;
  /** x0, z0, width, depth of the mask in world metres. */
  rect: Vector4;
  sdfRange: number;
}

function dataTexture(data: Uint8Array, w: number, h: number, rgba: boolean): Texture {
  const t = new DataTexture(data, w, h, rgba ? RGBAFormat : RedFormat, UnsignedByteType);
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

export function loadGround(maskBytes: ArrayBuffer | Uint8Array, aoBytes: ArrayBuffer | Uint8Array): Ground {
  const m = decodeGrid(maskBytes);
  const a = decodeGrid(aoBytes);
  const h = m.header;
  return {
    mask: dataTexture(m.layers.rgba as Uint8Array, h.nx, h.nz, true),
    ao: dataTexture(a.layers.ao as Uint8Array, a.header.nx, a.header.nz, false),
    rect: new Vector4(h.x0, h.z0, h.nx * h.cell, h.nz * h.cell),
    sdfRange: (h.sdfRange as number) ?? 8,
  };
}

/** The markings and rails: worn white paint and steel, a hair above the ground, out of the reflection. */
export function prepareMarks(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as MeshStandardMaterial;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -4;
    mat.polygonOffsetUnits = -4;
    mesh.receiveShadow = true;
    mesh.layers.set(LAYER.details);
  });
}

export function groundUniforms(g: Ground, tex: TextureSet): Record<string, IUniform> {
  return {
    uGround: { value: g.mask },
    uGroundAo: { value: g.ao },
    uGroundRect: { value: g.rect },
    uSdfRange: { value: g.sdfRange },
    uGroundTex: tex.uniforms.ground,
    uGroundTile: { value: [...TEXTURES.groundTile] },
    uLampNight: SHARED.uNight,
    uLampGlow: { value: new Color("#ffb769").multiplyScalar(1.6) },
  };
}

/** GLSL for the terrain's fragment shader: needs vGroundPos (world), vUrban and HASH_GLSL's vnoise. */
export const GROUND_GLSL = /* glsl */ `
uniform sampler2D uGround;
uniform sampler2D uGroundAo;
uniform vec4 uGroundRect;
uniform float uSdfRange;
uniform sampler2DArray uGroundTex;
uniform float uGroundTile[${TEXTURES.ground.length}];
uniform float uLampNight;
uniform vec3 uLampGlow;
float fbm2(vec2 p) { return vnoise(p) * 0.6 + vnoise(p * 2.3 + 7.1) * 0.3 + vnoise(p * 5.1 - 3.7) * 0.1; }
/**
 * A ground surface (TEXTURES.ground): the photograph at its tile size, and for the irregular
 * ones a second, rotated and larger sample blended in by noise, so the tiling doesn't show.
 */
vec3 surface(int layer, vec2 p, bool irregular) {
  vec2 uv = p / uGroundTile[layer];
  vec3 a = texture(uGroundTex, vec3(uv, float(layer))).rgb;
  if (!irregular) return a;
  vec3 b = texture(uGroundTex, vec3(mat2(0.8, -0.6, 0.6, 0.8) * uv * 0.41 + 0.37, float(layer))).rgb;
  return mix(a, b, smoothstep(0.3, 0.7, vnoise(p * 0.06 + float(layer) * 3.1)) * 0.7);
}
vec3 groundAlbedo(vec3 base, vec2 p, out float groundAo, out float lamplit) {
  vec2 guv = (p - uGroundRect.xy) / uGroundRect.zw;
  vec4 gm = texture2D(uGround, guv);
  groundAo = texture2D(uGroundAo, guv).r;
  float sd = (0.5 - gm.r) * 2.0 * uSdfRange; // metres from the kerb line, negative on the road
  float aa = max(fwidth(sd) * 0.75, 0.01);
  // Broad variation: a pavement's patches of newer slabs, a lawn's drier stretches.
  float big = 0.86 + 0.28 * fbm2(p * 0.04);
  vec3 grass = surface(3, p, true) * big;
  vec3 gravel = surface(4, p, true) * big;
  // Off the paving: the woods' leaf litter (brown base colours) or rough grass (green ones).
  float woods = clamp((base.r - base.g) * 14.0 + 0.5, 0.0, 1.0);
  vec3 natural = mix(grass * 0.9, gravel * vec3(0.7, 0.6, 0.48), woods);
  vec3 col = mix(natural, surface(1, p, false) * big, vUrban);
  col = mix(col, grass, gm.g);
  col = mix(col, gravel, gm.b * (1.0 - gm.g));
  // The kerb: a pale stone band just off the road.
  float kerb = smoothstep(-aa, aa, sd) * (1.0 - smoothstep(0.28 - aa, 0.28 + aa, sd));
  col = mix(col, vec3(0.5, 0.49, 0.46) * (0.9 + 0.1 * vnoise(p * 4.0)), kerb);
  // The carriageway: asphalt, a darker gutter by the kerb, or setts.
  float road = 1.0 - smoothstep(-aa, aa, sd);
  // At night the street lamps light the carriageway and the pavements beside it, in pools.
  lamplit = (1.0 - smoothstep(-2.0, 7.0, sd)) * (0.55 + 0.45 * smoothstep(0.25, 0.75, vnoise(p * 0.09))) * (1.0 - gm.g * 0.7);
  vec3 asphalt = surface(0, p, true) * (0.88 + 0.24 * fbm2(p * 0.05 + 9.0)) * mix(0.72, 1.0, smoothstep(-0.05, -0.6, sd));
  vec3 sett = surface(2, p, false) * big;
  col = mix(col, mix(asphalt, sett, gm.a), road);
  return col;
}
`;

/** Paints the terrain's material with the ground (after its own patch, which adds the night glow). */
export function patchGround(mat: MeshStandardMaterial, g: Ground, tex: TextureSet): void {
  patchMaterial(mat, {
    key: "ground",
    uniforms: groundUniforms(g, tex),
    vertexPars: "attribute float urban;\nvarying float vUrban;\nvarying vec3 vGroundPos;",
    vertex: [["begin_vertex", "vGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvUrban = urban;"]],
    fragmentPars: `varying vec3 vGroundPos;\nvarying float vUrban;\n${HASH_GLSL}\n${GROUND_GLSL}`,
    fragment: [
      ["color_fragment", "float groundAo;\nfloat lamplit;\ndiffuseColor.rgb = groundAlbedo(diffuseColor.rgb, vGroundPos.xz, groundAo, lamplit);\ndiffuseColor.rgb *= mix(0.8, 1.0, groundAo);"],
      ["aomap_fragment", "reflectedLight.indirectDiffuse *= groundAo;\nreflectedLight.indirectSpecular *= groundAo;"],
      ["emissivemap_fragment", "totalEmissiveRadiance += uLampGlow * uLampNight * lamplit * (diffuseColor.rgb + 0.04);"],
    ],
  });
}
