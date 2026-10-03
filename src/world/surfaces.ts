// The surfaces' shader additions on top of MeshStandardMaterial:
//   buildings  facade tiles on the walls (storey by storey, so tall blocks repeat their upper
//              floors over one ground floor), roof tiles on the roofs, both tinted by the
//              building's own colour; ambient occlusion at the foot of the wall; windows that
//              come on one by one between +3° and -12° of sun elevation (each building jittered
//              ±3°, a share of windows never lit), and a warm wash of street light at the foot.
//   quays      stone in world space, the promenade on top lit by its lamps at night.
//   terrain    a glow on streets and squares at night (the city's street lighting from above).
//   floodlit   landmarks and bridge towers lit from one side (the water) or all round.
//   hero       the hero landmarks' own layers, tinted per face, with windows that come on
//              one by one at dusk (combined with floodlit).

import { Color, type IUniform, type MeshStandardMaterial, type Texture, Vector2, Vector3 } from "three";
import { HERO_LAYERS, HERO_UV_RANGE, TEXTURES } from "../config";
import type { TextureSet } from "../textures";
import { NIGHT_GLSL, SHARED } from "./night";
import { HASH_GLSL, patchMaterial } from "./shaderPatch";

/** Warm street light (linear), times albedo, times uNight. */
export const STREET_GLOW = new Color("#ffb05a").multiplyScalar(0.32);
const WINDOW_GAIN = 1.5;

const common = () => ({ uSunElevation: SHARED.uSunElevation, uNight: SHARED.uNight, uTime: SHARED.uTime, uStreetGlow: { value: STREET_GLOW } });

const buildingUniforms = (tex: TextureSet) => ({
  ...common(),
  uSurfDay: tex.uniforms.surfacesDay,
  uSurfLit: tex.uniforms.surfacesLit,
  uStorey: { value: TEXTURES.storey },
  uRoofTile: { value: TEXTURES.roofTile },
  uPlasterTile: { value: TEXTURES.plasterTile },
  uPlasterLayer: { value: TEXTURES.facades.length + TEXTURES.roofs.length },
  uTintGain: { value: TEXTURES.tintGain },
  uWindowGain: { value: WINDOW_GAIN },
});

/** The buildings' fragment declarations, after the variant's own varyings. */
const buildingPars = (varyings: string) => /* glsl */ `
      uniform sampler2DArray uSurfDay;
      uniform sampler2DArray uSurfLit;
      uniform float uStorey;
      uniform float uRoofTile;
      uniform float uPlasterTile;
      uniform float uPlasterLayer;
      uniform float uTintGain;
      uniform float uWindowGain;
      uniform vec3 uStreetGlow;
      ${varyings}
      ${HASH_GLSL}
      ${NIGHT_GLSL}`;

/**
 * The buildings' surfaces, from `metres` (along the wall and up from its base, or across the
 * roof) and the varyings vCanyon, vSeed, vFacade (layer, wall height) and vRoof.
 */
