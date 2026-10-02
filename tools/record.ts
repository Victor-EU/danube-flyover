// Assembles the frames the app recorded (src/record.ts, through the dev server) into an
// animated WebP: tools/out/captures/<mode>_NNNN.jpg → tools/out/<mode>.webp.
// Usage: open the dev server with ?record=timelapse (or ?record=beat6), wait for it to
// finish, then: npm run record -- timelapse

import { readdirSync, statSync } from "node:fs";
import sharp from "sharp";

const mode = process.argv[2] ?? "timelapse";
const FPS = 10;
const dir = new URL("./out/captures/", import.meta.url);
const frames = readdirSync(dir)
  .filter((f) => f.startsWith(`${mode}_`) && f.endsWith(".jpg"))
  .sort()
  .map((f) => new URL(f, dir).pathname);
if (!frames.length) throw new Error(`no frames for ${mode} in tools/out/captures/ (open the app with ?record=${mode} first)`);
const out = new URL(`./out/${mode}.webp`, import.meta.url).pathname;
await sharp(frames, { join: { animated: true } })
  .webp({ quality: 62, effort: 4, delay: Array(frames.length).fill(1000 / FPS), loop: 0 })
  .toFile(out);
console.log(`tools/out/${mode}.webp: ${frames.length} frames at ${FPS} fps, ${(statSync(out).size / 1e6).toFixed(1)} MB`);
