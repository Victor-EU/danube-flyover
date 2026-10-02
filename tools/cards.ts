// Finishes the landmark cards' illustrations. The app renders each landmark from a set
// viewpoint and hour (src/record.ts, ?record=cards, in the dev server) into
// tools/out/captures/card_<id>.png; this gives each a painted finish (a slight median, warmer
// colour, a vignette and paper grain) and writes public/data/cards/<id>.webp. They are our
// own renders of our own models, so they carry no third-party image (see docs/decisions.md).
// Usage: npm run cards

import { mkdirSync, readdirSync, statSync } from "node:fs";
import sharp from "sharp";

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

const files = readdirSync(IN).filter((f) => /^card_\w+\.png$/.test(f));
if (!files.length) throw new Error("no card stills in tools/out/captures/ (open the dev server with ?record=cards first)");
let total = 0;
for (const f of files) {
  const id = f.slice(5, -4);
  const base = await sharp(new URL(f, IN).pathname).resize(W, H, { kernel: "lanczos3" }).median(3).modulate({ saturation: 1.1, brightness: 1.02 }).toBuffer();
  const out = new URL(`${id}.webp`, OUT).pathname;
  await sharp(base)
    .composite([
      { input: vignette, blend: "multiply" },
      { input: grain, blend: "overlay" },
    ])
    .webp({ quality: 78, effort: 6 })
    .toFile(out);
  total += statSync(out).size;
}
console.log(`public/data/cards: ${files.length} illustrations, ${(total / 1024).toFixed(0)} KB`);
