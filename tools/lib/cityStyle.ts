// The city's buildings by rule, shared by build-city (the world) and build-far (beyond it), so
// a block looks the same on both sides of the world's edge: heights and roof kinds from the
// OSM tags, colours by district, the facade tile a building wears, its block's roof pitch, and
// the baked occlusion of street canyons.

import { TEXTURES } from "../../src/config";
import { hash01, pointInPolygon, projectPolygons, ringBox, type Polygon } from "./geom";
import { readOsm } from "./io";
import { mansard, pitched, type Profile } from "./roofs";

// --- Districts ---------------------------------------------------------------------------------

/** The inner districts' polygons (tools/osm/districts.geojson: the twelve around the world). */
export function loadDistricts(): { name: string; polys: Polygon[] }[] {
  return readOsm("districts")
    .filter((f) => f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon")
    .map((f) => ({ name: f.properties.name ?? f.properties.id, polys: projectPolygons(f.geometry) }));
}
export const districtLookup = (districts: { name: string; polys: Polygon[] }[]) => (x: number, z: number) =>
  districts.find((d) => d.polys.some((p) => pointInPolygon(p, x, z)))?.name ?? "other";
// Buda is everything west of the river; its districts get the Buda palette.
export const BUDA = new Set(["I. kerület", "II. kerület", "III. kerület", "XI. kerület", "XII. kerület"]);

// --- Heights and roof kinds ------------------------------------------------------------------

export const LEVEL = 3.3;
export const num = (v: string | undefined) => {
  if (!v) return NaN;
  const m = /^\s*([0-9]+(?:[.,][0-9]+)?)\s*(m|ft|')?\s*$/.exec(v);
  if (!m) return NaN;
  const n = Number(m[1].replace(",", "."));
  return m[2] === "ft" || m[2] === "'" ? n * 0.3048 : n;
};
export const SMALL = new Set(["garage", "garages", "shed", "hut", "kiosk", "carport", "service", "toilets", "cabin", "transformer_tower", "bunker"]);
export const HOUSE = new Set(["house", "detached", "semidetached_house", "bungalow", "villa", "terrace"]);
export const CHURCH = new Set(["church", "cathedral", "chapel"]);
export const MODERN = new Set(["office", "commercial", "retail", "industrial", "warehouse", "hospital", "university", "parking", "train_station", "transportation", "service", "garages"]);
export type RoofKind = "pitched" | "mansard" | "steep" | "flat";
export interface Shape {
  eave: number;
  kind: RoofKind;
  roofLevels: number;
  source: "height" | "levels" | "default";
}

/**
 * The wall height (to the eaves) and the roof. OSM's `height` is to the top of the roof;
 * `building:levels` counts the storeys under it, the ground floor a little taller. Untagged
 * blocks get 15–21 m, the inner districts' typical five or six storeys.
 */
export function shapeOf(p: Record<string, string | undefined>, area: number, u: number): Shape {
  const t = p.building ?? "yes";
  const shape = p["roof:shape"];
  const rl = num(p["roof:levels"]);
  const roofLevels = Number.isFinite(rl) ? rl : 0;
  let kind: RoofKind;
  if (shape === "flat") kind = "flat";
  else if (shape === "mansard" || shape === "gambrel") kind = "mansard";
  else if (shape === "dome" || shape === "cone" || shape === "pyramidal" || CHURCH.has(t)) kind = "steep";
  else if (shape) kind = "pitched";
  else if (MODERN.has(t) || SMALL.has(t) || (t === "yes" && area > 3000)) kind = "flat";
  else kind = roofLevels >= 1 ? "mansard" : "pitched";

  const h = num(p.height);
  const lv = num(p["building:levels"]);
  let eave: number;
  let source: "height" | "levels" | "default";
  if (Number.isFinite(h) && h > 0) {
    source = "height";
    eave = kind === "flat" ? h : h - Math.min(kind === "steep" ? h * 0.35 : 5, h * 0.3);
  } else if (Number.isFinite(lv) && lv > 0) {
    source = "levels";
    eave = lv * LEVEL + 1.2;
  } else {
    source = "default";
    if (SMALL.has(t)) eave = 3.2;
    else if (HOUSE.has(t)) eave = 6.5 + 2 * u;
    else if (t === "ruins") eave = 4;
    else if (CHURCH.has(t)) eave = 14;
    else if (t === "industrial" || t === "warehouse") eave = 9;
    // Small untagged footprints are kiosks, pavilions and sheds rather than blocks of flats.
    else if (area < 90) eave = 3.5 + 1.5 * u;
    else if (area < 220) eave = 7 + 4 * u;
    else eave = 15 + 6 * u;
  }
  if (kind !== "flat" && eave > 34) kind = "flat";
  return { eave: Math.min(Math.max(eave, 2.5), 120), kind, roofLevels, source };
}

// --- Palettes ---------------------------------------------------------------------------------

export type RGB = [number, number, number];
export const hex = (s: string): RGB => [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];
// Budapest's plaster: ochres, creams, greys and the odd pastel, aged.
export const WALLS = {
  pest: ["#d9c9a8", "#cdb48c", "#e0d4b8", "#c8a984", "#d4bfa0", "#bfa98a", "#d8bf98", "#c9b79c", "#b9ab98", "#d6c6b2", "#c4b08f", "#a99a86", "#d8c2a2", "#cbbfae"].map(hex),
  buda: ["#d8cdb5", "#c9b99c", "#bfae8f", "#d1c4a6", "#ddd3bf", "#cfc0a2", "#e3d3a6", "#d3b98f"].map(hex),
  castle: ["#e2d8c2", "#d5c7a6", "#cbbd9d", "#e6dcc8", "#e8d6a8"].map(hex),
  modern: ["#b8b5ae", "#a9aaa6", "#c2bfb7", "#b3aea4", "#9fa3a6"].map(hex),
};
// Roofs from the air: weathered red-brown tile, dark slate and eternit, painted tin, copper.
export const ROOFS = {
  tile: ["#9a5b45", "#8c4f3d", "#a86a4f", "#94604b", "#7f4c3c", "#a5644a", "#8a5a47"].map(hex),
  slate: ["#5d5f63", "#6b6d70", "#545a60", "#626466", "#4f5458"].map(hex),
  tin: ["#6f6a62", "#5f6660", "#7a7468", "#5a5f62"].map(hex),
  copper: ["#6f9384", "#7a9d8c"].map(hex),
  flat: ["#8f8d88", "#9c9a94", "#85827c", "#a5a29b"].map(hex),
};
export const TRIM = {
  chimney: ["#a86a50", "#b8a68e", "#9a6048", "#c2b39c"].map(hex),
  unit: ["#9da0a0", "#b2b2ae", "#8d9091"].map(hex),
};
export const pick = <T>(list: T[], u: number) => list[Math.min(list.length - 1, Math.floor(u * list.length))];

/** The roof's covering, by its kind, the bank (Buda's are more often tiled) and a random `u`. */
export function roofCovering(kind: RoofKind, buda: boolean, u: number): keyof typeof ROOFS {
  if (kind === "flat") return "flat";
  if (kind === "steep") return u < 0.6 ? "slate" : "copper";
  if (kind === "mansard") return u < 0.7 ? "slate" : u < 0.9 ? "tin" : "copper";
  return u < (buda ? 0.72 : 0.55) ? "tile" : u < 0.85 ? "slate" : "tin";
}

// --- Facade styles ------------------------------------------------------------------------------

export const F = Object.fromEntries(TEXTURES.facades.map((name, i) => [name, i])) as Record<string, number>;
/** Layers in the runtime's surface array: TEXTURES.facades, then TEXTURES.roofs. */
export const ROOF_LAYER = { tile: 8, slate: 9, copper: 10, flat: 11, tin: 9 };
/** Plain surfaces outside the texture array: trim (cornices, chimneys, parapets) and blank firewalls. */
export const LAYER_TRIM = 14;
export const LAYER_FIREWALL = 15;
const PANEL_DISTRICTS = new Set(["III. kerület", "XIII. kerület", "XI. kerület"]);
/** Which of the eight facade tiles a building wears, by type, district, height and bank. */
export function facadeOf(type: string, district: string, height: number, castle: boolean, u: number): number {
  if (MODERN.has(type) || height > 32) return F.modern;
  if (SMALL.has(type) || HOUSE.has(type)) return F.villa;
  if (castle) return F.castle;
  if (PANEL_DISTRICTS.has(district) && height >= 18 && (type === "apartments" || type === "residential" || type === "yes") && u < 0.4) return F.panel;
  if (BUDA.has(district)) return height < 14 ? F.budaBaroque : u < 0.7 ? F.pestEclectic : F.pestClassic;
  if (height < 9) return F.villa;
  if (u < 0.16) return F.secession;
  return district === "V. kerület" ? (u < 0.6 ? F.pestClassic : F.pestEclectic) : u < 0.3 ? F.pestClassic : F.pestEclectic;
}

// --- Roof profiles ----------------------------------------------------------------------------------

/** Each block's pitch and cap (from its key), so neighbours share one roofline. */
export const blockPitch = (key: string) => [34, 37, 40, 43][Math.floor(hash01(`${key}:pitch`) * 4)];
export const blockCap = (key: string) => 4.2 + 1.6 * hash01(`${key}:cap`);
/** The roof's section for a building of `wallH` metres in block `key`, or null for a flat roof. */
export function profileFor(kind: RoofKind, wallH: number, roofLevels: number, key: string): Profile | null {
  if (kind === "flat") return null;
  if (kind === "steep") return pitched(52, Math.round(Math.min(12, wallH * 0.45)));
  if (kind === "mansard") {
    const rl = Math.max(1, Math.min(2, Math.round(roofLevels || 1)));
    return mansard(2.4 * rl + 0.4, 2.6 * rl + 1.6);
  }
  return pitched(blockPitch(key), Math.round(blockCap(key) * 2) / 2);
}

// --- Street canyons -------------------------------------------------------------------------------

/** Baked occlusion reaches this far across a street; its values are stored in units of CANYON_UNIT. */
export const CANYON_OPEN = 96;
export const CANYON_UNIT = 128;
export const OPEN: [number, number] = [CANYON_OPEN, 0];

/**
 * Baked occlusion: from a point at the foot of a street wall, the first building straight out
 * along its normal (within CANYON_OPEN metres) and how high its eaves stand above this wall's
 * base. The shader turns the angle to that skyline into ambient occlusion up the wall, so
 * narrow streets and courtyards darken toward the ground. `step` is the march's stride.
 */
export function canyonProbe(buildings: { poly: Polygon; eave: number; kind: RoofKind }[], step = 0.8): (x: number, z: number, nx: number, nz: number, self: number, base: number) => [number, number] {
  const GRID = 20;
  const byCell = new Map<number, number[]>();
  buildings.forEach((bd, i) => {
    const bx = ringBox(bd.poly[0]);
    for (let gx = Math.floor(bx.minX / GRID); gx <= Math.floor(bx.maxX / GRID); gx++)
      for (let gz = Math.floor(bx.minZ / GRID); gz <= Math.floor(bx.maxZ / GRID); gz++) {
        const key = gx * 100003 + gz;
        const list = byCell.get(key);
        if (list) list.push(i);
        else byCell.set(key, [i]);
      }
  });
  return (x, z, nx, nz, self, base) => {
    for (let t = 0.6; t < CANYON_OPEN; t += step) {
      const px = x + nx * t;
      const pz = z + nz * t;
      for (const i of byCell.get(Math.floor(px / GRID) * 100003 + Math.floor(pz / GRID)) ?? []) {
        if (i === self) continue;
        const o = buildings[i];
        if (pointInPolygon(o.poly, px, pz)) return [t, o.eave + (o.kind === "flat" ? 0.9 : 2.5) - base];
      }
      // A courtyard: the far side of this building's own ring.
      if (t > 1.5 && pointInPolygon(buildings[self].poly, px, pz)) return [t, buildings[self].eave + 2.5 - base];
    }
    return OPEN;
  };
}
