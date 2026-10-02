// The design's image-API path for gen-textures (--api): a style sheet generated once and
// locked, then every surface texture generated with the style sheet attached as a reference.
// Prompts live in tools/prompts/ (common.txt is prepended to each). Each texture also gets a
// 2 × 2 tiled copy in assets/raw/check/ for the seam check before it's accepted. The lit
// facades are generated from the day facade, then reduced to their emissive part.
// Needs OPENAI_API_KEY (and optionally OPENAI_IMAGE_MODEL). Untested here: no key was
// available when this was written (see docs/decisions.md, M3).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
import { TEXTURES } from "../../src/config";

const API = "https://api.openai.com/v1/images";

export async function generateWithApi(rawDir: URL, want: (name: string) => boolean): Promise<void> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("gen-textures --api needs OPENAI_API_KEY in the environment.");
  const model = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1";
  const prompt = (name: string) => readFileSync(new URL(`../prompts/${name}.txt`, import.meta.url), "utf8").trim();
  const common = prompt("common");
  const check = new URL("check/", rawDir);
  mkdirSync(check, { recursive: true });

  const call = async (endpoint: "generations" | "edits", body: FormData | object): Promise<Buffer> => {
    const res = await fetch(`${API}/${endpoint}`, {
      method: "POST",
      headers: body instanceof FormData ? { Authorization: `Bearer ${key}` } : { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`image API ${endpoint}: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { b64_json: string }[] };
    return Buffer.from(json.data[0].b64_json, "base64");
  };
  const edit = async (text: string, refs: Buffer[], size = "1024x1024") => {
    const form = new FormData();
    form.set("model", model);
    form.set("prompt", `${common}\n\n${text}`);
    form.set("size", size);
    form.set("quality", "high");
    refs.forEach((r, i) => form.append("image[]", new Blob([new Uint8Array(r)], { type: "image/png" }), `ref${i}.png`));
    return call("edits", form);
  };

  // The style sheet is generated once and then locked: delete the file to regenerate it.
  const sheetFile = new URL("style_sheet.png", rawDir);
  if (!existsSync(sheetFile)) {
    console.log("generating the style sheet");
    writeFileSync(sheetFile, await call("generations", { model, prompt: `${common}\n\n${prompt("style-sheet")}`, size: "1536x1024", quality: "high" }));
  }
  const sheet = readFileSync(sheetFile);

  const save = async (name: string, png: Buffer, tile = true) => {
    const img = await sharp(png).resize(1024, 1024).removeAlpha().png().toBuffer();
    writeFileSync(new URL(name, rawDir), img);
    if (tile) {
      const half = await sharp(img).resize(512, 512).toBuffer();
      const grid = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#000" } })
        .composite([0, 1, 2, 3].map((k) => ({ input: half, left: (k % 2) * 512, top: Math.floor(k / 2) * 512 })))
        .png()
        .toBuffer();
      writeFileSync(new URL(name, check), grid);
    }
    console.log(`  ${name}`);
  };

  for (const style of TEXTURES.facades) {
    const day = `facade_${style}_day.png`;
    if (want(day)) await save(day, await edit(prompt(`facade_${style}`), [sheet]));
    const lit = `facade_${style}_lit.png`;
    if (!want(lit)) continue;
    const dayPng = readFileSync(new URL(day, rawDir));
    const litPng = await sharp(await edit(prompt("facade_lit"), [sheet, dayPng])).resize(1024, 1024).removeAlpha().raw().toBuffer();
    // Keep only what the night version adds: lit = max(0, night - day), so walls stay black.
    const d = await sharp(dayPng).removeAlpha().raw().toBuffer();
    const e = Buffer.alloc(d.length);
    for (let i = 0; i < d.length; i++) e[i] = Math.max(0, litPng[i] - d[i] * 0.85);
    await save(lit, await sharp(e, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer(), false);
  }
  for (const roof of TEXTURES.roofs) {
    const name = `roof_${roof.slice(4).toLowerCase()}.png`;
    if (want(name)) await save(name, await edit(prompt(`roof_${roof.slice(4).toLowerCase()}`), [sheet]));
  }
  if (want("quay_stone.png")) await save("quay_stone.png", await edit(prompt("quay_stone"), [sheet]));
  // The water normal map and the panoramas stay procedural: run gen-textures without --api
  // first (the panoramas need hand cleanup of the seam and poles if they're generated).
}
