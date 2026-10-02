// Roofs, quay stone and the water normal map. Roofs and stone are near-white detail like the
// facades (the mesh colour tints them); the normal map tiles over TEXTURES.waterTile metres.

import { TEXTURES } from "../../src/config";
import { mulberry32 } from "../lib/geom";
import { fbm } from "./noise";
import { f, plasterFilter, Svg, TILE } from "./svg";

const ROOF_PX = TILE / TEXTURES.roofTile; // 128 px per metre

/** Value jitter for one tile or block: a grey a few percent either side of `base`. */
function shade(base: number, r: () => number, spread: number): string {
  const v = Math.round(Math.min(255, Math.max(0, base + (r() - 0.5) * 2 * spread)));
  return `rgb(${v},${v},${v})`;
}

const ROOFS: Record<string, (s: Svg, r: () => number) => void> = {
  // Clay tiles: staggered rows of rounded tile ends.
  roofTile(s, r) {
    const rowH = 0.32 * ROOF_PX;
    const tileW = 0.25 * ROOF_PX;
    const rows = Math.round(TILE / rowH);
    const h = TILE / rows;
    const cols = Math.round(TILE / tileW);
    const w = TILE / cols;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const x = i * w + (j % 2) * (w / 2);
        const y = j * h;
        const d = `M${f(x)} ${f(y)}h${f(w)}v${f(h * 0.78)}q${f(-w / 2)} ${f(h * 0.4)} ${f(-w)} 0z`;
        for (const dx of x + w > TILE ? [0, -TILE] : [0]) s.path(d.replace(`M${f(x)}`, `M${f(x + dx)}`), shade(222, r, 14));
        s.rect(x, y + h * 0.78 - 2, w, 3, "rgb(186,184,180)");
      }
  },
  // Slate: small rectangular shingles in staggered courses.
  roofSlate(s, r) {
    const rowH = 0.22 * ROOF_PX;
    const rows = Math.round(TILE / rowH);
    const h = TILE / rows;
    const cols = 32;
    const w = TILE / cols;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const x = i * w + (j % 2) * (w / 2);
        for (const dx of x + w > TILE ? [0, -TILE] : [0]) s.rect(x + dx + 1, j * h + 1, w - 2, h - 2, shade(214, r, 12));
      }
  },
  // Copper: standing seams every half metre over patina.
  roofCopper(s, r) {
    s.rect(0, 0, TILE, TILE, "rgb(224,224,224)");
    const w = TILE / 16;
    for (let i = 0; i < 16; i++) {
      s.rect(i * w + 2, 0, w - 4, TILE, shade(222, r, 10));
      s.rect(i * w - 2, 0, 3, TILE, "rgb(242,242,242)");
      s.rect(i * w + 1, 0, 2, TILE, "rgb(188,188,188)");
    }
  },
  // Flat roofs: gravel with a few skylights and vents.
  roofFlat(s, r) {
    s.rect(0, 0, TILE, TILE, "rgb(214,214,214)");
    for (let k = 0; k < 7; k++) {
      const w = (0.6 + r() * 1.4) * ROOF_PX;
      const h = (0.6 + r() * 1.2) * ROOF_PX;
      const x = r() * (TILE - w);
      const y = r() * (TILE - h);
      s.rect(x, y, w, h, k % 3 === 0 ? "rgb(150,156,160)" : "rgb(232,232,230)");
      s.rect(x, y + h, w, 6, "rgb(176,176,176)");
    }
  },
};

export function roofSvg(name: string): string {
  const s = new Svg("day", 2000 + TEXTURES.roofs.indexOf(name) * 13);
  const r = mulberry32(77 + TEXTURES.roofs.indexOf(name));
  plasterFilter(s, "grain", name === "roofFlat" ? 0.22 : 0.1, 5 + TEXTURES.roofs.indexOf(name));
  ROOFS[name](s, r);
  return s.svg("rgb(220,220,220)", "grain");
}

/** Ashlar quay stone: courses of blocks of random length with mortar joints. */
export function quaySvg(): string {
  const s = new Svg("day", 3001);
  const r = mulberry32(3001);
  const px = TILE / TEXTURES.quayTile; // 256 px per metre
  plasterFilter(s, "stone", 0.12, 21);
  const course = 0.5 * px;
  for (let y = 0; y < TILE; y += course) {
    let x = -r() * px;
    const start = x;
    while (x < start + TILE) {
      const len = (0.8 + r() * 0.8) * px;
      const fill = shade(224, r, 12);
      for (const dx of [0, TILE]) s.rect(x + dx + 3, y + 3, len - 6, course - 6, fill);
      x += len;
    }
  }
  return s.svg("rgb(178,176,170)", "stone");
}

/** Water normal map: a tileable height field of gentle swell and ripples, as RGB normals. */
export function waterNormals(size: number): Uint8Array {
  const out = new Uint8Array(size * size * 3);
  const height = new Float32Array(size * size);
  const P = 8; // noise cells across the tile
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = (x / size) * P;
      const v = (y / size) * P;
      // Ripples stretched across the flow (u runs with the flow), plus finer chop.
      height[y * size + x] = fbm(u, v * 2, 4, 9, P) * 0.7 + fbm(u * 2, v * 2, 3, 23, P * 2) * 0.3;
    }
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  const k = 2.2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * k;
      const dy = (at(x, y + 1) - at(x, y - 1)) * k;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 3;
      out[i] = Math.round(((-dx / l) * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round(((-dy / l) * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round(((1 / l) * 0.5 + 0.5) * 255);
    }
  return out;
}
