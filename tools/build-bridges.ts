// Step 4: the five Danube bridges in the world. Deck outlines, river piers and tower positions
// come from OpenStreetMap (man_made=bridge areas, bridge:support=pier|pylon); deck heights,
// tower heights and the ironwork style are set below, by hand, until M4's hero models.
// Writes public/data/bridges.json. Usage: npm run build-bridges

import polygonClipping, { type MultiPolygon as PCMulti } from "polygon-clipping";
import { latLonToLocal } from "../src/geo";
import type { BridgeJson, BridgesJson } from "../src/world/bridges";
import { River, type RiverJson } from "../src/world/river";
import { centroid, minAreaRect, projectPolygons, round2, signedArea, simplifyRing, type Polygon, type Pt } from "./lib/geom";
import { kb, ODBL, readData, readOsm, writeData } from "./lib/io";

interface Style {
  osm: string;
  name: string;
  /** Road centreline across the river, Buda to Pest (from the OSM road ways; orients towers and cables). */
  axis: [number, number][];
  top: number;
  thickness: number;
  color: string;
  deckColor: string;
  towers?: { height: number; along: number; thick: number; at: "pylons" | "banks" };
  /** Extra piers every this many metres over water, where OSM maps none nearby. */
  piersEvery?: number;
  cables?: "chain" | "suspension" | "truss";
}

const STYLES: Style[] = [
  { osm: "way/197112157", name: "Árpád Bridge", axis: [[47.53918, 19.04654], [47.5363, 19.05849]], top: 12, thickness: 2, color: "#8f918c", deckColor: "#7d7f7a", piersEvery: 70 },
  { osm: "relation/20407774", name: "Margaret Bridge", axis: [[47.51471, 19.0386], [47.51478, 19.04352], [47.51329, 19.04779]], top: 11, thickness: 2, color: "#b9b07a", deckColor: "#a49c6c" },
  { osm: "way/197110386", name: "Chain Bridge", axis: [[47.49846, 19.04101], [47.49951, 19.04642]], top: 11.5, thickness: 2, color: "#cdbf9d", deckColor: "#5f5c55", towers: { height: 48, along: 12, thick: 7, at: "pylons" }, cables: "chain" },
  { osm: "way/197376889", name: "Elisabeth Bridge", axis: [[47.4901, 19.04694], [47.49085, 19.04904], [47.49182, 19.05185], [47.49214, 19.05285]], top: 12.5, thickness: 2.5, color: "#ecebe6", deckColor: "#d9d8d2", towers: { height: 38, along: 6, thick: 5, at: "banks" }, cables: "suspension" },
  { osm: "way/197315957", name: "Liberty Bridge", axis: [[47.48479, 19.05318], [47.48661, 19.05673]], top: 12, thickness: 2, color: "#4e7f5d", deckColor: "#45705a", towers: { height: 27, along: 3, thick: 3, at: "pylons" }, cables: "truss" },
];

const river = new River(readData<RiverJson>("river.json"));
const osm = readOsm("bridges");
const byId = new Map(osm.map((f) => [f.properties.id, f]));
const supports = osm.filter((f) => f.properties["bridge:support"]);
const supportRing = (f: (typeof osm)[number]): Pt[] => {
  const g = f.geometry;
  const coords = (g.type === "Polygon" ? (g.coordinates as number[][][])[0] : (g.coordinates as number[][])) as number[][];
  return projectPolygons({ type: "Polygon", coordinates: [coords] })[0][0];
};

