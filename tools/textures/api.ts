// gen-textures --api: the image-API texture set, in place of the procedural one: photographs
// of the real materials (common.txt), with no style sheet attached since the realism pass
// (the storybook set before it attached one):
//   facade_<style>_day / _lit     4 bays × 4 storeys, the lit one from the day one
//   roof_<kind>, quay_stone, plaster  tileable detail, near-white (tinted at runtime)
//   hero_<layer>_day / _lit       the landmarks' layers, at their tiles' aspect
//   ground_<surface>              the streets' and parks' surfaces, in their own colour
// The model doesn't keep to a grid it's only told about, so the facades, the quay and the hero
// layers repaint their procedural texture as a layout guide, which is drawn to the grid the
// shaders map (unguided, the storybook set's surfaces could even come back as a whole scene). Every day texture is tinted at runtime (the city's by building, the heroes' by
// face), so each is then brought to its procedural twin's level, channel by channel: the
// tint gives the colour, at the level the lighting was tuned for.
// The API can't make an image tile, so each day texture then has its seams fixed: shifted by
// half a tile, so the seams meet in the middle, and only a band over them is repainted (a
// masked edit), keeping the rest. A shift is always by whole bays or storeys, so the windows
// stay on their grid; facades only shift sideways, since their ground floor stays at the
// bottom. Each is fitted to 1024² for assets/raw/ (pack-textures takes it from there), with a
// 2 × 2 tiled copy in assets/raw/check/ and its seam error printed. The lit textures are made
// from the fixed day ones and keep only what the night adds (night − day), so their walls stay
// black. The water normal map and the panoramas stay procedural: run gen-textures without
// --api first.

import { mkdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { HERO_LAYERS, TEXTURES } from "../../src/config";
import { type ImageClient, type ImageSize, prompt, sizeFor, texturePreamble } from "../lib/imageApi";
import { facadeSvg } from "./facades";
import { heroSvg } from "./heroes";
import { quaySvg, roofSvg } from "./surfaces";
import { rasterise } from "./svg";

export async function generateWithApi(api: ImageClient, rawDir: URL, want: (name: string) => boolean, parallel = 1): Promise<string[]> {
  /** Each texture's requests run in order; textures run `parallel` at a time. */
  const tasks: (() => Promise<void>)[] = [];
  const common = texturePreamble();
  const check = new URL("check/", rawDir);
  mkdirSync(check, { recursive: true });
  const written: string[] = [];

  const refs = (...more: (Buffer | null)[]) => more.filter((b): b is Buffer => !!b);
  /** A procedural texture as the layout guide to repaint, at the request's size. */
  const guided = async (svg: string, size: ImageSize) => {
    const [w, h] = size.split("x").map(Number);
    return [await sharp(await rasterise(svg)).resize(w, h, { fit: "fill" }).removeAlpha().png().toBuffer(), ...refs()];
  };
  const layoutPrompt = prompt("guide");

  /** Fit to 1024² (stretching a non-square tile), save, and write the seam check for the axes it tiles on. */
  const save = async (name: string, png: Buffer, tile: { x: boolean; y: boolean } | null = { x: true, y: true }) => {
    const img = await sharp(png).resize(1024, 1024, { fit: "fill" }).removeAlpha().png().toBuffer();
    writeFileSync(new URL(`${name}.png`, rawDir), img);
    written.push(name);
    if (!tile) return;
    const half = await sharp(img).resize(512, 512).toBuffer();
    const grid = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#000" } })
      .composite([0, 1, 2, 3].map((k) => ({ input: half, left: (k % 2) * 512, top: Math.floor(k / 2) * 512 })))
      .png()
      .toBuffer();
    writeFileSync(new URL(`${name}.png`, check), grid);
    const e = await seamError(img, tile.x, tile.y);
    console.log(`    seam error ${e.seam.toFixed(1)}, neighbouring pixels ${e.typical.toFixed(1)} (0–255; a seam well above its neighbours shows)`);
  };
  /**
   * The night version minus the day one: what the lamps add. Below EMISSIVE_FLOOR it's the wall
   * the night pass repainted a shade off, not lamplight, so it goes to black.
   */
  const emissive = async (day: Buffer, night: Buffer) => {
    const d = await sharp(day).resize(1024, 1024, { fit: "fill" }).removeAlpha().raw().toBuffer();
    const n = await sharp(night).resize(1024, 1024, { fit: "fill" }).removeAlpha().raw().toBuffer();
    const e = Buffer.alloc(d.length);
    for (let i = 0; i < d.length; i++) e[i] = Math.max(0, n[i] - d[i] * 0.85 - EMISSIVE_FLOOR);
    return sharp(e, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
  };

  for (const style of TEXTURES.facades) tasks.push(async () => {
    const dayName = `facade_${style}_day`;
    const litName = `facade_${style}_lit`;
    if (!want(dayName) && !want(litName)) return;
    const raw = await api.image({ name: dayName, prompt: `${common}\n\n${layoutPrompt}\n\n${prompt(`facade_${style}`)}`, size: "1024x1024", refs: await guided(facadeSvg(style, "day"), "1024x1024") });
    const day = await tileable(api, dayName, raw, "1024x1024", true, false);
    if (day && want(dayName)) await save(dayName, await neutral(day, facadeSvg(style, "day")), { x: true, y: false });
    if (!want(litName)) return;
    const night = await api.image({ name: litName, prompt: `${common}\n\n${prompt("facade_lit")}`, size: "1024x1024", refs: refs(day) });
    if (day && night) await save(litName, await emissive(day, night), null);
  });
  for (const roof of TEXTURES.roofs) tasks.push(async () => {
    const name = `roof_${roof.slice(4).toLowerCase()}`;
    if (!want(name)) return;
    const raw = UNGUIDED.has(name)
      ? await api.image({ name, prompt: `${common}\n\n${prompt(name)}`, size: "1024x1024", refs: refs() })
      : await api.image({ name, prompt: `${common}\n\n${prompt("guide_surface")}\n\n${prompt(name)}`, size: "1024x1024", refs: await guided(roofSvg(roof), "1024x1024") });
    const img = await tileable(api, name, raw, "1024x1024", true, true);
    if (img) await save(name, await neutral(img, roofSvg(roof)));
  });
  if (want("quay_stone")) tasks.push(async () => {
    const raw = await api.image({ name: "quay_stone", prompt: `${common}\n\n${prompt("guide_surface")}\n\n${prompt("quay_stone")}`, size: "1024x1024", refs: await guided(quaySvg(), "1024x1024") });
    const img = await tileable(api, "quay_stone", raw, "1024x1024", true, true);
    if (img) await save("quay_stone", await neutral(img, quaySvg()));
  });
  if (want("plaster")) tasks.push(async () => {
    const raw = await api.image({ name: "plaster", prompt: `${common}\n\n${prompt("plaster")}`, size: "1024x1024" });
    const img = await tileable(api, "plaster", raw, "1024x1024", true, true);
    if (img) await save("plaster", await levelTo(img, [236, 233, 226]));
  });
  for (const g of TEXTURES.ground) tasks.push(async () => {
    const name = `ground_${g}`;
    if (!want(name)) return;
    const raw = await api.image({ name, prompt: `${common}\n\n${prompt(name)}`, size: "1024x1024" });
    const img = await tileable(api, name, raw, "1024x1024", true, true);
    if (img) await save(name, await levelLuma(img, GROUND_LUMA[g]));
  });
  for (const l of HERO_LAYERS) tasks.push(async () => {
    const dayName = `hero_${l.name}_day`;
    const litName = `hero_${l.name}_lit`;
    if (!want(dayName) && !(l.lit && want(litName))) return;
    const [w, h] = l.tile;
    const layout = l.lit
      ? prompt("hero_window", { bays: l.bays, rows: l.rows, width: w, height: h })
      : prompt("hero_material", { width: w });
    // Unguided, a material layer can come back as a scene (the storybook set's tiles did).
    const guide = l.lit ? layoutPrompt : prompt("guide_surface");
    const raw = await api.image({ name: dayName, prompt: `${common}\n\n${guide}\n\n${layout}\n\n${prompt(`hero_${l.name}`)}`, size: sizeFor(w, h), refs: await guided(heroSvg(l.name, "day"), sizeFor(w, h)) });
    // Window layers shift by whole bays and storeys only (half of an even count).
    const axes = { x: !l.lit || l.bays % 2 === 0, y: !l.lit || l.rows % 2 === 0 };
    const day = await tileable(api, dayName, raw, sizeFor(w, h), axes.x, axes.y);
    if (day && want(dayName)) await save(dayName, await neutral(day, heroSvg(l.name, "day")), axes.x || axes.y ? axes : null);
    if (!l.lit || !want(litName)) return;
    const night = await api.image({ name: litName, prompt: `${common}\n\n${prompt("hero_lit", { glow: prompt(`hero_${l.name}_lit`) })}`, size: sizeFor(w, h), refs: refs(day) });
    if (day && night) await save(litName, await emissive(day, night), null);
  });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, parallel) }, async () => {
      while (next < tasks.length) await tasks[next++]();
    }),
  );
  return written;
}

/**
 * Scales each channel so the brighter half of the image (the plaster, the stone, the tiles)
 * averages what the procedural texture's does: near-white for most, so the colour is taken out
 * and the runtime tint puts it back; the few full-colour layers (Zsolnay tiles, the Market
 * Hall's brick) keep their procedural balance.
 */
