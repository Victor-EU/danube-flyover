// The packed texture set from public/data/tex/ (tools/pack-textures.ts): the facade and roof
// layers and the heroes' layers as array textures, the quay stone, the water normal map, and
// the four sky panoramas, plus small CPU copies of the skies so lighting can sample their
// colours. The first frame draws with the half-size WebP set; the full-size KTX2 set takes
// its place once it has loaded (upgradeTextures), the skies with it at 4096 × 2048.
// Browser only. Images are decoded without premultiplying or colour conversion, and none is
// flipped: v = 0 is the top row of every image (KTX2 files are stored top row first too).

import {
  CompressedArrayTexture,
  type CompressedTexture,
  DataArrayTexture,
  type IUniform,
  LinearFilter,
  LinearMipmapLinearFilter,
  ClampToEdgeWrapping,
  RepeatWrapping,
  RGB_ETC1_Format,
  RGB_ETC2_Format,
  RGBA_ASTC_4x4_Format,
  RGBA_BPTC_Format,
  RGBA_ETC2_EAC_Format,
  RGBA_S3TC_DXT1_Format,
  RGBA_S3TC_DXT5_Format,
  SRGBColorSpace,
  Texture,
  Vector2,
  type WebGLRenderer,
} from "three";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { QUALITY } from "./config";

export interface TexturesJson {
  layer: number;
  surfaces: { day: string; lit: string; layers: string[]; litLayers: string[] };
  heroes: { day: string; lit: string; layers: string[]; litLayers: string[]; roughness: number[]; grid: [number, number][] };
  ground: { day: string; layers: string[] };
  quay: string;
  waterNormal: string;
  skies: Record<string, string>;
  bytes: Record<string, number>;
  /** The full-size set: a KTX2 file per layer, in the order of the layers above. */
  full?: {
    layer: number;
    surfaces: { day: string[]; lit: string[] };
    heroes: { day: string[]; lit: string[] };
    ground: string[];
    quay: string;
    /** The skies' width (their height is half), and a UASTC file per sky. */
    sky: number;
    skies: Record<string, string>;
    bytes: Record<string, number>;
  };
}

/** A sky panorama downsampled to PROBE_W × PROBE_H, linear RGB. */
export interface SkyProbe {
  w: number;
  h: number;
  data: Float32Array;
}

/** The textures the full-size set replaces. */
type Upgradable = "surfacesDay" | "surfacesLit" | "heroDay" | "heroLit" | "ground" | "quay";

export interface TextureSet {
  surfacesDay: DataArrayTexture | CompressedArrayTexture;
  surfacesLit: DataArrayTexture | CompressedArrayTexture;
  heroDay: DataArrayTexture | CompressedArrayTexture;
  heroLit: DataArrayTexture | CompressedArrayTexture;
  /** The streets' and parks' surfaces (TEXTURES.ground). */
  ground: DataArrayTexture | CompressedArrayTexture;
  heroLitCount: number;
  heroRoughness: number[];
  heroGrid: Vector2[];
  quay: Texture;
  waterNormal: Texture;
  skies: Record<string, Texture>;
  skyProbes: Record<string, SkyProbe>;
  /**
   * The uniforms the materials sample these through, shared by every material, so the
   * full-size set takes the half-size one's place everywhere at once.
   */
  uniforms: Record<Upgradable, IUniform<Texture>>;
  /** The skies' uniforms, by name, for the dome (the same way). */
  skyUniforms: Record<string, IUniform<Texture>>;
  full: TexturesJson["full"];
  /** What's in use, for the debug panel. */
  status: string;
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
  const [day, lit, heroDay, heroLit, ground, quay, normal, ...skies] = await Promise.all([
    img(manifest.surfaces.day),
    img(manifest.surfaces.lit),
    img(manifest.heroes.day),
    img(manifest.heroes.lit),
    img(manifest.ground.day),
    img(manifest.quay),
    img(manifest.waterNormal),
    ...skyNames.map((s) => img(manifest.skies[s])),
  ]);
  const set = {
    surfacesDay: arrayTexture(day, manifest.layer),
    surfacesLit: arrayTexture(lit, manifest.layer),
    heroDay: arrayTexture(heroDay, manifest.layer),
    heroLit: arrayTexture(heroLit, manifest.layer),
    ground: arrayTexture(ground, manifest.layer),
    heroLitCount: manifest.heroes.litLayers.length,
    heroRoughness: manifest.heroes.roughness,
    heroGrid: manifest.heroes.grid.map(([b, r]) => new Vector2(b, r)),
    quay: texture(quay, true, true),
    waterNormal: texture(normal, false, true),
    skies: Object.fromEntries(skyNames.map((s, i) => [s, skyTexture(texture(skies[i], true, false, false))])),
    skyProbes: Object.fromEntries(skyNames.map((s, i) => [s, probe(skies[i])])),
    full: manifest.full,
    status: `WebP ${manifest.layer}²`,
  };
  const uniforms = Object.fromEntries(UPGRADABLE.map((k) => [k, { value: set[k] }])) as TextureSet["uniforms"];
  const skyUniforms = Object.fromEntries(skyNames.map((s) => [s, { value: set.skies[s] }]));
  return { ...set, uniforms, skyUniforms };
}

/**
 * The skies are magnified almost everywhere: no mipmaps, so the u = 0/1 seam can't pick a
 * smaller one there, and they wrap round the compass (u) but not past the poles (v).
 */
