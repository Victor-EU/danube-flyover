// A small SVG builder for the painted textures, rasterised by sharp (librsvg). Everything is
// drawn twice from one layout: `day` is the lighting-neutral albedo, `lit` is the emissive
// layer, black except where light comes from (window glass, shopfronts).

import sharp from "sharp";
import { mulberry32 } from "../lib/geom";

export type Mode = "day" | "lit";

export const TILE = 1024;

/** Interior light colours for lit windows (sRGB), most of them warm, a few cool. */
const INTERIOR = ["#ffcf87", "#ffc477", "#ffd9a3", "#ffe3bd", "#ffd08f", "#ffbf6b", "#f3eedf", "#dfe8f6"];

export interface GlassOpts {
  /** Round the top into a semicircle (or a segment of `arch` px). */
  arch?: number;
  /** Mullion pattern drawn over the glass. */
  bars?: "cross" | "tee" | "grid" | "none" | "shop";
  frame?: string;
  /** Shopfronts glow brighter and whiter. */
  shop?: boolean;
  /** Probability of curtains in lit mode. */
  curtains?: number;
}

export class Svg {
  private readonly defs: string[] = [];
  private readonly body: string[] = [];
  private id = 0;
  readonly rand: () => number;

  constructor(
    readonly mode: Mode,
    seed: number,
    private readonly width = TILE,
    private readonly height = TILE,
  ) {
    this.rand = mulberry32(seed);
  }

  get lit(): boolean {
    return this.mode === "lit";
  }

  raw(s: string): void {
    this.body.push(s);
  }

  def(s: string): void {
    this.defs.push(s);
  }

  newId(prefix: string): string {
    return `${prefix}${this.id++}`;
  }

  /** A day-only shape: in lit mode nothing is drawn (the background is black). */
  rect(x: number, y: number, w: number, h: number, fill: string, extra = ""): void {
    if (this.lit) return;
    this.body.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${fill}" ${extra}/>`);
  }

  path(d: string, fill: string, extra = ""): void {
    if (this.lit) return;
    this.body.push(`<path d="${d}" fill="${fill}" ${extra}/>`);
  }

  /** Something dark in both modes (frames and bars in front of lit glass). */
  occluder(d: string, fill: string, evenOdd = false): void {
    if (!d) return;
    this.body.push(`<path d="${d}" fill="${this.lit ? "#000" : fill}"${evenOdd ? ' fill-rule="evenodd"' : ""}/>`);
  }

  /** Repeat a shape at x and x ± width so anything crossing the tile edge wraps. */
  wrapX(x: number, draw: (x: number) => void): void {
    draw(x);
    if (x < 64) draw(x + this.width);
    if (x > this.width - 64) draw(x - this.width);
  }

  /** A window or shopfront: glass, then its bars. Rect from (x, y) with an optional arched top. */
  glass(x: number, y: number, w: number, h: number, o: GlassOpts = {}): void {
    const d = windowPath(x, y, w, h, o.arch ?? 0);
    if (this.lit) {
      const r = this.rand;
      const c = o.shop ? "#ffe9c6" : INTERIOR[Math.floor(r() * INTERIOR.length)];
      const k = o.shop ? 1 : 0.62 + r() * 0.38;
      const g = this.newId("g");
      // A lamp-lit room: brightest in the middle, dimmer toward the ceiling and the sill.
      this.def(
        `<linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity="${f(0.7 * k)}"/><stop offset="0.55" stop-color="${c}" stop-opacity="${f(k)}"/><stop offset="1" stop-color="${c}" stop-opacity="${f(0.82 * k)}"/></linearGradient>`,
      );
      this.body.push(`<path d="${d}" fill="url(#${g})"/>`);
      if (!o.shop && r() < (o.curtains ?? 0.5)) {
        const cw = w * (0.14 + r() * 0.1);
        const shade = "rgba(0,0,0,0.45)";
        this.body.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(cw)}" height="${f(h)}" fill="${shade}"/><rect x="${f(x + w - cw)}" y="${f(y)}" width="${f(cw)}" height="${f(h)}" fill="${shade}"/>`);
      } else if (!o.shop && r() < 0.2) {
        this.body.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h * (0.3 + r() * 0.25))}" fill="rgba(0,0,0,0.55)"/>`);
      }
    } else {
      // Flat glass, a touch lighter at the top: no sky, no reflections (the rule for albedo).
      const g = this.newId("q");
      this.def(`<linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3f4b55"/><stop offset="1" stop-color="#2f3942"/></linearGradient>`);
      this.body.push(`<path d="${d}" fill="url(#${g})"/>`);
    }
    const frame = o.frame ?? "#eeede8";
    const t = Math.max(5, Math.min(w, h) * 0.06);
    const bars = o.bars ?? "cross";
    const top = y + (o.arch ? Math.min(o.arch, w / 2) : 0);
    const parts: string[] = [];
    if (bars === "cross" || bars === "tee") parts.push(rectD(x + w / 2 - t / 2, y, t, h));
    if (bars === "cross") parts.push(rectD(x, top + (h - (top - y)) * 0.3 - t / 2, w, t));
    if (bars === "tee") parts.push(rectD(x, top + (h - (top - y)) * 0.32 - t / 2, w, t));
    if (bars === "grid") {
      for (let k = 1; k < 3; k++) parts.push(rectD(x + (w * k) / 3 - t / 2, y, t, h));
      parts.push(rectD(x, y + h / 2 - t / 2, w, t));
    }
    if (bars === "shop") {
      parts.push(rectD(x, y + h * 0.22 - t / 2, w, t));
      for (let k = 1; k < 3; k++) parts.push(rectD(x + (w * k) / 3 - t / 2, y + h * 0.22, t, h * 0.78));
    }
    this.occluder(parts.join(" "), frame);
    // The frame itself, as a ring around the glass.
    this.occluder(ringD(x, y, w, h, o.arch ?? 0, t * 0.8), frame, true);
  }

  svg(background: string, filter?: string): string {
    const bg = this.lit ? "#000" : background;
    const content = filter && !this.lit ? `<g filter="url(#${filter})">${this.body.join("")}</g>` : this.body.join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}"><defs>${this.defs.join("")}</defs><rect width="100%" height="100%" fill="${bg}"/>${content}</svg>`;
  }
}

