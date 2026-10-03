// Fetches the world files from data/ in parallel, reporting progress by bytes, parses the
// glTF files (the city, the water, and a hero per landmark that has a model; meshopt-
// compressed, so the decoder comes along) and decodes the textures.

import { DataArrayTexture, LinearFilter, LinearMipmapLinearFilter } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { loadTextures, type TexturesJson } from "./textures";
import { loadGround } from "./world/ground";
import type { TrafficJson } from "./world/traffic";
import type { LandmarksJson } from "./world/landmarks";
import type { WorldFiles, WorldModels } from "./world/world";

const FILES = {
  river: "river.json",
  bridges: "bridges.json",
  landmarks: "landmarks.json",
  trees: "trees.json",
  terrain: "terrain.bin",
  floor: "floor.bin",
  city: "city.glb",
  water: "water.glb",
  life: "life.json",
  roofBits: "roofbits.bin",
  groundMask: "ground/mask.bin",
  groundAo: "ground/ao.bin",
  marks: "ground/marks.glb",
  treeModels: "trees/trees.glb",
  traffic: "ground/traffic.json",
  parked: "ground/parked.bin",
  leaves: "trees/leaves.webp",
} as const;

/** Rough sizes so progress moves sensibly before every Content-Length is known. */
const GUESS: Record<string, number> = { "city.glb": 3e7, "roofbits.bin": 2.7e6, "ground/mask.bin": 1.3e7, "ground/ao.bin": 2.6e6, "ground/marks.glb": 1.3e6, "trees/trees.glb": 9e5, "ground/traffic.json": 2.5e5, "ground/parked.bin": 8.5e5, "trees/leaves.webp": 6e5, "floor.bin": 4.8e5, "trees.json": 4.5e5, "terrain.bin": 2.7e5 };

export async function loadWorld(onProgress: (fraction: number) => void): Promise<{ files: WorldFiles; models: WorldModels }> {
  const total: Record<string, number> = {};
  const done: Record<string, number> = {};
  const all: string[] = Object.values(FILES);
  const report = () => {
    let t = 0;
    let d = 0;
    for (const f of all) {
      t += total[f] ?? GUESS[f] ?? 1e4;
      d += done[f] ?? 0;
    }
    onProgress(Math.min(1, d / t));
  };
  const get = async (file: string): Promise<ArrayBuffer> => {
    const res = await fetch(`data/${file}`);
    if (!res.ok || !res.body) throw new Error(`Couldn't load data/${file} (${res.status}).`);
    const len = Number(res.headers.get("Content-Length"));
    if (len > 0 && !res.headers.get("Content-Encoding")) total[file] = len;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      chunks.push(value);
      n += value.byteLength;
      done[file] = n;
      report();
    }
    total[file] = n;
    const out = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out.buffer;
  };
  const json = async <T>(file: string): Promise<T> => JSON.parse(new TextDecoder().decode(await get(file))) as T;

  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const glb = async (file: string) => (await loader.parseAsync(await get(file), "data/")).scene;
  const textures = (async () => {
    const manifest = await json<TexturesJson>("tex/textures.json");
    for (const [f, n] of Object.entries(manifest.bytes)) {
      all.push(`tex/${f}`);
      GUESS[`tex/${f}`] = n;
    }
    return loadTextures(manifest, get);
  })();
  const landmarksP = json<LandmarksJson>(FILES.landmarks);
  const heroes = (async () => {
    const withModel = (await landmarksP).landmarks.filter((l) => l.model);
    for (const l of withModel) {
      all.push(l.model!);
      GUESS[l.model!] = 1.2e5;
    }
    const scenes = await Promise.all(withModel.map((l) => glb(l.model!)));
    return Object.fromEntries(withModel.map((l, i) => [l.id, scenes[i]]));
  })();
  const [river, bridges, landmarks, trees, terrain, floor, city, water, tex, heroModels, life, roofBits, groundMask, groundAo, marks, treeModels, leaves, traffic, parked] = await Promise.all([
    json<WorldFiles["river"]>(FILES.river),
    json<WorldFiles["bridges"]>(FILES.bridges),
    landmarksP,
    json<WorldFiles["trees"]>(FILES.trees),
    get(FILES.terrain),
    get(FILES.floor),
    glb(FILES.city),
    glb(FILES.water),
    textures,
    heroes,
    json<WorldFiles["life"]>(FILES.life),
    get(FILES.roofBits),
    get(FILES.groundMask),
    get(FILES.groundAo),
    glb(FILES.marks),
    glb(FILES.treeModels),
    get(FILES.leaves).then(leafTexture),
    json<TrafficJson>(FILES.traffic),
    get(FILES.parked),
  ]);
  return {
    files: { river, bridges, landmarks, trees, terrain, floor, life, roofBits },
    models: { city, water, textures: tex, heroes: heroModels, ground: loadGround(groundMask, groundAo), marks, trees: treeModels, leaves, traffic, parked },
  };
}

/** The leaf clusters: a strip of square layers (data, not colour: no colour conversion). */
async function leafTexture(bytes: ArrayBuffer): Promise<DataArrayTexture> {
  const img = await createImageBitmap(new Blob([bytes], { type: "image/webp" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  const tex = new DataArrayTexture(new Uint8Array(data.buffer), img.width, img.width, Math.round(img.height / img.width));
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
