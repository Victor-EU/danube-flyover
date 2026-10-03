// Packs the lossless masters in assets/raw/ (from gen-textures, or dropped in by hand) into
// what the app loads, public/data/tex/:
//   surfaces_day.webp  the facade, roof and plaster layers stacked into one tall strip, one
//                      512² layer per TEXTURES.facades, TEXTURES.roofs, then the plaster (it
//                      becomes an array texture)
//   ground.webp        the ground's surfaces (TEXTURES.ground), the same way
//   surfaces_lit.webp  the facades' emissive layers, same order
//   heroes_day.webp    the hero landmarks' layers (HERO_LAYERS), and heroes_lit.webp their
//                      window layers' emissive twins
//   quay.webp, water_normal.webp, sky_<name>.webp
//   full/<set>_<layer>.ktx2  every layer of the five strips above and the quay at its
//                      master's size (1024²), as KTX2 (ETC1S, mipmapped; tools/lib/ktx2.ts),
//                      which the app swaps in after the first frame
//   full/sky_<name>.ktx2  the skies at their masters' 4096 × 2048, as UASTC (ETC1S bands
//                      their gradients), without mipmaps like their WebP
//   textures.json      the manifest the loader reads
// The WebP files are the design's fallback sizes (512² surfaces, 2048 × 1024 skies): the first
// frame's set, and what stays when the GPU takes no compressed format. The water's normal map
// has no KTX2: its master is no bigger than its WebP.
// Usage: npm run pack-textures

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import sharp, { type Sharp } from "sharp";
import { HERO_LAYERS, TEXTURES } from "../src/config";
import { encodeKtx2, type Ktx2Options } from "./lib/ktx2";
import { HERO_ROUGHNESS } from "./textures/heroes";

const RAW = new URL("../assets/raw/", import.meta.url);
const OUT = new URL("../public/data/tex/", import.meta.url);
mkdirSync(new URL("full/", OUT), { recursive: true });

const LAYER = 512;
const raw = (name: string) => new URL(name, RAW).pathname;
const sizes: Record<string, number> = {};
const write = async (name: string, img: Sharp, quality: number) => {
  const buf = await img.webp({ quality, effort: 6, smartSubsample: true }).toBuffer();
  writeFileSync(new URL(name, OUT), buf);
  sizes[name] = buf.length;
};

async function strip(name: string, files: string[], quality: number): Promise<void> {
  const layers = await Promise.all(files.map((f) => sharp(raw(f)).resize(LAYER, LAYER, { kernel: "lanczos3" }).removeAlpha().png().toBuffer()));
  const img = sharp({ create: { width: LAYER, height: LAYER * files.length, channels: 3, background: "#000" } }).composite(
    layers.map((input, k) => ({ input, left: 0, top: k * LAYER })),
  );
  await write(name, sharp(await img.png().toBuffer()), quality);
}

const roofFile = (r: string) => `roof_${r.slice(4).toLowerCase()}.png`;
const sets = {
  surfacesDay: [...TEXTURES.facades.map((s) => `facade_${s}_day.png`), ...TEXTURES.roofs.map(roofFile), `${TEXTURES.plaster}.png`],
  surfacesLit: TEXTURES.facades.map((s) => `facade_${s}_lit.png`),
  heroesDay: HERO_LAYERS.map((l) => `hero_${l.name}_day.png`),
  heroesLit: HERO_LAYERS.filter((l) => l.lit).map((l) => `hero_${l.name}_lit.png`),
  ground: TEXTURES.ground.map((g) => `ground_${g}.png`),
};
await strip("surfaces_day.webp", sets.surfacesDay, 88);
await strip("surfaces_lit.webp", sets.surfacesLit, 90);
await strip("heroes_day.webp", sets.heroesDay, 88);
await strip("heroes_lit.webp", sets.heroesLit, 90);
await strip("ground.webp", sets.ground, 88);
await write("quay.webp", sharp(raw("quay_stone.png")).resize(LAYER, LAYER), 86);
await write("water_normal.webp", sharp(raw("water_normal.png")), 94);
for (const sky of TEXTURES.skies) await write(`sky_${sky}.webp`, sharp(raw(`sky_${sky}.png`)).resize(2048, 1024), 86);

// The full-size set, a file per layer (about 3 s each, a sky about 40 s).
const fullBytes: Record<string, number> = {};
const ktx2 = async (file: string, master: string, opts?: Ktx2Options) => {
  const buf = await encodeKtx2(raw(master), opts);
  writeFileSync(new URL(file, OUT), buf);
  fullBytes[file] = buf.length;
  return file;
};
const fullSet = async (prefix: string, files: string[]) => {
  const out: string[] = [];
  for (const f of files) out.push(await ktx2(`full/${prefix}_${f.replace(/\.png$/, "")}.ktx2`, f));
  return out;
};
const full = {
  layer: (await sharp(raw(sets.surfacesDay[0])).metadata()).width,
  surfaces: { day: await fullSet("surfaces", sets.surfacesDay), lit: await fullSet("surfaces", sets.surfacesLit) },
  heroes: { day: await fullSet("heroes", sets.heroesDay), lit: await fullSet("heroes", sets.heroesLit) },
  ground: await fullSet("ground", sets.ground),
  quay: await ktx2("full/quay.ktx2", "quay_stone.png"),
  sky: (await sharp(raw(`sky_${TEXTURES.skies[0]}.png`)).metadata()).width,
  skies: {} as Record<string, string>,
  bytes: fullBytes,
};
for (const sky of TEXTURES.skies) full.skies[sky] = await ktx2(`full/sky_${sky}.ktx2`, `sky_${sky}.png`, { uastc: true, mipmaps: false });

const manifest = {
  note: "Packed by tools/pack-textures.ts from assets/raw/ (tools/gen-textures.ts). Layer order follows TEXTURES in src/config.ts.",
  layer: LAYER,
  surfaces: { day: "surfaces_day.webp", lit: "surfaces_lit.webp", layers: [...TEXTURES.facades, ...TEXTURES.roofs, TEXTURES.plaster], litLayers: TEXTURES.facades },
  ground: { day: "ground.webp", layers: TEXTURES.ground },
  heroes: {
    day: "heroes_day.webp",
    lit: "heroes_lit.webp",
    layers: HERO_LAYERS.map((l) => l.name),
    litLayers: HERO_LAYERS.filter((l) => l.lit).map((l) => l.name),
    roughness: HERO_LAYERS.map((l) => HERO_ROUGHNESS[l.name]),
    grid: HERO_LAYERS.map((l) => [l.bays, l.rows]),
  },
  quay: "quay.webp",
  waterNormal: "water_normal.webp",
  skies: Object.fromEntries(TEXTURES.skies.map((s) => [s, `sky_${s}.webp`])),
  bytes: sizes,
  full,
};
writeFileSync(new URL("textures.json", OUT), `${JSON.stringify(manifest, null, 2)}\n`);
const total = Object.values(sizes).reduce((a, b) => a + b, 0);
for (const [k, v] of Object.entries(sizes)) console.log(`  ${k.padEnd(22)} ${(v / 1024).toFixed(0).padStart(5)} KB`);
console.log(`public/data/tex: ${(total / 1024).toFixed(0)} KB in ${Object.keys(sizes).length} files (+ textures.json ${statSync(new URL("textures.json", OUT)).size} B)`);
const fullTotal = Object.values(fullBytes).reduce((a, b) => a + b, 0);
console.log(`public/data/tex/full: ${(fullTotal / 1024).toFixed(0)} KB in ${Object.keys(fullBytes).length} KTX2 files, the layers at ${full.layer}², the skies ${full.sky} wide`);
