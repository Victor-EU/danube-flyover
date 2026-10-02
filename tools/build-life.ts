// Step 8: the paths the ambient life follows that need OpenStreetMap: the embankment tram
// lines (tram 2 on the Pest quay, trams 19 and 41 along the Buda bank). The OSM tram ways
// carry no line numbers, so each line is traced as the band of track that runs alongside a
// main bank: every track point is measured along and off the bank, binned every 8 m, and the
// longest unbroken run becomes the line. The tour boats need only the river (at runtime).
// Writes public/data/life.json. Usage: npm run build-life

import { WORLD } from "../src/config";
import { decodeGrid } from "../src/world/gridFile";
import { River, type RiverJson } from "../src/world/river";
import { Terrain } from "../src/world/terrain";
import { projectPolygons, simplifyLine, type Pt } from "./lib/geom";
import { kb, ODBL, readData, readDataBytes, readOsm, writeData } from "./lib/io";

const river = new River(readData<RiverJson>("river.json"));
const terrain = new Terrain(decodeGrid(readDataBytes("terrain.bin")));
const tracks: Pt[] = [];
for (const f of readOsm("trams")) {
  if (f.geometry.type !== "LineString") continue;
  const line = projectPolygons({ type: "Polygon", coordinates: [f.geometry.coordinates as number[][]] })[0][0];
  // Densify, so long straight ways weigh as much as short curved ones.
  for (let i = 0; i < line.length - 1; i++) {
    const [a, b] = [line[i], line[i + 1]];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let d = 0; d < l; d += 4) tracks.push([a[0] + ((b[0] - a[0]) * d) / l, a[1] + ((b[1] - a[1]) * d) / l]);
  }
}

// The two main banks: the longest open bank lines, east (Pest) and west (Buda).
const banks = river.banks
  .filter((b) => !(b[0] === b[b.length - 2] && b[1] === b[b.length - 1]))
  .sort((p, q) => q.length - p.length)
  .slice(0, 2)
  .map((b) => {
    const pts: Pt[] = [];
    for (let i = 0; i < b.length; i += 2) pts.push([b[i], b[i + 1]]);
    return pts;
  });
const meanX = (b: Pt[]) => b.reduce((s, p) => s + p[0], 0) / b.length;
banks.sort((p, q) => meanX(q) - meanX(p)); // Pest (east) first

const BIN = 8;
const lines: { name: string; path: number[] }[] = [];
for (const [k, bank] of banks.entries()) {
  const name = k === 0 ? "Pest embankment (tram 2)" : "Buda embankment (trams 19 and 41)";
  const maxOff = k === 0 ? 70 : 110;
  const cum = [0];
  for (let i = 1; i < bank.length; i++) cum.push(cum[i - 1] + Math.hypot(bank[i][0] - bank[i - 1][0], bank[i][1] - bank[i - 1][1]));
  const bins = new Map<number, number[]>();
  for (const [x, z] of tracks) {
    let best = Infinity;
    let s = 0;
    let off = 0;
    for (let i = 0; i < bank.length - 1; i++) {
      const [a, b] = [bank[i], bank[i + 1]];
      const ex = b[0] - a[0];
      const ez = b[1] - a[1];
      const l2 = ex * ex + ez * ez || 1;
      const u = Math.min(1, Math.max(0, ((x - a[0]) * ex + (z - a[1]) * ez) / l2));
      const d = Math.hypot(a[0] + ex * u - x, a[1] + ez * u - z);
      if (d < best) (best = d), (s = cum[i] + u * Math.sqrt(l2)), (off = d);
    }
    if (off < 8 || off > maxOff || river.isWater(x, z)) continue;
    const key = Math.floor(s / BIN);
    (bins.get(key) ?? bins.set(key, []).get(key)!).push(off);
  }
  // The longest run of bins with track, allowing gaps of up to 3 bins (bridgeheads, stops).
  const keys = [...bins.keys()].sort((a, b) => a - b);
  let best: number[] = [];
  let run: number[] = [];
  for (const key of keys) {
    if (run.length && key - run[run.length - 1] > 4) run = [];
    run.push(key);
    if (run.length > best.length) best = [...run];
  }
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const offs = new Map(best.map((key) => [key, median(bins.get(key)!)]));
  const pts: Pt[] = [];
  for (let key = best[0]; key <= best[best.length - 1]; key++) {
    // Smoothed offset over neighbouring bins with track.
    let sum = 0;
    let n = 0;
    for (let d = -4; d <= 4; d++) if (offs.has(key + d)) (sum += offs.get(key + d)!), n++;
    const off = sum / n;
    const s = (key + 0.5) * BIN;
    let i = cum.findIndex((c) => c > s) - 1;
    if (i < 0) i = bank.length - 2;
    const [a, b] = [bank[i], bank[i + 1]];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u = (s - cum[i]) / l;
    let nx = -(b[1] - a[1]) / l;
    let nz = (b[0] - a[0]) / l;
    const px = a[0] + (b[0] - a[0]) * u;
    const pz = a[1] + (b[1] - a[1]) * u;
    if (river.isWater(px + nx * 5, pz + nz * 5)) (nx = -nx), (nz = -nz); // inland
    pts.push([px + nx * off, pz + nz * off]);
  }
  const simple = simplifyLine(pts, 1.5);
  const path: number[] = [];
  for (const [x, z] of simple) path.push(Math.round(x * 10) / 10, Math.round((Math.max(terrain.heightAt(x, z), WORLD.quayHeight) + 0.05) * 10) / 10, Math.round(z * 10) / 10);
  const len = simple.slice(1).reduce((s2, p, i) => s2 + Math.hypot(p[0] - simple[i][0], p[1] - simple[i][1]), 0);
  console.log(`${name}: ${(len / 1000).toFixed(2)} km, ${simple.length} points`);
  lines.push({ name, path });
}

const size = writeData("life.json", { license: ODBL, note: "Tram lines along the embankments, flat [x, y, z, ...] in local metres (tools/build-life.ts).", trams: lines });
console.log(`life.json ${kb(size)}`);