const BUILDING_SURFACE = /* glsl */ `
        vec3 surfLit = vec3(0.0);
        // The street's (or courtyard's) skyline seen from this point of the wall: ambient light
        // falls off with the angle up to it, so canyons darken toward the ground.
        float skyline = atan(max(vCanyon.y - metres.y, 0.0), max(vCanyon.x, 0.5));
        float canyonAO = 1.0 - 0.62 * skyline / 1.5708;
        if (vRoof > 0.5) {
          vec2 ruv = metres / uRoofTile;
          vec3 roofTex = textureGrad(uSurfDay, vec3(ruv, vFacade.x), dFdx(ruv), dFdy(ruv)).rgb;
          // Weathering: patches of moss and soot, streaks down the slope, a per-roof shade.
          float stain = vnoise(metres * vec2(0.18, 0.11) + vSeed * 37.0) * 0.6 + vnoise(metres * vec2(0.9, 0.25)) * 0.4;
          float shade = 0.84 + 0.3 * fract(vSeed * 13.7);
          diffuseColor.rgb *= roofTex * uTintGain * shade * mix(0.8, 1.08, stain);
        } else if (vFacade.x > 13.5) {
          // Plain render (the plaster layer): cornices, chimneys and parapets (14), and the
          // blank firewalls (15), darker toward the ground.
          float firewall = step(14.5, vFacade.x);
          vec2 puv = (metres + vSeed * 37.0) / uPlasterTile;
          vec3 render = textureGrad(uSurfDay, vec3(puv, uPlasterLayer), dFdx(puv), dFdy(puv)).rgb;
          float grime = mix(0.62, 1.0, smoothstep(0.4, 6.5, metres.y));
          diffuseColor.rgb *= mix(vec3(1.0), render, mix(0.5, 1.0, firewall)) * uTintGain * grime * mix(1.0, 0.92, firewall);
        } else {
          // One tile is 4 bays by 4 storeys: the ground floor, then three storeys that repeat.
          float tile = uStorey * 4.0;
          float s = metres.y / uStorey;
          float storey = floor(s);
          float row = storey < 1.0 ? 0.0 : 1.0 + mod(storey - 1.0, 3.0);
          vec2 tuv = vec2(metres.x / tile, 1.0 - (row + fract(s)) * 0.25);
          // Gradients from the unwrapped coordinates, so the storey seams don't jump a mip level.
          vec2 gx = dFdx(metres) / tile;
          vec2 gy = dFdy(metres) / tile;
          vec3 albedo = textureGrad(uSurfDay, vec3(tuv, vFacade.x), gx, gy).rgb;
          // A cornice at the roof line: a light band over a dark groove.
          float toTop = vFacade.y - metres.y;
          albedo *= toTop < 0.7 ? 1.07 : toTop < 0.9 ? 0.74 : 1.0;
          float ao = mix(0.58, 1.0, smoothstep(0.4, 6.5, metres.y));
          diffuseColor.rgb *= albedo * uTintGain * ao;
          // Each window has its own moment: most come on between +3° and -12° (the building
          // shifted by up to ±3°), some never do; shopfronts are nearly all lit. Above +6.5°
          // none can be, so the day skips them (the branch is the same for every pixel).
          if (uSunElevation < 6.5) {
            vec2 cell = vec2(floor(metres.x / uStorey), storey);
            float h1 = hash12(cell + vSeed * 311.7);
            float h2 = hash12(cell.yx * 1.37 + vSeed * 97.1);
            float everOn = step(storey < 1.0 ? 0.15 : 0.5, h1);
            float at = 3.0 - 15.0 * h2 + (vSeed - 0.5) * 6.0;
            float on = smoothstep(at + 0.4, at - 0.4, uSunElevation) * everOn * step(0.9, toTop);
            if (on > 0.0) surfLit = textureGrad(uSurfLit, vec3(tuv, vFacade.x), gx, gy).rgb * on * uWindowGain * (0.75 + 0.5 * h1);
          }
        }`;

const buildingFragment = (prologue: string): [string, string, boolean?][] => [
  ["map_fragment", prologue + BUILDING_SURFACE, true],
  [
    "aomap_fragment",
    /* glsl */ `
        reflectedLight.indirectDiffuse *= canyonAO;
        reflectedLight.indirectSpecular *= canyonAO;`,
  ],
  [
    "emissivemap_fragment",
    /* glsl */ `
        totalEmissiveRadiance += surfLit + uStreetGlow * uNight * diffuseColor.rgb * (1.0 - smoothstep(1.0, 14.0, metres.y)) * (1.0 - vRoof);`,
  ],
];

export function patchBuildings(mat: MeshStandardMaterial, tex: TextureSet): void {
  patchMaterial(mat, {
    key: "buildings",
    uniforms: buildingUniforms(tex),
    vertexPars: /* glsl */ `
      attribute float _seed;
      attribute vec2 _facade;
      attribute vec2 _canyon;
      varying vec2 vCanyon;
      varying vec2 vMetres;
      varying float vSeed;
      varying vec2 vFacade;
      varying float vRoof;`,
    vertex: [
      [
        "uv_vertex",
        /* glsl */ `
        vMetres = uv * 1024.0;
        vCanyon = _canyon * 128.0;
        vSeed = _seed;
        vFacade = vec2(floor(_facade.x * 16.0 + 0.5), _facade.y * 128.0);
        // Layers 8-11 are roofs (their eaves' cornice tops too), 14 trim and 15 firewalls.
        vRoof = step(7.5, vFacade.x) * step(vFacade.x, 13.5);`,
      ],
    ],
    fragmentPars: buildingPars("varying vec2 vCanyon;\n      varying vec2 vMetres;\n      varying float vSeed;\n      varying vec2 vFacade;\n      varying float vRoof;"),
    fragment: buildingFragment("\n        vec2 metres = vMetres;"),
  });
}

