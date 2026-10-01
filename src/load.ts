// Fetches the world files from data/ in parallel, reporting progress by bytes, and parses the
// two glTF files (meshopt-compressed, so the decoder comes along).

import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
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
} as const;

/** Rough sizes so progress moves sensibly before every Content-Length is known. */
const GUESS: Record<string, number> = { "city.glb": 6.2e6, "floor.bin": 4.7e5, "trees.json": 3.5e5, "terrain.bin": 2.7e5 };

export async function loadWorld(onProgress: (fraction: number) => void): Promise<{ files: WorldFiles; models: WorldModels }> {
  const total: Record<string, number> = {};
  const done: Record<string, number> = {};
  const report = () => {
    let t = 0;
    let d = 0;
    for (const f of Object.values(FILES)) {
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
  const [river, bridges, landmarks, trees, terrain, floor, city, water] = await Promise.all([
    json<WorldFiles["river"]>(FILES.river),
    json<WorldFiles["bridges"]>(FILES.bridges),
    json<WorldFiles["landmarks"]>(FILES.landmarks),
    json<WorldFiles["trees"]>(FILES.trees),
    get(FILES.terrain),
    get(FILES.floor),
    glb(FILES.city),
    glb(FILES.water),
  ]);
  return { files: { river, bridges, landmarks, trees, terrain, floor }, models: { city, water } };
}