/** Plaster: the drawing multiplied by two scales of stitched (tileable) noise. */
export function plasterFilter(svg: Svg, id: string, amount = 0.1, seed = 3): void {
  const a = f(amount);
  const b = f(1 - amount);
  // The coarse weathering layer is half as strong as the grain.
  const c = f(amount * 0.5);
  const d = f(1 - amount * 0.5);
  svg.def(
    `<filter id="${id}" x="0" y="0" width="${TILE}" height="${TILE}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="4" seed="${seed}" stitchTiles="stitch" result="fine"/>` +
      `<feColorMatrix in="fine" type="matrix" values="${a} 0 0 0 ${b}  ${a} 0 0 0 ${b}  ${a} 0 0 0 ${b}  0 0 0 0 1" result="fineG"/>` +
      `<feTurbulence type="fractalNoise" baseFrequency="0.0078125" numOctaves="2" seed="${seed + 7}" stitchTiles="stitch" result="coarse"/>` +
      `<feColorMatrix in="coarse" type="matrix" values="${c} 0 0 0 ${d}  ${c} 0 0 0 ${d}  ${c} 0 0 0 ${d}  0 0 0 0 1" result="coarseG"/>` +
      `<feComposite in="SourceGraphic" in2="fineG" operator="arithmetic" k1="1" k2="0" k3="0" k4="0" result="s1"/>` +
      `<feComposite in="s1" in2="coarseG" operator="arithmetic" k1="1" k2="0" k3="0" k4="0"/>` +
      `</filter>`,
  );
}

export async function rasterise(svg: string, size = TILE): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: 72 }).resize(size, size).removeAlpha().png().toBuffer();
}

export const f = (v: number) => (Math.round(v * 100) / 100).toString();

export function rectD(x: number, y: number, w: number, h: number): string {
  return `M${f(x)} ${f(y)}h${f(w)}v${f(h)}h${f(-w)}z`;
}

/** Window outline with an optional arched top of height `arch` (a semicircle if arch ≥ w/2). */
export function windowPath(x: number, y: number, w: number, h: number, arch: number): string {
  if (arch <= 0) return rectD(x, y, w, h);
  const a = Math.min(arch, w / 2);
  // Segmental arch: a circle through both springing points and the crown.
  const r = (a * a + (w / 2) * (w / 2)) / (2 * a);
  return `M${f(x)} ${f(y + h)}V${f(y + a)}A${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + a)}V${f(y + h)}z`;
}

/** The ring between a window outline and the same outline inset by t (even-odd fill). */
function ringD(x: number, y: number, w: number, h: number, arch: number, t: number): string {
  const outer = windowPath(x - t, y - t, w + 2 * t, h + 2 * t, arch > 0 ? arch + t : 0);
  const inner = windowPath(x, y, w, h, arch);
  return `${outer} ${inner}`;
}