function skyTexture<T extends Texture>(tex: T): T {
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const UPGRADABLE: Upgradable[] = ["surfacesDay", "surfacesLit", "heroDay", "heroLit", "ground", "quay"];

/** The GPU formats KTX2Loader can transcode ETC1S to, by name for the debug panel. */
const FORMAT_NAMES: Record<number, string> = {
  [RGB_ETC1_Format]: "ETC1",
  [RGB_ETC2_Format]: "ETC2",
  [RGBA_ETC2_EAC_Format]: "ETC2",
  [RGBA_BPTC_Format]: "BC7",
  [RGBA_S3TC_DXT1_Format]: "BC1",
  [RGBA_S3TC_DXT5_Format]: "BC3",
  [RGBA_ASTC_4x4_Format]: "ASTC",
};

/**
 * The full-size set (tools/pack-textures.ts: ETC1S KTX2 at the masters' 1024², UASTC skies at
 * 4096 × 2048) in place of the half-size WebP: fetched and transcoded in workers to a format
 * the GPU takes, a file per layer, stacked here into array textures like the WebP strips,
 * uploaded, then swapped in through the shared uniforms all at once, and the WebP set released.
 * Stays on the WebP when the GPU takes no compressed format (RGBA at full size would be four
 * times the memory), or if anything fails. Resolves to whether it swapped.
 */
export async function upgradeTextures(set: TextureSet, renderer: WebGLRenderer): Promise<boolean> {
  const full = set.full;
  if (!full) return false;
  // The transcoder comes with three: KTX2Loader finds it by import.meta.url, which Vite
  // resolves in the dev server and copies into the build.
  const loader = new KTX2Loader().detectSupport(renderer);
  const made: Texture[] = [];
  try {
    const load = async (file: string) => {
      const t = (await loader.loadAsync(`data/tex/${file}`)) as CompressedTexture;
      if (!t.isCompressedTexture || !(t.format in FORMAT_NAMES)) throw new Error(`${file}: no compressed format for this GPU`);
      return t;
    };
    const stack = async (files: string[]) => {
      const layers = await Promise.all(files.map(load));
      const first = layers[0];
      // Each mip level holds every layer in turn.
      const mipmaps = first.mipmaps.map((m, level) => {
        const size = m.data.byteLength;
        const data = new Uint8Array(size * layers.length);
        layers.forEach((t, k) => data.set(t.mipmaps[level].data as Uint8Array, k * size));
        return { data, width: m.width, height: m.height };
      });
      for (const t of layers) t.dispose();
      const tex = new CompressedArrayTexture(mipmaps, first.image.width, first.image.height, layers.length, first.format, first.type);
      return settle(tex);
    };
    const settle = <T extends Texture>(tex: T): T => {
      tex.colorSpace = SRGBColorSpace;
      tex.wrapS = tex.wrapT = RepeatWrapping;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.magFilter = LinearFilter;
      tex.generateMipmaps = false;
      tex.anisotropy = Math.max(1, Math.min(QUALITY.anisotropy, renderer.capabilities.getMaxAnisotropy()));
      tex.needsUpdate = true;
      made.push(tex);
      return tex;
    };
    const next = {
      surfacesDay: await stack(full.surfaces.day),
      surfacesLit: await stack(full.surfaces.lit),
      heroDay: await stack(full.heroes.day),
      heroLit: await stack(full.heroes.lit),
      ground: await stack(full.ground),
      quay: settle(await load(full.quay)),
    };
    const skies = Object.fromEntries(await Promise.all(Object.entries(full.skies).map(async ([name, file]) => [name, skyTexture(await load(file))] as const)));
    for (const t of Object.values(skies)) {
      t.colorSpace = SRGBColorSpace;
      made.push(t);
    }
    for (const t of made) renderer.initTexture(t);
    let bytes = 0;
    const size = (t: Texture) => (t.mipmaps as { data: ArrayBufferView }[]).reduce((a, m) => a + m.data.byteLength, 0);
    for (const k of UPGRADABLE) {
      const old = set[k];
      (set as Record<Upgradable, Texture>)[k] = next[k];
      set.uniforms[k].value = next[k];
      old.dispose();
      bytes += size(next[k]);
    }
    for (const [name, t] of Object.entries(skies)) {
      set.skies[name].dispose();
      set.skies[name] = set.skyUniforms[name].value = t;
      bytes += size(t);
    }
    const sky = Object.values(skies)[0];
    set.status = `KTX2 ${full.layer}², ${FORMAT_NAMES[next.quay.format]}; skies ${full.sky} × ${full.sky / 2}, ${sky ? FORMAT_NAMES[sky.format] : "none"}; ${(bytes / 2 ** 20).toFixed(0)} MB`;
    return true;
  } catch (err) {
    console.warn("Full-size textures not used; staying on the WebP set.", err);
    for (const t of made) t.dispose();
    set.status += " (KTX2 failed)";
    return false;
  } finally {
    loader.dispose();
  }
}

/** Anisotropic filtering for the surfaces seen at grazing angles (walls, quays, water). */
export function setAnisotropy(set: TextureSet, renderer: WebGLRenderer, max = 8): void {
  const a = Math.max(1, Math.min(max, renderer.capabilities.getMaxAnisotropy()));
  for (const t of [set.surfacesDay, set.surfacesLit, set.heroDay, set.heroLit, set.ground, set.quay, set.waterNormal]) {
    if (t.anisotropy === a) continue;
    t.anisotropy = a;
    t.needsUpdate = true;
  }
}
