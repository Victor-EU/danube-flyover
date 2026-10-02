// The surfaces' shader additions on top of MeshStandardMaterial:
//   buildings  facade tiles on the walls (storey by storey, so tall blocks repeat their upper
//              floors over one ground floor), roof tiles on the roofs, both tinted by the
//              building's own colour; ambient occlusion at the foot of the wall; windows that
//              come on one by one between +3° and -12° of sun elevation (each building jittered
//              ±3°, a share of windows never lit), and a warm wash of street light at the foot.
//   quays      stone in world space, the promenade on top lit by its lamps at night.
//   terrain    a glow on streets and squares at night (the city's street lighting from above).
//   floodlit   landmarks and bridge towers lit from one side (the water) or all round.

import { Color, type IUniform, type MeshStandardMaterial, type Texture, Vector2, Vector3 } from "three";
import { TEXTURES } from "../config";
import type { TextureSet } from "../textures";
import { NIGHT_GLSL, SHARED } from "./night";
import { HASH_GLSL, patchMaterial } from "./shaderPatch";

/** Warm street light (linear), times albedo, times uNight. */
export const STREET_GLOW = new Color("#ffb05a").multiplyScalar(0.32);
const WINDOW_GAIN = 1.5;

const common = () => ({ uSunElevation: SHARED.uSunElevation, uNight: SHARED.uNight, uTime: SHARED.uTime, uStreetGlow: { value: STREET_GLOW } });

export function patchBuildings(mat: MeshStandardMaterial, tex: TextureSet): void {
  patchMaterial(mat, {
    key: "buildings",
    uniforms: {
      ...common(),
      uSurfDay: { value: tex.surfacesDay },
      uSurfLit: { value: tex.surfacesLit },
      uStorey: { value: TEXTURES.storey },
      uRoofTile: { value: TEXTURES.roofTile },
      uTintGain: { value: TEXTURES.tintGain },
      uWindowGain: { value: WINDOW_GAIN },
    },
    vertexPars: /* glsl */ `
      attribute float _seed;
      attribute vec2 _facade;
      varying vec2 vMetres;
      varying float vSeed;
      varying vec2 vFacade;
      varying float vRoof;`,
    vertex: [
      [
        "uv_vertex",
        /* glsl */ `
        vMetres = uv * 1024.0;
        vSeed = _seed;
        vFacade = vec2(floor(_facade.x * 16.0 + 0.5), _facade.y * 128.0);
        vRoof = step(0.5, normal.y);`,
      ],
    ],
    fragmentPars: /* glsl */ `
      uniform sampler2DArray uSurfDay;
      uniform sampler2DArray uSurfLit;
      uniform float uStorey;
      uniform float uRoofTile;
      uniform float uTintGain;
      uniform float uWindowGain;
      uniform vec3 uStreetGlow;
      varying vec2 vMetres;
      varying float vSeed;
      varying vec2 vFacade;
      varying float vRoof;
      ${HASH_GLSL}
      ${NIGHT_GLSL}`,
    fragment: [
      [
        "map_fragment",
        /* glsl */ `
        vec3 surfLit = vec3(0.0);
        if (vRoof > 0.5) {
          vec2 ruv = vMetres / uRoofTile;
          diffuseColor.rgb *= textureGrad(uSurfDay, vec3(ruv, vFacade.x), dFdx(ruv), dFdy(ruv)).rgb * uTintGain;
        } else {
          // One tile is 4 bays by 4 storeys: the ground floor, then three storeys that repeat.
          float tile = uStorey * 4.0;
          float s = vMetres.y / uStorey;
          float storey = floor(s);
          float row = storey < 1.0 ? 0.0 : 1.0 + mod(storey - 1.0, 3.0);
          vec2 tuv = vec2(vMetres.x / tile, 1.0 - (row + fract(s)) * 0.25);
          // Gradients from the unwrapped coordinates, so the storey seams don't jump a mip level.
          vec2 gx = dFdx(vMetres) / tile;
          vec2 gy = dFdy(vMetres) / tile;
          vec3 albedo = textureGrad(uSurfDay, vec3(tuv, vFacade.x), gx, gy).rgb;
          // A cornice at the roof line: a light band over a dark groove.
          float toTop = vFacade.y - vMetres.y;
          albedo *= toTop < 0.7 ? 1.07 : toTop < 0.9 ? 0.74 : 1.0;
          float ao = mix(0.58, 1.0, smoothstep(0.4, 6.5, vMetres.y));
          diffuseColor.rgb *= albedo * uTintGain * ao;
          // Each window has its own moment: most come on between +3° and -12° (the building
          // shifted by up to ±3°), some never do; shopfronts are nearly all lit.
          vec2 cell = vec2(floor(vMetres.x / uStorey), storey);
          float h1 = hash12(cell + vSeed * 311.7);
          float h2 = hash12(cell.yx * 1.37 + vSeed * 97.1);
          float everOn = step(storey < 1.0 ? 0.15 : 0.5, h1);
          float at = 3.0 - 15.0 * h2 + (vSeed - 0.5) * 6.0;
          float on = smoothstep(at + 0.4, at - 0.4, uSunElevation) * everOn * step(0.9, toTop);
          surfLit = textureGrad(uSurfLit, vec3(tuv, vFacade.x), gx, gy).rgb * on * uWindowGain * (0.75 + 0.5 * h1);
        }`,
        true,
      ],
      [
        "emissivemap_fragment",
        /* glsl */ `
        totalEmissiveRadiance += surfLit + uStreetGlow * uNight * diffuseColor.rgb * (1.0 - smoothstep(1.0, 14.0, vMetres.y)) * (1.0 - vRoof);`,
      ],
    ],
  });
}

