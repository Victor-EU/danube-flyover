// Step 7: the texture set. Paints every texture the runtime uses and writes lossless masters
// to assets/raw/; `npm run pack-textures` then makes the files the app loads.
//   facade_<style>_day.png / _lit.png   1024², 4 bays × 4 storeys (the lit one is emissive:
//                                       black except where light comes from)
//   roof_<kind>.png, quay_stone.png     1024² tileable detail, tinted at runtime
//   water_normal.png                    512² tileable normal map
//   sky_<dawn|day|golden|night>.png     2048 × 1024 equirectangular panoramas
// and docs/style-sheet.webp, the locked style reference (every texture on one sheet).
//
// The default is procedural: deterministic, offline, no licence questions. The design's image
// API path (prompts in tools/prompts/, the style sheet attached to every request) runs with
// --api when OPENAI_API_KEY is set; see tools/lib/imageApi.ts.
// Usage: npm run gen-textures [-- --api] [-- --only <name>]

import { mkdirSync, writeFileSync } from "node:fs";
import sharp, { type OverlayOptions } from "sharp";
import { TEXTURES } from "../src/config";
import { facadeSvg, FACADE_COLOURS } from "./textures/facades";
import { paintSky } from "./textures/sky";
import { quaySvg, roofSvg, waterNormals } from "./textures/surfaces";
import { rasterise } from "./textures/svg";
import { generateWithApi } from "./lib/imageApi";

const RAW = new URL("../assets/raw/", import.meta.url);
const DOCS = new URL("../docs/", import.meta.url);
mkdirSync(RAW, { recursive: true });

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const want = (name: string) => !only || name.startsWith(only);
const t0 = performance.now();
const written: string[] = [];
const save = async (name: string, png: Buffer) => {
  writeFileSync(new URL(name, RAW), png);
  written.push(name);
};

