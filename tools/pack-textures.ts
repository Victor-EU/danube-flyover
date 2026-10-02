// Packs the lossless masters in assets/raw/ (from gen-textures, or dropped in by hand) into
// what the app loads, public/data/tex/:
//   surfaces_day.webp  the facade and roof layers stacked into one tall strip, one 512² layer
//                      per TEXTURES.facades then TEXTURES.roofs (it becomes an array texture)
//   surfaces_lit.webp  the facades' emissive layers, same order
//   heroes_day.webp    the hero landmarks' layers (HERO_LAYERS), and heroes_lit.webp their
//                      window layers' emissive twins
//   quay.webp, water_normal.webp, sky_<name>.webp
//   textures.json      the manifest the loader reads
// These are the design's WebP fallback sizes (512² surfaces, 2048 × 1024 skies). KTX2/Basis
// compression of the full-size set is still to come (see docs/decisions.md, M3).
// Usage: npm run pack-textures

import { mkdirSync, statSync, writeFileSync } from "node:fs";
import sharp, { type Sharp } from "sharp";
import { HERO_LAYERS, TEXTURES } from "../src/config";
import { HERO_ROUGHNESS } from "./textures/heroes";

const RAW = new URL("../assets/raw/", import.meta.url);
const OUT = new URL("../public/data/tex/", import.meta.url);
mkdirSync(OUT, { recursive: true });

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
await strip("surfaces_day.webp", [...TEXTURES.facades.map((s) => `facade_${s}_day.png`), ...TEXTURES.roofs.map(roofFile)], 88);
await strip("surfaces_lit.webp", TEXTURES.facades.map((s) => `facade_${s}_lit.png`), 90);
await strip("heroes_day.webp", HERO_LAYERS.map((l) => `hero_${l.name}_day.png`), 88);
await strip("heroes_lit.webp", HERO_LAYERS.filter((l) => l.lit).map((l) => `hero_${l.name}_lit.png`), 90);
await write("quay.webp", sharp(raw("quay_stone.png")).resize(LAYER, LAYER), 86);
await write("water_normal.webp", sharp(raw("water_normal.png")), 94);
for (const sky of TEXTURES.skies) await write(`sky_${sky}.webp`, sharp(raw(`sky_${sky}.png`)).resize(2048, 1024), 86);

const manifest = {
  note: "Packed by tools/pack-textures.ts from assets/raw/ (tools/gen-textures.ts). Layer order follows TEXTURES in src/config.ts.",
  layer: LAYER,
  surfaces: { day: "surfaces_day.webp", lit: "surfaces_lit.webp", layers: [...TEXTURES.facades, ...TEXTURES.roofs], litLayers: TEXTURES.facades },
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
};
writeFileSync(new URL("textures.json", OUT), `${JSON.stringify(manifest, null, 2)}\n`);
const total = Object.values(sizes).reduce((a, b) => a + b, 0);
for (const [k, v] of Object.entries(sizes)) console.log(`  ${k.padEnd(22)} ${(v / 1024).toFixed(0).padStart(5)} KB`);
console.log(`public/data/tex: ${(total / 1024).toFixed(0)} KB in ${Object.keys(sizes).length} files (+ textures.json ${statSync(new URL("textures.json", OUT)).size} B)`);