export function patchQuays(mat: MeshStandardMaterial, quay: Texture): void {
  patchMaterial(mat, {
    key: "quays",
    uniforms: { ...common(), uQuay: { value: quay }, uQuayTile: { value: TEXTURES.quayTile }, uTintGain: { value: TEXTURES.tintGain } },
    vertexPars: "varying vec3 vQuayPos;\nvarying vec3 vQuayNormal;",
    vertex: [["begin_vertex", "vQuayPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvQuayNormal = normalize(mat3(modelMatrix) * objectNormal);"]],
    fragmentPars: `uniform sampler2D uQuay;\nuniform float uQuayTile;\nuniform float uTintGain;\nuniform vec3 uStreetGlow;\nvarying vec3 vQuayPos;\nvarying vec3 vQuayNormal;\n${NIGHT_GLSL}`,
    fragment: [
      [
        "map_fragment",
        /* glsl */ `
        vec3 qn = abs(vQuayNormal);
        float quayTop = step(0.5, qn.y);
        vec2 quv = (quayTop > 0.5 ? vQuayPos.xz : qn.x > qn.z ? vQuayPos.zy : vQuayPos.xy) / uQuayTile;
        diffuseColor.rgb *= texture2D(uQuay, quv).rgb * uTintGain;`,
        true,
      ],
      ["emissivemap_fragment", "totalEmissiveRadiance += uStreetGlow * 1.4 * uNight * diffuseColor.rgb * quayTop;"],
    ],
  });
}

export function patchTerrain(mat: MeshStandardMaterial): void {
  patchMaterial(mat, {
    key: "terrain",
    uniforms: common(),
    vertexPars: "attribute float glow;\nvarying float vGlow;",
    vertex: [["begin_vertex", "vGlow = glow;"]],
    fragmentPars: `uniform vec3 uStreetGlow;\nvarying float vGlow;\n${NIGHT_GLSL}`,
    fragment: [["emissivemap_fragment", "totalEmissiveRadiance += uStreetGlow * 0.55 * uNight * vGlow * diffuseColor.rgb;"]],
  });
}

export interface Flood {
  /** Light colour times strength (linear). */
  color: Color;
  /** Unit direction the light comes from (toward the water), or zero for all round. */
  from: Vector3;
  /** World y of the lit part's base and top: brightest at the base, as uplights are. */
  base: number;
  top: number;
}

/** Floodlighting: the surface lit as if by its uplights, faded in with the night ramp. */
export function patchFloodlit(mat: MeshStandardMaterial, flood: Flood): Record<string, IUniform> {
  const uniforms = {
    uNight: SHARED.uNight,
    uFloodColor: { value: flood.color },
    uFloodFrom: { value: flood.from },
    uFloodRange: { value: new Vector2(flood.base, flood.top) },
  };
  patchMaterial(mat, {
    key: "floodlit",
    uniforms,
    vertexPars: "varying vec3 vFloodPos;\nvarying vec3 vFloodNormal;",
    vertex: [["begin_vertex", "vFloodPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvFloodNormal = normalize(mat3(modelMatrix) * objectNormal);"]],
    fragmentPars: "uniform float uNight;\nuniform vec3 uFloodColor;\nuniform vec3 uFloodFrom;\nuniform vec2 uFloodRange;\nvarying vec3 vFloodPos;\nvarying vec3 vFloodNormal;",
    fragment: [
      [
        "emissivemap_fragment",
        /* glsl */ `
        {
          vec3 n = normalize(vFloodNormal);
          float facing = dot(uFloodFrom, uFloodFrom) > 0.5 ? max(dot(n, uFloodFrom), 0.0) : 0.65 + 0.35 * abs(n.y);
          float h = clamp((vFloodPos.y - uFloodRange.x) / max(uFloodRange.y - uFloodRange.x, 1.0), 0.0, 1.0);
          // Uplights: bright at the foot, falling away up the wall, and pooling between the
          // pilasters every 4 m, so a block reads as lit stone rather than a lightbox.
          vec2 t = normalize(vec2(-n.z, n.x) + 1e-4);
          float along = dot(vFloodPos.xz, t) / 4.0;
          float bays = 0.72 + 0.28 * smoothstep(0.0, 0.5, abs(fract(along) - 0.5) * 2.0 - 0.1);
          float wall = 1.0 - abs(n.y);
          float up = mix(1.25, 0.32, pow(h, 0.8));
          totalEmissiveRadiance += uFloodColor * uNight * diffuseColor.rgb * (0.18 + 0.82 * facing) * mix(1.0, up * bays, wall);
        }`,
      ],
    ],
  });
  return uniforms;
}