async function neutral(png: Buffer, procedural: string): Promise<Buffer> {
  const level = async (img: Buffer) => {
    const d = await sharp(img).resize(256, 256, { fit: "fill" }).removeAlpha().raw().toBuffer();
    const px: number[][] = [];
    for (let i = 0; i < d.length; i += 3) px.push([d[i], d[i + 1], d[i + 2]]);
    px.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
    const top = px.slice(px.length >> 1);
    return [0, 1, 2].map((c) => top.reduce((s, p) => s + p[c], 0) / top.length);
  };
  const [want, have] = await Promise.all([level(await rasterise(procedural)), level(png)]);
  return sharp(png).removeAlpha().linear(want.map((v, c) => v / Math.max(1, have[c])), [0, 0, 0]).png().toBuffer();
}

/** Mean sRGB luminance each ground surface is brought to (0–255): asphalt dark, paving and gravel pale. */
const GROUND_LUMA: Record<string, number> = { asphalt: 84, paving: 142, sett: 118, grass: 96, gravel: 140 };

/** Scales the image so its mean luminance is `want` (0–255), keeping its colour. */
async function levelLuma(png: Buffer, want: number): Promise<Buffer> {
  const d = await sharp(png).resize(256, 256, { fit: "fill" }).removeAlpha().raw().toBuffer();
  let sum = 0;
  for (let i = 0; i < d.length; i += 3) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const k = want / Math.max(1, sum / (d.length / 3));
  return sharp(png).removeAlpha().linear([k, k, k], [0, 0, 0]).png().toBuffer();
}

