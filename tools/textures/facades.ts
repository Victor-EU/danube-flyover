// The eight facade styles of the filler city, painted as 4 × 4 tiles (bays across, storeys
// up; the bottom row is the ground floor, the three above repeat up the building). Walls are
// near-white: the runtime tints them with each building's own colour, so one style serves a
// whole district without every block matching. Every window sits in its own bay and storey,
// which is what lets the runtime switch windows on one by one at dusk.

import { TEXTURES } from "../../src/config";
import { f, plasterFilter, rectD, Svg, TILE, type Mode } from "./svg";

const CELL = TILE / 4; // one bay, one storey (3.4 m)
const PX = TILE / (TEXTURES.storey * 4); // pixels per metre (about 75)

/** The locked facade palette: near-white plaster, so the building colour does the tinting. */
export const FACADE_COLOURS = {
  wall: "#ebe9e4",
  trim: "#f7f6f2",
  groove: "#cdc9c1",
  base: "#c9c4ba",
  frame: "#efeee9",
  wood: "#715e4b",
  door: "#5b4838",
  iron: "#2f2f30",
  shutter: "#7b8869",
  tileA: "#8db1aa",
  tileB: "#d8c27a",
  panelJoint: "#c3c0b8",
};
const C = FACADE_COLOURS;

/** Top of row r (0 = ground floor) in tile pixels. */
const rowTop = (r: number) => (3 - r) * CELL;
const bayX = (b: number) => b * CELL;

/** A horizontal band across the whole tile (it wraps by construction). */
function band(s: Svg, y: number, h: number, fill: string): void {
  s.rect(0, y, TILE, h, fill);
}

type Rect = { x: number; y: number; w: number; h: number };

/**
 * A window centred in bay b of row r: w × h pixels, sill `sill` px above the row's floor.
 * `deco` draws its surround, shutters and so on first, so the glass lands on top.
 */
function win(s: Svg, b: number, r: number, w: number, h: number, sill: number, o: Parameters<Svg["glass"]>[4] = {}, deco?: (w: Rect) => void): Rect {
  const rect = { x: bayX(b) + (CELL - w) / 2, y: rowTop(r) + CELL - sill - h, w, h };
  deco?.(rect);
  s.glass(rect.x, rect.y, w, h, o);
  return rect;
}

/** Sill, a soft weathering streak under it, and a plain surround. */
function surround(s: Svg, wnd: { x: number; y: number; w: number; h: number }, t: number, sillW = 14) {
  s.rect(wnd.x - t, wnd.y - t, wnd.w + 2 * t, wnd.h + 2 * t, C.trim);
  s.rect(wnd.x - t - sillW / 2, wnd.y + wnd.h + t - 2, wnd.w + 2 * t + sillW, 9, C.trim);
  const g = s.newId("st");
  s.def(`<linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.07"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>`);
  s.rect(wnd.x, wnd.y + wnd.h + t + 7, wnd.w, 46, `url(#${g})`);
}

/** Straight hood or cornice over a window. */
function hood(s: Svg, wnd: { x: number; y: number; w: number }, t: number) {
  s.rect(wnd.x - t - 10, wnd.y - t - 14, wnd.w + 2 * t + 20, 12, C.trim);
  s.rect(wnd.x - t - 6, wnd.y - t - 4, wnd.w + 2 * t + 12, 4, C.groove);
}

/** Triangular (or segmental) pediment over a window. */
function pediment(s: Svg, wnd: { x: number; y: number; w: number }, t: number, segmental = false) {
  const x0 = wnd.x - t - 12;
  const x1 = wnd.x + wnd.w + t + 12;
  const y = wnd.y - t - 6;
  const peak = 30;
  s.rect(x0, y - 4, x1 - x0, 10, C.trim);
  if (segmental) s.path(`M${f(x0)} ${f(y - 4)}Q${f((x0 + x1) / 2)} ${f(y - 4 - peak * 1.6)} ${f(x1)} ${f(y - 4)}z`, C.trim);
  else s.path(`M${f(x0)} ${f(y - 4)}L${f((x0 + x1) / 2)} ${f(y - 4 - peak)}L${f(x1)} ${f(y - 4)}z`, C.trim);
}

