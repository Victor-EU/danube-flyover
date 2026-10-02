// The hero landmarks' texture layers (HERO_LAYERS in src/config.ts). Painted in metres: each
// layer covers its `tile` (for example 8.8 × 12 m for Parliament's tracery), scaled onto the
// 1024² canvas, so arches stay round however the tile is proportioned. Window layers hold
// `bays` × `rows` windows and have a lit (emissive) twin; the rest are day only. Most are
// near-white detail the models tint per face; the brick, the Zsolnay tiles and the stained
// glass carry their own colour.

import { HERO_LAYERS, type HeroLayer } from "../../src/config";
import { mulberry32 } from "../lib/geom";
import { f, plasterFilter, Svg, TILE, type Mode } from "./svg";

const INTERIOR = ["#ffcf87", "#ffc477", "#ffd9a3", "#ffe3bd", "#ffd08f", "#ffbf6b", "#f6efdf"];

/** Drawing in metres on a tile tw × th metres, y down from the top edge. */
class Pen {
  readonly sx: number;
  readonly sy: number;
  readonly rand: () => number;
  constructor(
    readonly s: Svg,
    readonly tw: number,
    readonly th: number,
    seed: number,
  ) {
    this.sx = TILE / tw;
    this.sy = TILE / th;
    this.rand = mulberry32(seed);
  }
  get lit(): boolean {
    return this.s.lit;
  }
  P(x: number, y: number): string {
    return `${f(x * this.sx)} ${f(y * this.sy)}`;
  }
  rect(x: number, y: number, w: number, h: number, fill: string): void {
    this.s.rect(x * this.sx, y * this.sy, w * this.sx, h * this.sy, fill);
  }
  /** A rect repeated across the left/right tile edge. */
  rectWrap(x: number, y: number, w: number, h: number, fill: string): void {
    for (const dx of [0, -this.tw, this.tw]) if (x + dx < this.tw && x + dx + w > 0) this.rect(x + dx, y, w, h, fill);
  }
  path(d: string, fill: string): void {
    this.s.path(d, fill);
  }
  /** Dark in both modes (frames, mullions, bars in front of lit glass). */
  occlude(d: string, fill: string, evenOdd = false): void {
    this.s.occluder(d, fill, evenOdd);
  }
  rectD(x: number, y: number, w: number, h: number): string {
    return `M${this.P(x, y)}H${f((x + w) * this.sx)}V${f((y + h) * this.sy)}H${f(x * this.sx)}z`;
  }
  /** A pointed (equilateral-ish) arch opening: vertical sides, apex at yTop. */
  pointed(x: number, yTop: number, w: number, yBottom: number, sharp = 1): string {
    const r = w * sharp;
    const spring = yTop + Math.sqrt(Math.max(0, r * r - (r - w / 2) * (r - w / 2)));
    return `M${this.P(x, yBottom)}V${f(spring * this.sy)}A${f(r * this.sx)} ${f(r * this.sy)} 0 0 1 ${this.P(x + w / 2, yTop)}A${f(r * this.sx)} ${f(r * this.sy)} 0 0 1 ${this.P(x + w, spring)}V${f(yBottom * this.sy)}z`;
  }
  /** A round-headed opening. */
  round(x: number, yTop: number, w: number, yBottom: number): string {
    const spring = yTop + w / 2;
    return `M${this.P(x, yBottom)}V${f(spring * this.sy)}A${f((w / 2) * this.sx)} ${f((w / 2) * this.sy)} 0 0 1 ${this.P(x + w, spring)}V${f(yBottom * this.sy)}z`;
  }
  circle(cx: number, cy: number, r: number): string {
    return `M${this.P(cx - r, cy)}A${f(r * this.sx)} ${f(r * this.sy)} 0 1 0 ${this.P(cx + r, cy)}A${f(r * this.sx)} ${f(r * this.sy)} 0 1 0 ${this.P(cx - r, cy)}z`;
  }
  /** Glass: dark by day, a lamp-lit room (or `color`) by night. */
  glass(d: string, o: { color?: string; k?: number; curtains?: number; top?: number; bottom?: number } = {}): void {
    if (this.lit) {
      const r = this.rand;
      const c = o.color ?? INTERIOR[Math.floor(r() * INTERIOR.length)];
      const k = o.k ?? 0.6 + r() * 0.4;
      const g = this.s.newId("hg");
      this.s.def(
        `<linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity="${f(0.62 * k)}"/><stop offset="0.6" stop-color="${c}" stop-opacity="${f(k)}"/><stop offset="1" stop-color="${c}" stop-opacity="${f(0.8 * k)}"/></linearGradient>`,
      );
      this.s.raw(`<path d="${d}" fill="url(#${g})"/>`);
    } else {
      const g = this.s.newId("hq");
      this.s.def(`<linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#46525c"/><stop offset="1" stop-color="#2d363f"/></linearGradient>`);
      this.s.raw(`<path d="${d}" fill="url(#${g})"/>`);
    }
  }
}