/**
 * The far field's buildings (farWorker.ts) in the same surfaces: flat-shaded, their walls'
 * coordinates from the perimeter and the building's base, and the roofs' and firewalls'
 * worked out from the face itself (along the eaves and up the slope, as the world's are).
 */
export function patchFarBuildings(mat: MeshStandardMaterial, tex: TextureSet): void {
  patchMaterial(mat, {
    key: "far-buildings",
    uniforms: buildingUniforms(tex),
    vertexPars: /* glsl */ `
      attribute float aAlong;
      attribute vec2 aCanyon;
      attribute vec2 aInfo;
      attribute vec2 aLevel;
      varying vec2 vCanyon;
      varying vec2 vMetres;
      varying vec3 vFarPos;
      flat varying float vSeed;
      flat varying vec2 vFacade;
      flat varying float vRoof;
      flat varying float vBase;`,
    vertex: [
      [
        "begin_vertex",
        /* glsl */ `
        vFarPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vBase = aLevel.x * 0.1;
        vMetres = vec2(aAlong / 32.0, vFarPos.y - vBase);
        vCanyon = aCanyon * 128.0;
        vSeed = aInfo.y / 255.0;
        vFacade = vec2(aInfo.x, (aLevel.y - aLevel.x) * 0.1);
        vRoof = step(7.5, aInfo.x) * step(aInfo.x, 13.5);`,
      ],
    ],
    fragmentPars: buildingPars("varying vec2 vCanyon;\n      varying vec2 vMetres;\n      varying vec3 vFarPos;\n      flat varying float vSeed;\n      flat varying vec2 vFacade;\n      flat varying float vRoof;\n      flat varying float vBase;"),
    fragment: buildingFragment(/* glsl */ `
        vec2 metres = vMetres;
        if (vFacade.x > 7.5) {
          // Roofs and firewalls: from the face's own normal. A roof's u runs along its eaves and
          // v up its slope, in metres on the roof; a flat one takes x and z; a firewall's u runs along it.
          vec3 fn = normalize(cross(dFdx(vFarPos), dFdy(vFarPos)));
          float hl = length(fn.xz);
          vec2 dir = hl > 1e-3 ? fn.xz / hl : vec2(0.0, 1.0);
          if (vRoof > 0.5) metres = hl < 0.02 ? vFarPos.xz : vec2(dir.y * vFarPos.x - dir.x * vFarPos.z, -dot(dir, vFarPos.xz) / max(abs(fn.y), 0.2));
          else metres = vec2(dir.y * vFarPos.x - dir.x * vFarPos.z, vFarPos.y - vBase);
        }`),
  });
}