if (process.argv.includes("--api")) {
  await generateWithApi(RAW, want);
} else {
  for (const style of TEXTURES.facades)
    for (const mode of ["day", "lit"] as const) {
      const name = `facade_${style}_${mode}.png`;
      if (want(name)) await save(name, await rasterise(facadeSvg(style, mode)));
    }
  for (const roof of TEXTURES.roofs) {
    const name = `roof_${roof.slice(4).toLowerCase()}.png`;
    if (want(name)) await save(name, await rasterise(roofSvg(roof)));
  }
  if (want("quay_stone.png")) await save("quay_stone.png", await rasterise(quaySvg()));
  if (want("water_normal.png")) {
    const n = 512;
    await save("water_normal.png", await sharp(Buffer.from(waterNormals(n)), { raw: { width: n, height: n, channels: 3 } }).png().toBuffer());
  }
  for (const sky of TEXTURES.skies) {
    const name = `sky_${sky}.png`;
    if (!want(name)) continue;
    const [w, h] = [2048, 1024];
    await save(name, await sharp(Buffer.from(paintSky(sky, w, h)), { raw: { width: w, height: h, channels: 3 } }).png().toBuffer());
  }
}
console.log(`assets/raw: ${written.length} textures in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

if (!only) await styleSheet();

/**
 * The style sheet: a riverside street at golden hour and the same street at night, built from
 * the textures themselves, with the facade, roof and night palettes as swatches underneath.
 */
async function styleSheet(): Promise<void> {
  const W = 2048;
  const H = 1280;
  const raw = (name: string) => new URL(name, RAW).pathname;
  // One sample tint per style, from build-city's palettes.
  const tints = ["#d9c9a8", "#e0d4b8", "#c8a984", "#d1c4a6", "#e2d8c2", "#b8b5ae", "#c2bfb7", "#ddd3bf"];
  const roofTints = ["#9a5b45", "#5d5f63", "#6f9384", "#9c9a94"];
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const layers: OverlayOptions[] = [];
  /** A building front h px tall: the tile's ground floor, then its upper storeys repeated. */
  const stackFront = async (file: string, h: number, bg: string) => {
    const tile = await sharp(raw(file)).resize(256, 256).toBuffer();
    const upper = await sharp(tile).extract({ left: 0, top: 0, width: 256, height: 192 }).toBuffer();
    const ground = await sharp(tile).extract({ left: 0, top: 192, width: 256, height: 64 }).toBuffer();
    const n = Math.max(1, Math.ceil((h - 64) / 192));
    const full = 64 + n * 192;
    const parts: OverlayOptions[] = [{ input: ground, left: 0, top: full - 64 }];
    for (let k = 0; k < n; k++) parts.push({ input: upper, left: 0, top: full - 64 - (k + 1) * 192 });
    const img = await sharp({ create: { width: 256, height: full, channels: 3, background: bg } }).composite(parts).png().toBuffer();
    return sharp(img).extract({ left: 0, top: full - h, width: 256, height: h }).png().toBuffer();
  };
  const street = async (top: number, night: boolean) => {
    const sky = await sharp(raw(night ? "sky_night.png" : "sky_golden.png")).extract({ left: 1040, top: 300, width: 900, height: 222 }).resize(W, 460).toBuffer();
    layers.push({ input: sky, left: 0, top });
    const storeys = [5, 4, 6, 3, 3, 7, 6, 2];
    for (let k = 0; k < 8; k++) {
      const style = TEXTURES.facades[k];
      const h = Math.round((storeys[k] / 4) * 256);
      const front = await stackFront(`facade_${style}_day.png`, h, FACADE_COLOURS.wall);
      const t = rgb(tints[k]).map((v) => v * TEXTURES.tintGain);
      let img = await sharp(front).linear(t, [0, 0, 0]).png().toBuffer();
      if (night) {
        const lit = await stackFront(`facade_${style}_lit.png`, h, "#000");
        img = await sharp(await sharp(img).linear([0.1, 0.11, 0.16], [0, 0, 0]).png().toBuffer()).composite([{ input: lit, blend: "add" }]).toBuffer();
      }
      layers.push({ input: await sharp(img).png().toBuffer(), left: k * 256, top: top + 460 - h });
      const roof = await sharp(raw(`roof_${TEXTURES.roofs[k % 4].slice(4).toLowerCase()}.png`)).resize(256, 256).extract({ left: 0, top: 0, width: 256, height: 18 }).linear(rgb(roofTints[k % 4]).map((v) => v * TEXTURES.tintGain * (night ? 0.12 : 1)), [0, 0, 0]).png().toBuffer();
      layers.push({ input: roof, left: k * 256, top: top + 460 - h - 18 });
    }
    const quay = await sharp(raw("quay_stone.png")).resize(512, 512).extract({ left: 0, top: 0, width: 512, height: 40 }).linear([0.8 * (night ? 0.14 : 1), 0.75 * (night ? 0.14 : 1), 0.62 * (night ? 0.18 : 1)], [0, 0, 0]).png().toBuffer();
    for (let x = 0; x < W; x += 512) layers.push({ input: quay, left: x, top: top + 460 });
    layers.push({ input: { create: { width: W, height: 60, channels: 3, background: night ? "#0b1a22" : "#2f5f66" } }, left: 0, top: top + 500 });
  };
  await street(0, false);
  await street(560, true);
  // Swatches: the facade tints, the roof tints, water, and the night golds.
  const swatches = [...tints, ...roofTints, "#2f5f66", "#1b3f47", "#ffcf87", "#ffd9a0", "#ffc35a", "#f3eedf"];
  const sw = W / swatches.length;
  swatches.forEach((c, i) => layers.push({ input: { create: { width: Math.floor(sw) - 4, height: 150, channels: 3, background: c } }, left: Math.round(i * sw) + 2, top: H - 156 }));
  const sheet = await sharp({ create: { width: W, height: H, channels: 3, background: "#14161c" } }).composite(layers).webp({ quality: 82 }).toBuffer();
  writeFileSync(new URL("style-sheet.webp", DOCS), sheet);
  console.log(`docs/style-sheet.webp ${(sheet.length / 1024).toFixed(0)} KB`);
}