const near = (base: number, r: () => number, spread: number) => {
  const v = Math.round(Math.min(255, Math.max(0, base + (r() - 0.5) * 2 * spread)));
  return `rgb(${v},${v},${v})`;
};

const STONE = { wall: "#ece6da", trim: "#f7f4ee", groove: "#cfc6b6", shadow: "#bdb3a2", dark: "#8f8678" };

type Painter = (p: Pen) => void;

const PAINTERS: Record<HeroLayer, Painter> = {
  // Parliament: a two-light pointed window per bay and storey under a tracery head, between
  // buttress strips, a string course at every sill and a blind arcade under it.
  gothic(p) {
    const [cw, ch] = [4.4, 6];
    p.rect(0, 0, p.tw, p.th, STONE.wall);
    for (let r = 0; r < 2; r++) {
      const yb = p.th - r * ch; // bottom of the row
      // String course under the sill, with a shadow line.
      p.rect(0, yb - 0.95, p.tw, 0.26, STONE.trim);
      p.rect(0, yb - 0.69, p.tw, 0.07, STONE.groove);
      // A blind arcade frieze in the spandrel above the window.
      for (let x = 0.15; x < p.tw; x += 0.55) p.path(p.pointed(x, yb - ch + 0.18, 0.36, yb - ch + 0.62, 0.9), STONE.groove);
      for (let b = 0; b < 2; b++) {
        const cx = b * cw + cw / 2;
        const w = 2.3;
        const top = yb - 5.55;
        const bottom = yb - 1.0;
        // Moulded surround, then the opening.
        p.path(p.pointed(cx - w / 2 - 0.2, top - 0.2, w + 0.4, bottom + 0.05), STONE.trim);
        const opening = p.pointed(cx - w / 2, top, w, bottom);
        p.glass(opening, { curtains: 0.4 });
        // Two lancets and a roundel: the mullion and the tracery are stone in front of the glass.
        const lw = (w - 0.16) / 2;
        const head = top + w * 0.62;
        p.occlude(p.rectD(cx - 0.08, head + 0.35, 0.16, bottom - head - 0.35), STONE.trim);
        // The head: stone, pierced by the two lancet tops and a roundel.
        p.occlude(`${p.pointed(cx - w / 2 + 0.06, top + 0.12, w - 0.12, head + 0.45)} ${p.pointed(cx - w / 2 + 0.16, head - 0.02, lw - 0.1, head + 0.45)} ${p.pointed(cx + 0.1, head - 0.02, lw - 0.1, head + 0.45)} ${p.circle(cx, top + w * 0.42, w * 0.2)}`, STONE.trim, true);
        // A transom across both lights.
        p.occlude(p.rectD(cx - w / 2, bottom - 1.6, w, 0.12), STONE.trim);
      }
      // Buttress strips at the bay edges.
      for (let b = 0; b <= 2; b++) {
        p.rectWrap(b * cw - 0.32, yb - ch, 0.64, ch, STONE.trim);
        p.rectWrap(b * cw + 0.32, yb - ch, 0.07, ch, STONE.groove);
        p.rectWrap(b * cw - 0.32, yb - ch + 1.9, 0.64, 0.12, STONE.groove);
      }
    }
  },

  // Buda Castle and the Academy: pilasters between the bays, alternating pediments over tall
  // windows, a cornice band at each storey.
  palace(p) {
    const [cw, ch] = [4, 4.6];
    p.rect(0, 0, p.tw, p.th, STONE.wall);
    for (let r = 0; r < 2; r++) {
      const yb = p.th - r * ch;
      p.rect(0, yb - ch, p.tw, 0.32, STONE.trim);
      p.rect(0, yb - ch + 0.32, p.tw, 0.06, STONE.groove);
      for (let b = 0; b < 2; b++) {
        const cx = b * cw + cw / 2;
        const w = 1.45;
        const top = yb - 3.55;
        const bottom = yb - 0.75;
        p.rect(cx - w / 2 - 0.18, top - 0.18, w + 0.36, bottom - top + 0.36, STONE.trim);
        p.rect(cx - w / 2 - 0.35, bottom + 0.12, w + 0.7, 0.16, STONE.trim);
        p.glass(p.rectD(cx - w / 2, top, w, bottom - top));
        p.occlude(`${p.rectD(cx - 0.05, top, 0.1, bottom - top)} ${p.rectD(cx - w / 2, top + 0.85, w, 0.09)}`, "#f1eee6");
        // Pediments: triangular on the upper row, segmental below.
        const x0 = cx - w / 2 - 0.42;
        const x1 = cx + w / 2 + 0.42;
        const y = top - 0.3;
        p.rect(x0, y - 0.1, x1 - x0, 0.16, STONE.trim);
        if (r === 1) p.path(`M${p.P(x0, y - 0.1)}L${p.P(cx, y - 0.62)}L${p.P(x1, y - 0.1)}z`, STONE.trim);
        else p.path(`M${p.P(x0, y - 0.1)}Q${p.P(cx, y - 0.85)} ${p.P(x1, y - 0.1)}z`, STONE.trim);
      }
      for (let b = 0; b <= 2; b++) {
        p.rectWrap(b * cw - 0.3, yb - ch + 0.38, 0.6, ch - 0.38, STONE.trim);
        p.rectWrap(b * cw - 0.3, yb - ch + 0.38, 0.06, ch - 0.38, STONE.groove);
      }
    }
  },

  // The Gellért Hotel and Gresham Palace: round-headed windows, iron balconies on the lower
  // row, a ceramic band under each storey.
  secession(p) {
    const [cw, ch] = [3.6, 3.8];
    p.rect(0, 0, p.tw, p.th, "#efeae0");
    for (let r = 0; r < 2; r++) {
      const yb = p.th - r * ch;
      p.rect(0, yb - ch, p.tw, 0.42, STONE.trim);
      for (let x = 0.05; x < p.tw; x += 0.4) {
        p.rect(x, yb - ch + 0.1, 0.18, 0.2, "#c9d8cf");
        p.rect(x + 0.2, yb - ch + 0.1, 0.12, 0.2, "#e2d3a6");
      }
      for (let b = 0; b < 2; b++) {
        const cx = b * cw + cw / 2;
        const w = 1.35;
        const top = yb - 3.05;
        const bottom = yb - 0.55;
        p.path(p.round(cx - w / 2 - 0.16, top - 0.16, w + 0.32, bottom + 0.1), STONE.trim);
        p.glass(p.round(cx - w / 2, top, w, bottom));
        p.occlude(`${p.rectD(cx - 0.05, top + w / 2, 0.1, bottom - top - w / 2)} ${p.rectD(cx - w / 2, top + w / 2 + 0.05, w, 0.08)}`, "#f2efe8");
        if (r === 0) {
          // A balcony: slab and railing.
          p.rect(cx - 1.2, bottom - 0.05, 2.4, 0.14, STONE.trim);
          const rails = [p.rectD(cx - 1.15, bottom - 0.95, 2.3, 0.06)];
          for (let x = cx - 1.1; x < cx + 1.15; x += 0.16) rails.push(p.rectD(x, bottom - 0.95, 0.04, 0.9));
          p.occlude(rails.join(" "), "#39403d");
        }
      }
    }
  },

  // The Central Market Hall: red brick in stretcher courses with stone bands and tall round-
  // headed windows with stone surrounds and iron glazing bars. Full colour.
  market(p) {
    const [cw, ch] = [5, 7];
    const brick = ["#b85b3b", "#ad5336", "#c06342", "#a84f33", "#b9603f"];
    p.rect(0, 0, p.tw, p.th, "#d8c7b4");
    const course = 0.25;
    for (let y = 0, k = 0; y < p.th; y += course, k++)
      for (let x = (k % 2) * 0.3 - 0.3; x < p.tw; x += 0.6) p.rectWrap(x + 0.02, y + 0.02, 0.56, course - 0.04, brick[Math.floor(p.rand() * brick.length)]);
    for (let r = 0; r < 2; r++) {
      const yb = p.th - r * ch;
      p.rect(0, yb - 0.6, p.tw, 0.5, "#e8dcc6");
      p.rect(0, yb - ch + 0.1, p.tw, 0.35, "#e8dcc6");
      for (let b = 0; b < 2; b++) {
        const cx = b * cw + cw / 2;
        const w = 2.5;
        const top = yb - 6.0;
        const bottom = yb - 0.75;
        p.path(p.round(cx - w / 2 - 0.3, top - 0.3, w + 0.6, bottom + 0.05), "#e8dcc6");
        p.glass(p.round(cx - w / 2, top, w, bottom), { color: "#ffd59a", k: 0.95 });
        const bars: string[] = [];
        for (let k = 1; k < 4; k++) bars.push(p.rectD(cx - w / 2 + (w * k) / 4 - 0.04, top, 0.08, bottom - top));
        for (let y = top + w / 2; y < bottom; y += 0.9) bars.push(p.rectD(cx - w / 2, y, w, 0.07));
        p.occlude(bars.join(" "), "#2f3a35");
      }
      for (let b = 0; b <= 2; b++) p.rectWrap(b * cw - 0.35, yb - ch + 0.45, 0.7, ch - 1.05, "#e2d4bd");
    }
  },

  // Matthias Church: one tall lancet per bay with tracery, between buttresses; by night its
  // stained glass glows red, blue and gold.
  lancet(p) {
    const cw = 4.5;
    p.rect(0, 0, p.tw, p.th, STONE.wall);
    for (let y = 0.5; y < p.th; y += 0.55) p.rect(0, y, p.tw, 0.04, "#ddd6c9");
    for (let b = 0; b < 2; b++) {
      const cx = b * cw + cw / 2;
      const w = 1.7;
      const top = 2.2;
      const bottom = p.th - 3.0;
      p.path(p.pointed(cx - w / 2 - 0.22, top - 0.22, w + 0.44, bottom + 0.1), STONE.trim);
      if (p.lit) {
        // Stained glass: a lattice of coloured panes.
        const colours = ["#d8432f", "#3d5fc4", "#f0b440", "#7d3fa8", "#e9d38c", "#2f8a6a"];
        p.s.raw(`<path d="${p.pointed(cx - w / 2, top, w, bottom)}" fill="#a35a2a"/>`);
        for (let y = top; y < bottom; y += 0.45)
          for (let x = cx - w / 2; x < cx + w / 2; x += 0.42) {
            const c = colours[Math.floor(p.rand() * colours.length)];
            p.s.raw(`<rect x="${f(x * p.sx)}" y="${f(y * p.sy)}" width="${f(0.38 * p.sx)}" height="${f(0.41 * p.sy)}" fill="${c}" fill-opacity="0.85" clip-path="url(#lc${b})"/>`);
          }
        p.s.def(`<clipPath id="lc${b}"><path d="${p.pointed(cx - w / 2, top, w, bottom)}"/></clipPath>`);
      } else p.glass(p.pointed(cx - w / 2, top, w, bottom));
      p.occlude(`${p.rectD(cx - 0.06, top + 1.4, 0.12, bottom - top - 1.4)} ${p.circle(cx, top + 0.9, 0.36)}`, STONE.trim);
      for (let y = top + 2.4; y < bottom; y += 2.2) p.occlude(p.rectD(cx - w / 2, y, w, 0.08), STONE.trim);
    }
    for (let b = 0; b <= 2; b++) {
      p.rectWrap(b * cw - 0.5, 0, 1.0, p.th, STONE.trim);
      p.rectWrap(b * cw + 0.5, 0, 0.08, p.th, STONE.groove);
      for (const y of [4, 8.5, 12.5]) p.rectWrap(b * cw - 0.5, y, 1.0, 0.18, STONE.groove);
    }
  },

  // Fisherman's Bastion: white cloisters, round arches on columns, two levels.
  arcade(p) {
    const [cw, ch] = [3.2, 4.2];
    p.rect(0, 0, p.tw, p.th, "#f2efe8");
    for (let y = 0.45; y < p.th; y += 0.45) p.rect(0, y, p.tw, 0.035, "#dedad0");
    for (let r = 0; r < 2; r++) {
      const yb = p.th - r * ch;
      p.rect(0, yb - ch, p.tw, 0.3, STONE.trim);
      p.rect(0, yb - 0.5, p.tw, 0.5, "#e7e2d7");
      for (let b = 0; b < 2; b++) {
        const cx = b * cw + cw / 2;
        const w = 2.25;
        const top = yb - 3.55;
        const bottom = yb - 0.5;
        p.path(p.round(cx - w / 2 - 0.16, top - 0.16, w + 0.32, bottom), STONE.trim);
        // The opening shows the shaded walk behind (by night lit by its lamps).
        if (p.lit) p.glass(p.round(cx - w / 2, top, w, bottom), { color: "#ffd9a0", k: 0.55 });
        else p.s.raw(`<path d="${p.round(cx - w / 2, top, w, bottom)}" fill="#6f6a62"/>`);
        // A pair of slim columns in the middle of the opening.
        p.occlude(p.rectD(cx - 0.12, top + w / 2 + 0.25, 0.24, bottom - top - w / 2 - 0.25), "#f4f1ea");
        // The tympanum: the head of the opening, pierced by two small arches over the columns.
        const spring = top + w / 2 + 0.35;
        const sw = w / 2 - 0.2;
        p.occlude(`${p.round(cx - w / 2, top, w, spring)} ${p.round(cx - w / 2 + 0.08, top + 0.62, sw, spring + 0.01)} ${p.round(cx + 0.12, top + 0.62, sw, spring + 0.01)}`, "#f4f1ea", true);
      }
    }
  },

  ashlar(p) {
    p.rect(0, 0, p.tw, p.th, "#cfc8bb");
    const course = 0.5;
    for (let y = 0, k = 0; y < p.th - 1e-6; y += course, k++) {
      let x = (k % 2) * 0.55 - 1.1;
      while (x < p.tw) {
        const l = 0.8 + p.rand() * 0.6;
        p.rectWrap(x + 0.025, y + 0.025, l - 0.05, course - 0.05, near(236, p.rand, 7));
        x += l;
      }
    }
  },

  // Roof tiles: rounded ends in staggered courses.
  tiles(p) {
    p.rect(0, 0, p.tw, p.th, "rgb(196,190,182)");
    const rowH = 0.25;
    const w = 0.2;
    for (let y = 0, k = 0; y < p.th; y += rowH, k++)
      for (let x = (k % 2) * (w / 2) - w; x < p.tw; x += w) {
        const v = near(228, p.rand, 13);
        const d = `M${p.P(x, y)}H${f((x + w) * p.sx)}V${f((y + rowH * 0.72) * p.sy)}Q${p.P(x + w / 2, y + rowH * 1.08)} ${p.P(x, y + rowH * 0.72)}z`;
        p.path(d, v);
        if (x + w > p.tw) p.path(d.replace(/(-?[\d.]+) (-?[\d.]+)/g, (_, a, b) => `${f(Number(a) - TILE)} ${b}`), v);
      }
  },

  // Zsolnay glazed tiles: diamonds and chevrons in orange, gold, green and brown.
  zsolnay(p) {
    const colours = ["#c8692b", "#e0ad3c", "#3d7a53", "#8b4a2c", "#c8692b", "#e0ad3c"];
    p.rect(0, 0, p.tw, p.th, "#5d3a26");
    const n = 6; // diamonds across the tile
    const dw = p.tw / n;
    const dh = p.th / n;
    for (let j = -1; j <= n; j++)
      for (let i = -1; i <= n; i++) {
        const cx = i * dw + (j % 2 ? dw / 2 : 0);
        const cy = j * dh;
        const c = colours[(((i + j * 2) % colours.length) + colours.length) % colours.length];
        const d = `M${p.P(cx, cy - dh / 2 + 0.04)}L${p.P(cx + dw / 2 - 0.04, cy)}L${p.P(cx, cy + dh / 2 - 0.04)}L${p.P(cx - dw / 2 + 0.04, cy)}z`;
        p.path(d, c);
        // Scale tiles inside each diamond.
        for (let k = 1; k < 4; k++) p.rect(cx - dw / 2 + 0.1, cy - dh / 2 + (dh * k) / 4, dw - 0.2, 0.03, "rgba(0,0,0,0.12)");
      }
  },

  copper(p) {
    p.rect(0, 0, p.tw, p.th, "rgb(222,222,222)");
    const w = 0.5;
    for (let x = 0; x < p.tw; x += w) {
      p.rect(x + 0.03, 0, w - 0.06, p.th, near(222, p.rand, 12));
      p.rect(x - 0.03, 0, 0.04, p.th, "rgb(244,244,244)");
      p.rect(x + 0.01, 0, 0.03, p.th, "rgb(184,184,184)");
    }
    for (let k = 0; k < 18; k++) p.rect(p.rand() * p.tw, p.rand() * p.th, 0.06, 0.6 + p.rand() * 1.4, "rgba(255,255,255,0.35)");
  },

  // Painted iron: plates with rivet rows.
  iron(p) {
    p.rect(0, 0, p.tw, p.th, "rgb(226,226,226)");
    for (let x = 0; x < p.tw; x += 1) {
      p.rect(x, 0, 0.05, p.th, "rgb(178,178,178)");
      for (let y = 0.1; y < p.th; y += 0.2) p.rect(x + 0.12, y, 0.05, 0.05, "rgb(196,196,196)");
    }
    p.rect(0, 0, p.tw, 0.06, "rgb(178,178,178)");
    p.rect(0, p.th / 2, p.tw, 0.05, "rgb(190,190,190)");
  },

  plain(p) {
    p.rect(0, 0, p.tw, p.th, "rgb(232,232,232)");
  },

  metal(p) {
    p.rect(0, 0, p.tw, p.th, "rgb(230,230,230)");
    for (let y = 0; y < p.th; y += 0.25) p.rect(0, y, p.tw, 0.02, "rgba(0,0,0,0.04)");
  },
};

/** Roughness per layer (glazed tiles and metal shine; stone and roof tiles don't). */
export const HERO_ROUGHNESS: Record<HeroLayer, number> = {
  gothic: 0.85,
  palace: 0.85,
  secession: 0.8,
  market: 0.85,
  lancet: 0.85,
  arcade: 0.85,
  ashlar: 0.9,
  tiles: 0.72,
  zsolnay: 0.36,
  copper: 0.55,
  iron: 0.6,
  plain: 0.85,
  metal: 0.42,
};

export function heroSvg(name: HeroLayer, mode: Mode): string {
  const layer = HERO_LAYERS.find((l) => l.name === name)!;
  const seed = 97 + HERO_LAYERS.indexOf(layer) * 131;
  const s = new Svg(mode, seed);
  const p = new Pen(s, layer.tile[0], layer.tile[1], seed);
  PAINTERS[name](p);
  const plaster = name !== "zsolnay" && name !== "market";
  if (plaster) plasterFilter(s, "hp", name === "plain" || name === "metal" ? 0.05 : 0.09, seed % 97);
  return s.svg("#000", plaster ? "hp" : undefined);
}
