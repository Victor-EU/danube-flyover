// The packed texture set from public/data/tex/ (tools/pack-textures.ts): the facade and roof
// layers and the heroes' layers as array textures, the quay stone, the water normal map, and
// the four sky panoramas, plus small CPU copies of the skies so lighting can sample their
// colours.
// Browser only. Images are decoded without premultiplying or colour conversion, and none is
// flipped: v = 0 is the top row of every image.

import {
  DataArrayTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  Vector2,
  type WebGLRenderer,
} from "three";

export interface TexturesJson {
  layer: number;
  surfaces: { day: string; lit: string; layers: string[]; litLayers: string[] };
  heroes: { day: string; lit: string; layers: string[]; litLayers: string[]; roughness: number[]; grid: [number, number][] };
  quay: string;
  waterNormal: string;
  skies: Record<string, string>;
  bytes: Record<string, number>;
}

/** A sky panorama downsampled to PROBE_W × PROBE_H, linear RGB. */
export interface SkyProbe {
  w: number;
  h: number;
  data: Float32Array;
}

export interface TextureSet {
  surfacesDay: DataArrayTexture;
  surfacesLit: DataArrayTexture;
  heroDay: DataArrayTexture;
  heroLit: DataArrayTexture;
  heroLitCount: number;
  heroRoughness: number[];
  heroGrid: Vector2[];
  quay: Texture;
  waterNormal: Texture;
  skies: Record<string, Texture>;
  skyProbes: Record<string, SkyProbe>;
}

const PROBE_W = 64;
const PROBE_H = 32;

const decode = (bytes: ArrayBuffer) =>
  createImageBitmap(new Blob([bytes], { type: "image/webp" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });

function pixels(img: ImageBitmap, w = img.width, h = img.height): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

function arrayTexture(img: ImageBitmap, layer: number): DataArrayTexture {
  const depth = Math.round(img.height / layer);
  const tex = new DataArrayTexture(new Uint8Array(pixels(img).buffer), layer, layer, depth);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

function texture(img: ImageBitmap, srgb: boolean, repeat: boolean, mipmaps = true): Texture {
  const tex = new Texture(img);
  tex.flipY = false;
  if (srgb) tex.colorSpace = SRGBColorSpace;
  if (repeat) tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.generateMipmaps = mipmaps;
  tex.minFilter = mipmaps ? LinearMipmapLinearFilter : LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function probe(img: ImageBitmap): SkyProbe {
  const px = pixels(img, PROBE_W, PROBE_H);
  const data = new Float32Array(PROBE_W * PROBE_H * 3);
  for (let i = 0; i < PROBE_W * PROBE_H; i++) for (let k = 0; k < 3; k++) data[i * 3 + k] = toLinear(px[i * 4 + k] / 255);
  return { w: PROBE_W, h: PROBE_H, data };
}

/** `get` fetches a file under data/ (with the loader's progress). */
export async function loadTextures(manifest: TexturesJson, get: (file: string) => Promise<ArrayBuffer>): Promise<TextureSet> {
  const img = async (file: string) => decode(await get(`tex/${file}`));
  const skyNames = Object.keys(manifest.skies);
  const [day, lit, heroDay, heroLit, quay, normal, ...skies] = await Promise.all([
    img(manifest.surfaces.day),
    img(manifest.surfaces.lit),
    img(manifest.heroes.day),
    img(manifest.heroes.lit),
    img(manifest.quay),
    img(manifest.waterNormal),
    ...skyNames.map((s) => img(manifest.skies[s])),
  ]);
  return {
    surfacesDay: arrayTexture(day, manifest.layer),
    surfacesLit: arrayTexture(lit, manifest.layer),
    heroDay: arrayTexture(heroDay, manifest.layer),
    heroLit: arrayTexture(heroLit, manifest.layer),
    heroLitCount: manifest.heroes.litLayers.length,
    heroRoughness: manifest.heroes.roughness,
    heroGrid: manifest.heroes.grid.map(([b, r]) => new Vector2(b, r)),
    quay: texture(quay, true, true),
    waterNormal: texture(normal, false, true),
    // The skies are magnified almost everywhere: no mipmaps, so the u = 0/1 seam can't show.
    skies: Object.fromEntries(skyNames.map((s, i) => [s, texture(skies[i], true, false, false)])),
    skyProbes: Object.fromEntries(skyNames.map((s, i) => [s, probe(skies[i])])),
  };
}

/** Anisotropic filtering for the surfaces seen at grazing angles (walls, quays, water). */
export function setAnisotropy(set: TextureSet, renderer: WebGLRenderer, max = 8): void {
  const a = Math.max(1, Math.min(max, renderer.capabilities.getMaxAnisotropy()));
  for (const t of [set.surfacesDay, set.surfacesLit, set.heroDay, set.heroLit, set.quay, set.waterNormal]) {
    if (t.anisotropy === a) continue;
    t.anisotropy = a;
    t.needsUpdate = true;
  }
}