/** Horizontal rustication grooves over a band, optionally with staggered vertical joints. */
function rustication(s: Svg, y0: number, y1: number, course: number, joints: boolean) {
  let k = 0;
  for (let y = y0 + course; y < y1 - 2; y += course, k++) {
    s.rect(0, y - 2, TILE, 4, C.groove);
    if (joints) for (let x = (k % 2) * (course * 1.5); x < TILE; x += course * 3) s.rect(x - 2, y - course + 2, 4, course - 4, C.groove);
  }
}

/** A door: dark wood leaves under a glazed (lit) fanlight. */
function door(s: Svg, b: number, w: number, h: number, arch = 0) {
  const x = bayX(b) + (CELL - w) / 2;
  const y = rowTop(0) + CELL - h;
  const fan = arch > 0 ? arch + 18 : 34;
  s.rect(x - 12, y - 12, w + 24, h + 12, C.trim);
  s.glass(x, y, w, fan, { arch, bars: "none", frame: C.wood, curtains: 0 });
  s.rect(x, y + fan, w, h - fan, C.door);
  s.rect(x + w / 2 - 2, y + fan, 4, h - fan, "#3f3127");
  for (const side of [0, 1]) s.rect(x + 10 + side * (w / 2), y + fan + 14, w / 2 - 20, h - fan - 28, "#68543f");
}

/** Wrought-iron bars over a ground-floor window. */
function grille(s: Svg, wnd: { x: number; y: number; w: number; h: number }) {
  const bars: string[] = [];
  for (let k = 1; k < 5; k++) bars.push(rectD(wnd.x + (wnd.w * k) / 5 - 2, wnd.y, 4, wnd.h));
  bars.push(rectD(wnd.x, wnd.y + wnd.h * 0.5 - 2, wnd.w, 4));
  s.occluder(bars.join(" "), C.iron);
}

type Painter = (s: Svg) => void;