/** Scales each channel so the brighter half of the image averages `want` (0–255): a neutral layer to tint. */
async function levelTo(png: Buffer, want: number[]): Promise<Buffer> {
  const d = await sharp(png).resize(256, 256, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const px: number[][] = [];
  for (let i = 0; i < d.length; i += 3) px.push([d[i], d[i + 1], d[i + 2]]);
  px.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  const top = px.slice(px.length >> 1);
  const have = [0, 1, 2].map((c) => top.reduce((s, p) => s + p[c], 0) / top.length);
  return sharp(png).removeAlpha().linear(want.map((v, c) => v / Math.max(1, have[c])), [0, 0, 0]).png().toBuffer();
}

/**
 * Roofs asked for without a guide. These two kept to their pattern unguided and tile without a
 * repaint (tile) or with a clean one (copper needs none); guided, their seam repaints went wrong:
 * the tiles' courses stepped and the copper's band grew a tower. Unguided, the slate and flat
 * roofs came back as a riverside scene and a building plan, so they keep their guides.
 */
const UNGUIDED = new Set(["roof_tile", "roof_copper"]);

/** 0–255: what's left of a wall in a lit texture (the secession facade's was about 8). */
const EMISSIVE_FLOOR = 8;

/**
 * How far a seam repaint may stray (see drift()): good ones reached 2.1× their band's contrast
 * (the arcade's) and a 23 shift in colour (the Market Hall's brick); the copper roof's tower was
 * 2.7×, the sheet metal's strip of city 8.7×.
 */
const DRIFT = { relative: 2.4, colour: 40 };

/** Fraction of the image's width (or height) repainted over a seam, and the feather at its edges. */
const SEAM = { band: 0.1, feather: 0.025 };

/**
 * Makes a texture tile along x and/or y: shifts it by half (wrapping), so the seams meet in the
 * middle, repaints a band over them with a masked edit, and blends the band back in. Only the
 * axes whose seam stands out are fixed. Dry (no image), it only lists the request.
 */
async function tileable(api: ImageClient, name: string, png: Buffer | null, size: ImageSize, sx: boolean, sy: boolean): Promise<Buffer | null> {
  const req = { name: `${name}_seam`, prompt: `${texturePreamble()}\n\n${prompt("seam")}`, size };
  if (!png) {
    await api.image(req);
    return null;
  }
  const [w, h] = size.split("x").map(Number);
  const srcPng = await sharp(png).resize(w, h, { fit: "fill" }).removeAlpha().png().toBuffer();
  // An axis the answer already tiles on (the guide does, and the model kept to it) is left
  // alone: repainting it only risks a band that doesn't line up.
  const stands = async (x: boolean, y: boolean) => {
    const e = await seamError(srcPng, x, y);
    return e.seam > 1.25 * e.typical + 2;
  };
  sx &&= await stands(true, false);
  sy &&= await stands(false, true);
  if (!sx && !sy) return png;
  const src = await sharp(srcPng).raw().toBuffer();
  const shifted = Buffer.alloc(src.length);
  const dx = sx ? w / 2 : 0;
  const dy = sy ? h / 2 : 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) src.copy(shifted, (y * w + x) * 3, (((y + dy) % h) * w + ((x + dx) % w)) * 3, (((y + dy) % h) * w + ((x + dx) % w)) * 3 + 3);
  // How much of the repaint each pixel takes: 1 in the band, feathered to 0 at its edges.
  const weight = (x: number, y: number) => {
    const t = (d: number, n: number) => Math.max(0, Math.min(1, ((SEAM.band / 2) * n - Math.abs(d - n / 2)) / (SEAM.feather * n)));
    return Math.max(sx ? t(x, w) : 0, sy ? t(y, h) : 0);
  };
  const mask = Buffer.alloc(w * h * 4, 255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (weight(x, y) > 0) mask[(y * w + x) * 4 + 3] = 0;
  const shiftedPng = await sharp(shifted, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  const maskPng = await sharp(mask, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  // A repaint can stray from the surface (one painted a strip of the city into sheet metal):
  // checked against what it replaces, it's asked once more with a plainer prompt if it did.
  const band: number[] = [];
  for (let i = 0; i < w * h; i++) if (weight(i % w, Math.floor(i / w)) > 0.5) band.push(i);
  let fix: Buffer | null = null;
  let best = Infinity;
  let answered = 0;
  for (const attempt of [req, { name: `${name}_seam2`, prompt: `${prompt("seam")}\n\n${prompt("seam_retry")}`, size }]) {
    const answer = await api.image({ ...attempt, refs: [shiftedPng], mask: maskPng });
    if (!answer) break;
    answered++;
    const img = await sharp(answer).resize(w, h, { fit: "fill" }).removeAlpha().raw().toBuffer();
    const d = drift(img, shifted, band);
    const score = Math.max(d.relative / DRIFT.relative, d.colour / DRIFT.colour);
    if (score < best) [fix, best] = [img, score];
    console.log(`    ${attempt.name}: ${d.relative.toFixed(2)}× its band's contrast, colour ${d.colour.toFixed(1)} off${score > 1 ? ": strayed from the surface" : ""}`);
    if (score <= 1) break;
  }
  if (!fix) return shiftedPng;
  if (best > 1 && answered > 1) console.log(`    WARNING: ${name}: both seam repaints strayed; keeping the closer one, check assets/raw/check/`);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = weight(x, y);
      if (k > 0) for (let c = 0; c < 3; c++) shifted[(y * w + x) * 3 + c] = Math.round(shifted[(y * w + x) * 3 + c] * (1 - k) + fix[(y * w + x) * 3 + c] * k);
    }
  return sharp(shifted, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

/**
 * How far a repaint strays from the pixels it replaces, over the band: the mean difference as a
 * multiple of the band's own contrast (a busy pattern differs more when it's merely re-laid),
 * and the largest shift in a channel's mean (a new colour that wasn't there).
 */
function drift(fix: Buffer, was: Buffer, band: number[]): { relative: number; colour: number } {
  const mf = [0, 0, 0];
  const mw = [0, 0, 0];
  let diff = 0;
  for (const i of band)
    for (let c = 0; c < 3; c++) {
      diff += Math.abs(fix[i * 3 + c] - was[i * 3 + c]);
      mf[c] += fix[i * 3 + c];
      mw[c] += was[i * 3 + c];
    }
  const n = band.length;
  let contrast = 0;
  for (const i of band) for (let c = 0; c < 3; c++) contrast += Math.abs(was[i * 3 + c] - mw[c] / n);
  return { relative: diff / Math.max(1, contrast), colour: Math.max(...[0, 1, 2].map((c) => Math.abs(mf[c] - mw[c]) / n)) };
}

/**
 * Mean difference between opposite edges (left/right columns, top/bottom rows, as asked), and
 * between neighbouring columns and rows across the image for comparison, 0–255: a hard edge in
 * the pattern can land on the border, so a seam only stands out if it's well above the second.
 */
async function seamError(png: Buffer, sx: boolean, sy: boolean): Promise<{ seam: number; typical: number }> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const px = (x: number, y: number, c: number) => data[(y * w + x) * 3 + c];
  let seam = 0;
  let typical = 0;
  for (let c = 0; c < 3; c++) {
    if (sx)
      for (let y = 0; y < h; y++) {
        seam += Math.abs(px(0, y, c) - px(w - 1, y, c));
        for (let x = 1; x < w; x++) typical += Math.abs(px(x, y, c) - px(x - 1, y, c)) / (w - 1);
      }
    if (sy)
      for (let x = 0; x < w; x++) {
        seam += Math.abs(px(x, 0, c) - px(x, h - 1, c));
        for (let y = 1; y < h; y++) typical += Math.abs(px(x, y, c) - px(x, y - 1, c)) / (h - 1);
      }
  }
  const n = 3 * ((sx ? h : 0) + (sy ? w : 0));
  return { seam: seam / n, typical: typical / n };
}