const flat = (r: Pt[]) => r.flatMap((p) => [round2(p[0]), round2(p[1])]);
const out: BridgeJson[] = [];
for (const s of STYLES) {
  const f = byId.get(s.osm);
  if (!f) throw new Error(`${s.name}: ${s.osm} is not in tools/osm/bridges.geojson`);
  // The outline, as one ring (Margaret Bridge is two touching areas in OSM).
  let union: PCMulti = [];
  for (const p of projectPolygons(f.geometry)) union = polygonClipping.union(union, [p.map((r) => [...r, r[0]] as [number, number][])]);
  const outlines: Polygon[] = union.map((p) => p.map((r) => simplifyRing(r.slice(0, -1) as Pt[], 0.5)));
  const outline = outlines.sort((p, q) => Math.abs(signedArea(q[0])) - Math.abs(signedArea(p[0])))[0][0];
  if (signedArea(outline) < 0) outline.reverse();

  const axis = s.axis.map((p) => {
    const l = latLonToLocal(p);
    return [l.x, l.z] as Pt;
  });
  // Unit direction of the axis segment nearest a point.
  const dirAt = (x: number, z: number) => {
    let best = Infinity;
    let dir = { ux: 1, uz: 0 };
    for (let i = 0; i < axis.length - 1; i++) {
      const [ax, az] = axis[i];
      const ex = axis[i + 1][0] - ax;
      const ez = axis[i + 1][1] - az;
      const l = Math.hypot(ex, ez);
      const t = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / (l * l)));
      const d = Math.hypot(ax + ex * t - x, az + ez * t - z);
      if (d < best) {
        best = d;
        dir = { ux: ex / l, uz: ez / l };
      }
    }
    return dir;
  };
  const inOutline = (x: number, z: number) => {
    let inside = false;
    for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
      const [xi, zi] = outline[i];
      const [xj, zj] = outline[j];
      if (zi <= z !== zj <= z && x < xi + ((z - zi) / (zj - zi)) * (xj - xi)) inside = !inside;
    }
    return inside;
  };

  // Width: the median distance across the outline, measured over water every 10 m along the axis.
  const widths: number[] = [];
  for (let i = 0; i < axis.length - 1; i++) {
    const [ax, az] = axis[i];
    const ex = axis[i + 1][0] - ax;
    const ez = axis[i + 1][1] - az;
    const l = Math.hypot(ex, ez);
    for (let d = 5; d < l; d += 10) {
      const x = ax + (ex / l) * d;
      const z = az + (ez / l) * d;
      if (!river.isWater(x, z)) continue;
      let w = 0;
      for (const side of [-1, 1]) {
        let k = 0;
        while (k < 80 && inOutline(x - (ez / l) * side * (k + 0.25), z + (ex / l) * side * (k + 0.25))) k += 0.25;
        w += k;
      }
      if (w > 2) widths.push(w);
    }
  }
  widths.sort((p, q) => p - q);
  const width = widths.length ? widths[Math.floor(widths.length / 2)] : 20;

  // River piers: OSM pier outlines whose centre lies inside the deck outline (or within 15 m of it).
  const piers: BridgeJson["piers"] = [];
  const pylons: Pt[] = [];
  for (const sf of supports) {
    const ring = supportRing(sf);
    const c = centroid(ring);
    if (!inOutline(c[0], c[1])) {
      // Supports drawn slightly outside the deck outline still belong to it.
      let near = false;
      for (let i = 0, j = outline.length - 1; i < outline.length && !near; j = i++) {
        const [xi, zi] = outline[i];
        const [xj, zj] = outline[j];
        const ex = xi - xj;
        const ez = zi - zj;
        const t = Math.min(1, Math.max(0, ((c[0] - xj) * ex + (c[1] - zj) * ez) / (ex * ex + ez * ez || 1)));
        near = Math.hypot(xj + ex * t - c[0], zj + ez * t - c[1]) < 15;
      }
      if (!near) continue;
    }
    if (sf.properties["bridge:support"] === "pylon") pylons.push(c);
    const r = minAreaRect(ring);
    piers.push({ cx: round2(r.cx), cz: round2(r.cz), ux: round2(r.ux * 1000) / 1000, uz: round2(r.uz * 1000) / 1000, halfU: round2(Math.max(r.halfU, 3)), halfV: round2(Math.max(r.halfV, 3)) });
  }
  if (s.piersEvery) {
    for (let i = 0; i < axis.length - 1; i++) {
      const [ax, az] = axis[i];
      const ex = axis[i + 1][0] - ax;
      const ez = axis[i + 1][1] - az;
      const l = Math.hypot(ex, ez);
      for (let d = s.piersEvery; d < l; d += s.piersEvery) {
        const x = ax + (ex / l) * d;
        const z = az + (ez / l) * d;
        if (!river.isWater(x, z) || river.nearestBank(x, z, 12)) continue;
        if (piers.some((p) => Math.hypot(p.cx - x, p.cz - z) < 35)) continue;
        // Long side across the deck, like the mapped piers.
        piers.push({ cx: round2(x), cz: round2(z), ux: round2((-ez / l) * 1000) / 1000, uz: round2((ex / l) * 1000) / 1000, halfU: round2(width / 2 + 2), halfV: 4.5 });
      }
    }
  }

  // Towers: on the mapped pylons, or where the deck meets each bank.
  const towers: BridgeJson["towers"] = [];
  if (s.towers?.at === "pylons") for (const p of pylons) towers.push({ x: round2(p[0]), z: round2(p[1]), ...dirAt(p[0], p[1]) });
  if (s.towers?.at === "banks") {
    const pts: Pt[] = [];
    for (let i = 0; i < axis.length - 1; i++) {
      const [ax, az] = axis[i];
      const ex = axis[i + 1][0] - ax;
      const ez = axis[i + 1][1] - az;
      const l = Math.hypot(ex, ez);
      for (let d = 0; d < l; d += 2) pts.push([ax + (ex / l) * d, az + (ez / l) * d]);
    }
    const first = pts.findIndex((p) => river.isWater(p[0], p[1]));
    const last = pts.length - 1 - [...pts].reverse().findIndex((p) => river.isWater(p[0], p[1]));
    for (const k of [first - 4, last + 4]) towers.push({ x: round2(pts[k][0]), z: round2(pts[k][1]), ...dirAt(pts[k][0], pts[k][1]) });
  }

  out.push({
    name: s.name,
    osm: s.osm,
    outline: flat(outline),
    axis: flat(axis),
    width: round2(width),
    top: s.top,
    thickness: s.thickness,
    ramp: 60,
    color: s.color,
    deckColor: s.deckColor,
    towers: towers.map((t) => ({ ...t, ux: round2(t.ux * 1000) / 1000, uz: round2(t.uz * 1000) / 1000 })),
    tower: s.towers ? { height: s.towers.height, along: s.towers.along, thick: s.towers.thick } : undefined,
    piers,
    cables: s.cables,
  });
  console.log(`${s.name.padEnd(17)} outline ${outline.length} pts, width ${width.toFixed(1)} m, ${piers.length} piers, ${towers.length} towers`);
}

const json: BridgesJson = { license: ODBL, bridges: out };
console.log(`bridges.json ${kb(writeData("bridges.json", json))}`);