const STYLES: Record<string, Painter> = {
  // Pest tenement (the 1880–1910 blocks of the V.–IX. districts): rusticated shop floor, a
  // pedimented first floor, hoods above, string courses between storeys.
  pestEclectic(s) {
    rustication(s, rowTop(0) + 20, rowTop(0) + CELL, 30, false);
    band(s, rowTop(0) - 4, 24, C.trim);
    band(s, rowTop(0) + 14, 6, C.groove);
    for (let b = 0; b < 4; b++) {
      if (b === 1) door(s, b, 112, 206, 56);
      else {
        win(s, b, 0, b === 3 ? 176 : 150, 176, 22, { arch: b === 3 ? 0 : 60, bars: "shop", frame: C.wood, shop: true }, (w) =>
          s.rect(w.x - 10, w.y - 10, w.w + 20, 10, C.trim),
        );
      }
      for (let r = 1; r <= 3; r++) {
        win(s, b, r, 94, r === 1 ? 156 : 146, 60, { bars: "cross" }, (w) => {
          surround(s, w, 9);
          if (r === 1) pediment(s, w, 9, b % 2 === 1);
          else if (r === 2) hood(s, w, 9);
        });
      }
    }
    for (const r of [2, 3]) band(s, rowTop(r) + CELL - 14, 12, C.trim);
  },

  // Classicist (Lipótváros): pilasters between the bays, alternating pediments, a deeply
  // rusticated base with square-headed openings and keystones.
  pestClassic(s) {
    rustication(s, rowTop(0), rowTop(0) + CELL, 36, true);
    band(s, rowTop(0) - 8, 26, C.trim);
    for (let b = 0; b < 4; b++) {
      const g = win(s, b, 0, 112, 150, 44, { bars: "tee", frame: C.wood, shop: b === 0 || b === 2 }, (g) =>
        s.rect(g.x - 12, g.y - 12, g.w + 24, g.h + 12, C.trim),
      );
      s.path(`M${f(g.x + g.w / 2 - 14)} ${f(g.y - 14)}h28l-6 26h-16z`, C.trim);
      for (let r = 1; r <= 3; r++)
        win(s, b, r, 90, 144, 62, { bars: "cross" }, (w) => {
          surround(s, w, 8);
          if (r === 1) pediment(s, w, 8, b % 2 === 1);
          else hood(s, w, 8);
        });
    }
    // Pilasters, wrapped across the tile edge.
    for (let b = 0; b <= 4; b++)
      s.wrapX(bayX(b), (x) => {
        if (x < -20 || x > TILE + 20) return;
        s.rect(x - 15, 0, 30, rowTop(0) - 8, C.trim);
        s.rect(x - 15, 0, 3, rowTop(0) - 8, C.groove);
      });
    for (const r of [2, 3]) band(s, rowTop(r) + CELL - 12, 10, C.trim);
  },

  // Secession (1900s Art Nouveau): round-headed windows, a ceramic frieze under each storey,
  // iron balconies, big shop windows under a fascia.
  secession(s) {
    band(s, rowTop(0), 30, "#e2ddd2");
    for (let b = 0; b < 4; b++) {
      if (b === 2) door(s, b, 104, 200, 52);
      else win(s, b, 0, 204, 182, 18, { bars: "shop", frame: "#4d5f55", shop: true });
      for (let r = 1; r <= 3; r++) {
        win(s, b, r, 100, 150, 58, { arch: 50, bars: "tee" }, (w) => surround(s, w, 8, 8));
        if ((b === 1 || b === 3) && r < 3) {
          // Balcony: slab and railing across the bay.
          const y = rowTop(r) + CELL - 58;
          s.rect(bayX(b) + 34, y, CELL - 68, 10, C.trim);
          const rails: string[] = [rectD(bayX(b) + 36, y - 44, CELL - 72, 4)];
          for (let x = bayX(b) + 40; x < bayX(b) + CELL - 40; x += 14) rails.push(rectD(x, y - 44, 3, 44));
          s.occluder(rails.join(" "), C.iron);
        }
      }
    }
    for (let r = 1; r <= 3; r++) {
      const y = rowTop(r) + 6;
      band(s, y, 20, C.trim);
      for (let x = 0; x < TILE; x += 32) {
        s.rect(x + 4, y + 4, 12, 12, C.tileA);
        s.rect(x + 20, y + 4, 8, 12, C.tileB);
      }
    }
  },

  // Buda baroque (Víziváros, Tabán): two or three storeys, plain walls, green shutters, an
  // arched gate and barred windows on the street.
  budaBaroque(s) {
    band(s, rowTop(0) + CELL - 40, 40, C.base);
    for (let b = 0; b < 4; b++) {
      if (b === 1) door(s, b, 150, 204, 75);
      else grille(s, win(s, b, 0, 82, 112, 72, { bars: "cross", curtains: 0.7 }));
      for (let r = 1; r <= 3; r++) {
        win(s, b, r, 86, 124, 70, { bars: "cross", curtains: 0.7 }, (w) => {
          s.rect(w.x - 8, w.y - 8, w.w + 16, w.h + 16, C.trim);
          for (const side of [-1, 1]) {
            const x = side < 0 ? w.x - 8 - 42 : w.x + w.w + 8;
            s.rect(x, w.y - 4, 42, w.h + 8, C.shutter);
            for (let y = w.y + 6; y < w.y + w.h; y += 12) s.rect(x + 5, y, 32, 4, "#6c785c");
          }
          s.rect(w.x - 16, w.y + w.h + 6, w.w + 32, 8, C.trim);
        });
      }
    }
    band(s, rowTop(1) + CELL - 6, 8, C.trim);
  },

  // Castle District baroque: segmental-arched hoods, aprons under the sills, a stone base and
  // an arched gateway.
  castle(s) {
    band(s, rowTop(0) + CELL - 64, 64, C.base);
    rustication(s, rowTop(0) + CELL - 64, rowTop(0) + CELL, 32, true);
    for (let b = 0; b < 4; b++) {
      if (b === 1) door(s, b, 140, 196, 70);
      else grille(s, win(s, b, 0, 80, 118, 78, { bars: "cross" }));
      for (let r = 1; r <= 3; r++) {
        win(s, b, r, 84, 132, 66, { bars: "cross", curtains: 0.6 }, (w) => {
          surround(s, w, 8, 10);
          s.path(`M${f(w.x - 16)} ${f(w.y - 8)}Q${f(w.x + w.w / 2)} ${f(w.y - 44)} ${f(w.x + w.w + 16)} ${f(w.y - 8)}z`, C.trim);
          s.rect(w.x + 6, w.y + w.h + 18, w.w - 12, 30, "#f1efea");
        });
      }
    }
    band(s, rowTop(0) - 6, 18, C.trim);
  },

  // Modern offices and shops: ribbon windows with mullions, glazed ground floor under a
  // canopy.
  modern(s) {
    for (let r = 1; r <= 3; r++) {
      const y = rowTop(r) + 66;
      for (let b = 0; b < 4; b++) s.glass(bayX(b), y, CELL, 136, { bars: "none", frame: "#9aa0a3", curtains: 0.15 });
      const m: string[] = [];
      for (let x = 0; x < TILE; x += 64) m.push(rectD(x - 3, y, 6, 136));
      m.push(rectD(0, y - 4, TILE, 8), rectD(0, y + 132, TILE, 8));
      s.occluder(m.join(" "), "#8f969a");
      s.rect(0, rowTop(r) + CELL - 3, TILE, 3, C.panelJoint);
    }
    for (let b = 0; b < 4; b++) s.glass(bayX(b), rowTop(0) + 40, CELL, 200, { bars: "none", frame: "#8f969a", shop: true });
    const m: string[] = [];
    for (let x = 0; x < TILE; x += 128) m.push(rectD(x - 4, rowTop(0) + 40, 8, 200));
    s.occluder(m.join(" "), "#8f969a");
    band(s, rowTop(0) + 18, 22, "#b9bcbc");
  },

  // Prefab panel blocks (1960s–80s): panel joints on the storey and bay grid, small windows,
  // loggias in the two middle bays.
  panel(s) {
    for (let b = 0; b < 4; b++)
      for (let r = 0; r <= 3; r++) {
        if (r > 0 && (b === 1 || b === 2)) {
          const x = bayX(b) + 28;
          const y = rowTop(r) + 40;
          s.rect(x, y, CELL - 56, 186, "#b5b1a9");
          s.glass(x + 18, y + 20, 70, 160, { bars: "tee", frame: "#e9e8e4", curtains: 0.6 });
          s.glass(x + 104, y + 20, 72, 92, { bars: "tee", frame: "#e9e8e4", curtains: 0.6 });
          s.rect(x - 6, y + 114, CELL - 44, 76, C.trim);
        } else if (r === 0 && b === 1) {
          s.glass(bayX(b) + 66, rowTop(0) + 50, 124, 206, { bars: "tee", frame: "#9aa0a3", shop: true });
        } else win(s, b, r, 112, 118, 82, { bars: "tee", frame: "#e9e8e4", curtains: 0.6 });
      }
    for (let r = 0; r <= 3; r++) s.rect(0, rowTop(r) - 2, TILE, 4, C.panelJoint);
    for (let b = 0; b <= 4; b++) s.wrapX(bayX(b), (x) => s.rect(x - 2, 0, 4, TILE, C.panelJoint));
  },

  // Villas and small houses (the Buda hills): fewer, larger windows with shutters, a door,
  // and plain wall between.
  villa(s) {
    band(s, rowTop(0) + CELL - 34, 34, C.base);
    for (let b = 0; b < 4; b++) {
      if (b === 1) door(s, b, 92, 200);
      else if (b !== 3) {
        win(s, b, 0, 104, 134, 62, { bars: "cross", curtains: 0.7 }, (w) => s.rect(w.x - 8, w.y - 8, w.w + 16, w.h + 16, C.trim));
      }
      for (let r = 1; r <= 3; r++) {
        if (b % 2 === 1) continue;
        win(s, b, r, 104, 140, 64, { bars: "cross", curtains: 0.7 }, (w) => {
          s.rect(w.x - 8, w.y - 8, w.w + 16, w.h + 16, C.trim);
          for (const side of [-1, 1]) s.rect(side < 0 ? w.x - 8 - 46 : w.x + w.w + 8, w.y - 4, 46, w.h + 8, C.shutter);
          s.rect(w.x - 16, w.y + w.h + 6, w.w + 32, 8, C.trim);
        });
      }
    }
  },
};

export function facadeSvg(style: string, mode: Mode): string {
  const paint = STYLES[style];
  if (!paint) throw new Error(`unknown facade style ${style}`);
  // Same seed in both modes, so lit windows land exactly on the day ones.
  const s = new Svg(mode, 1000 + TEXTURES.facades.indexOf(style) * 17);
  plasterFilter(s, "plaster", 0.09, 11 + TEXTURES.facades.indexOf(style));
  paint(s);
  return s.svg(C.wall, "plaster");
}

export { PX };