export function patchQuays(mat: MeshStandardMaterial, quay: IUniform<Texture>): void {
  patchMaterial(mat, {
    key: "quays",
    uniforms: { ...common(), uQuay: quay, uQuayTile: { value: TEXTURES.quayTile }, uTintGain: { value: TEXTURES.tintGain } },
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

/**
 * Floodlighting: the surface lit as if by its uplights, faded in with the night ramp. An
 * earlier patch may #define FLOOD_SCALE (the heroes' per-face response).
 */
export function patchFloodlit(mat: MeshStandardMaterial, flood: Flood): Record<string, IUniform> {
  const uniforms = {
    uSunElevation: SHARED.uSunElevation,
    uNight: SHARED.uNight,
    uTime: SHARED.uTime,
    uFloodColor: { value: flood.color },
    uFloodFrom: { value: flood.from },
    uFloodRange: { value: new Vector2(flood.base, flood.top) },
  };
  patchMaterial(mat, {
    key: "floodlit",
    uniforms,
    vertexPars: "varying vec3 vFloodPos;\nvarying vec3 vFloodNormal;",
    vertex: [["begin_vertex", "vFloodPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvFloodNormal = normalize(mat3(modelMatrix) * objectNormal);"]],
    fragmentPars: `${NIGHT_GLSL}
      #ifndef FLOOD_SCALE
      #define FLOOD_SCALE 1.0
      #endif
      uniform vec3 uFloodColor;
      uniform vec3 uFloodFrom;
      uniform vec2 uFloodRange;
      varying vec3 vFloodPos;
      varying vec3 vFloodNormal;`,
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
          totalEmissiveRadiance += uFloodColor * uNight * diffuseColor.rgb * (0.18 + 0.82 * facing) * mix(1.0, up * bays, wall) * FLOOD_SCALE;
        }`,
      ],
    ],
  });
  return uniforms;
}

/** Hero windows glow less than the city's: the floodlights carry the landmarks. */
const HERO_WINDOW_GAIN = 1.1;

/**
 * The hero landmarks (tools/heroes/): their own layer array (HERO_LAYERS), texture
 * coordinates in tiles, a tint per face (vertex colour), roughness per layer, and window
 * layers whose windows come on one by one at dusk.
 */
export function patchHero(mat: MeshStandardMaterial, tex: TextureSet): void {
  const n = HERO_LAYERS.length;
  patchMaterial(mat, {
    key: "hero",
    uniforms: {
      ...common(),
      uHeroDay: tex.uniforms.heroDay,
      uHeroLit: tex.uniforms.heroLit,
      uHeroLitCount: { value: tex.heroLitCount },
      uHeroRough: { value: tex.heroRoughness },
      uHeroGrid: { value: tex.heroGrid },
      uHeroWindowGain: { value: HERO_WINDOW_GAIN },
    },
    vertexPars: /* glsl */ `
      attribute vec2 _hero;
      varying vec2 vHeroUv;
      varying float vHeroLayer;
      varying float vHeroFlood;
      varying float vHeroPlane;`,
    vertex: [
      [
        "begin_vertex",
        /* glsl */ `
        vHeroUv = (uv - 0.5) * ${HERO_UV_RANGE.toFixed(1)};
        vHeroLayer = floor(_hero.x * 32.0 + 0.5);
        vHeroFlood = _hero.y * 4.0;
        // Faces are flat-shaded, so this is constant over a face: it tells parallel walls apart.
        vHeroPlane = dot((modelMatrix * vec4(transformed, 1.0)).xyz, normalize(mat3(modelMatrix) * objectNormal));`,
      ],
    ],
    fragmentPars: /* glsl */ `
      uniform sampler2DArray uHeroDay;
      uniform sampler2DArray uHeroLit;
      uniform float uHeroLitCount;
      uniform float uHeroRough[${n}];
      uniform vec2 uHeroGrid[${n}];
      uniform float uHeroWindowGain;
      varying vec2 vHeroUv;
      varying float vHeroLayer;
      varying float vHeroFlood;
      varying float vHeroPlane;
      #define FLOOD_SCALE vHeroFlood
      ${HASH_GLSL}
      ${NIGHT_GLSL}`,
    fragment: [
      [
        "map_fragment",
        /* glsl */ `
        int heroLayer = int(vHeroLayer + 0.5);
        vec2 huv = vec2(vHeroUv.x, -vHeroUv.y);
        vec2 hgx = dFdx(huv);
        vec2 hgy = dFdy(huv);
        diffuseColor.rgb *= textureGrad(uHeroDay, vec3(huv, float(heroLayer)), hgx, hgy).rgb;
        vec3 heroLit = vec3(0.0);
        if (float(heroLayer) < uHeroLitCount - 0.5) {
          // Each window has its own moment between +2° and -11°; a third never come on.
          vec2 cell = floor(vHeroUv * uHeroGrid[heroLayer] + 1e-3);
          float seed = fract(vHeroPlane * 0.0731) * 97.0;
          float h1 = hash12(cell + seed);
          float h2 = hash12(cell.yx * 1.37 + seed * 0.71);
          float at = 2.0 - 13.0 * h2;
          float on = smoothstep(at + 0.4, at - 0.4, uSunElevation) * step(0.33, h1);
          heroLit = textureGrad(uHeroLit, vec3(huv, float(heroLayer)), hgx, hgy).rgb * on * uHeroWindowGain * (0.7 + 0.5 * h1);
        }`,
        true,
      ],
      ["roughnessmap_fragment", "roughnessFactor = uHeroRough[heroLayer];"],
      ["emissivemap_fragment", "totalEmissiveRadiance += heroLit;"],
    ],
  });
}
