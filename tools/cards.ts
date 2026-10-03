// Finishes the landmark cards' illustrations. The app renders each landmark from a set
// viewpoint and hour (src/record.ts, ?record=cards, in the dev server) into
// tools/out/captures/card_<id>.png, and this writes public/data/cards/<id>.webp from it:
// - by default, a painted finish on the render itself (a slight median, warmer colour, a
//   vignette and paper grain): our own renders of our own models;
// - with --api (the committed set): the image API turns the render into a photograph of the
//   real place (card_photo.txt; tools/lib/imageApi.ts; --dry lists the requests first). The
//   render fixes the composition, so the picture shows what the flyover shows. (Before the
//   realism pass the API repainted it as an illustration in the style sheet's style.)
// Usage: npm run cards [-- --api [--dry] [--force]] [-- --only <id>]

import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import sharp from "sharp";
import { CARD_VIEWS } from "../src/cardViews";
import { sunPosition } from "../src/sun";
import type { LandmarksJson } from "../src/world/landmarks";
import { imageClient, prompt } from "./lib/imageApi";

const IN = new URL("./out/captures/", import.meta.url);
const OUT = new URL("../public/data/cards/", import.meta.url);
mkdirSync(OUT, { recursive: true });
const [W, H] = [720, 450];
const vignette = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><radialGradient id="v" cx="0.5" cy="0.48" r="0.75"><stop offset="0.55" stop-color="#fff"/><stop offset="1" stop-color="#b9ad98"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#v)"/></svg>`,
);
const grain = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><filter id="g"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="5"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope="0.05"/></feComponentTransfer></filter><rect width="100%" height="100%" filter="url(#g)"/></svg>`,
);

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const files = readdirSync(IN).filter((f) => /^card_\w+\.png$/.test(f) && (!only || f === `card_${only}.png`));
if (!files.length) throw new Error("no card stills in tools/out/captures/ (open the dev server with ?record=cards first)");
const useApi = process.argv.includes("--api");
const api = useApi ? imageClient() : null;
const landmarks = (JSON.parse(readFileSync(new URL("../public/data/landmarks.json", import.meta.url), "utf8")) as LandmarksJson).landmarks;
let total = 0;
/** API requests run this many at a time (--parallel n). */
const parallel = process.argv.includes("--parallel") ? Number(process.argv[process.argv.indexOf("--parallel") + 1]) : 1;
const viaApi = async (f: string) => {
  const id = f.slice(5, -4);
  const out = new URL(`${id}.webp`, OUT).pathname;
  const l = landmarks.find((x) => x.id === id);
  if (!l) throw new Error(`card_${id}.png: no landmark ${id}`);
  const render = await sharp(new URL(f, IN).pathname).png().toBuffer();
  const when = hour(CARD_VIEWS[id]?.[3] ?? 18);
  const ask = prompt("card_photo", { name: l.name, when, text: l.text ?? l.note });
  const painted = await api!.image({ name: `card_${id}`, prompt: ask, size: "1536x1024", refs: [render] });
  if (!painted) return;
  // 3:2 from the API to the card's 16:10: trim the top and bottom.
  await sharp(painted).resize(W, H, { fit: "cover", kernel: "lanczos3" }).webp({ quality: 80, effort: 6 }).toFile(out);
  total += statSync(out).size;
};
if (api) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, parallel) }, async () => {
    while (next < files.length) await viaApi(files[next++]);
  }));
}
for (const f of api ? [] : files) {
  const id = f.slice(5, -4);
  const out = new URL(`${id}.webp`, OUT).pathname;
  const base = await sharp(new URL(f, IN).pathname).resize(W, H, { kernel: "lanczos3" }).median(3).modulate({ saturation: 1.1, brightness: 1.02 }).toBuffer();
  await sharp(base)
    .composite([
      { input: vignette, blend: "multiply" },
      { input: grain, blend: "overlay" },
    ])
    .webp({ quality: 78, effort: 6 })
    .toFile(out);
  total += statSync(out).size;
}
api?.summary();
console.log(`public/data/cards: ${files.length} illustrations, ${(total / 1024).toFixed(0)} KB`);

/** The light at the card's hour, in words, from the sun's elevation on 1 October. */
function hour(h: number): string {
  const e = sunPosition(h).elevation;
  if (e > 20) return h < 12 ? "on a clear autumn morning" : "on a clear autumn afternoon";
  if (e > 6) return "in the low, warm light of a late autumn afternoon";
  if (e > 0) return "at golden hour, just before sunset";
  if (e > -6) return "at dusk, the sky still glowing, the first lights on";
  return "at night, floodlit, the city lights reflected in the river";
}
