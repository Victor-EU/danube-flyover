// Fetches Copernicus GLO-30 DEM windows from the public cloud-optimised GeoTIFFs on AWS, reading
// only the needed tiles (HTTP range requests), and caches them in tools/dem/ so the pipeline
// runs offline. Heights are metres above sea level (EGM2008).
//   glo30.bin   the world plus a 1 km margin, 1″ (about 30 m), Float32 (build-terrain)
//   far.bin     the far field's OSM box (FAR.box), 1″, Int16 decimetres (build-far)
//   wide.bin    FAR.wide, 4″ (about 120 m), Int16 decimetres, for the hills beyond the box
// A window may span the 1° tiles: each pixel is read from the tile that holds it.
// Usage: npm run fetch-dem [-- far]   (default: the world window; `far` adds far and wide)

import { mkdirSync, writeFileSync } from "node:fs";
import { fromUrl, type GeoTIFF } from "geotiff";
import { FAR, WORLD } from "../src/config";

const OUT = new URL("./dem/", import.meta.url);
const LICENSE =
  "Copernicus DEM GLO-30, © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. Free licence: https://spacedata.copernicus.eu/documents/20123/121286/CSCDA_ESA_Mission-specific+Annex_31_Oct_22.pdf";
const tileName = (lat: number, lon: number) => `Copernicus_DSM_COG_10_N${String(lat).padStart(2, "0")}_00_E${String(lon).padStart(3, "0")}_00_DEM`;
const tileUrl = (name: string) => `https://copernicus-dem-30m.s3.amazonaws.com/${name}/${name}.tif`;

interface Window {
  /** Lon/lat of the centre of the top-left pixel, degrees per pixel, size. */
  west: number;
  north: number;
  dlon: number;
  dlat: number;
  width: number;
  height: number;
  data: Float32Array;
}

const tiffs = new Map<string, Promise<GeoTIFF>>();
const open = (name: string) => {
  if (!tiffs.has(name)) tiffs.set(name, fromUrl(tileUrl(name)));
  return tiffs.get(name)!;
};

/** The DEM over a lon/lat box at `step` arc seconds, mosaicked from the 1° tiles it touches. */
async function window(box: { latMin: number; latMax: number; lonMin: number; lonMax: number }, step: number): Promise<Window> {
  const d = step / 3600;
  // Pixel centres on whole multiples of the step, like the tiles' own (PixelIsPoint) grid.
  const west = Math.floor(box.lonMin / d) * d;
  const north = Math.ceil(box.latMax / d) * d;
  const width = Math.ceil((box.lonMax - west) / d) + 1;
  const height = Math.ceil((north - box.latMin) / d) + 1;
  const data = new Float32Array(width * height).fill(NaN);
  for (let lat = Math.floor(box.latMin); lat <= Math.floor(box.latMax); lat++)
    for (let lon = Math.floor(box.lonMin); lon <= Math.floor(box.lonMax); lon++) {
      const name = tileName(lat, lon);
      const tiff = await open(name);
      // The part of the output inside this tile, as output columns and rows.
      // A pixel on a tile edge belongs to the tile east (or south) of it.
      const first = (k: number) => Math.ceil(k - 1e-6);
      const c0 = Math.max(0, first((lon - west) / d));
      const c1 = Math.min(width - 1, first((lon + 1 - west) / d) - 1);
      const r0 = Math.max(0, first((north - (lat + 1)) / d) + 1);
      const r1 = Math.min(height - 1, first((north - lat) / d));
      if (c1 < c0 || r1 < r0) continue;
      const bw = c1 - c0 + 1;
      const bh = r1 - r0 + 1;
      // Read the tile over those pixels' extent at their resolution (geotiff picks an overview).
      const rasters = await tiff.readRasters({
        bbox: [west + (c0 - 0.5) * d, north - (r1 + 0.5) * d, west + (c1 + 0.5) * d, north - (r0 - 0.5) * d],
        width: bw,
        height: bh,
        resampleMethod: "bilinear",
      });
      const band = rasters[0] as ArrayLike<number>;
      for (let r = 0; r < bh; r++) for (let c = 0; c < bw; c++) data[(r0 + r) * width + c0 + c] = band[r * bw + c];
      console.log(`  ${name}: ${bw} × ${bh} px`);
    }
  // A read reaching half a pixel past a tile's edge comes back as 0 there (nothing here is
  // at sea level): fill those pixels from their neighbours.
  let missing = 0;
  for (let pass = 0; pass < 4; pass++) {
    missing = 0;
    for (let r = 0; r < height; r++)
      for (let c = 0; c < width; c++) {
        const k = r * width + c;
        if (data[k] > 1) continue;
        let sum = 0;
        let n = 0;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const cc = c + dc;
          const rr = r + dr;
          if (cc < 0 || rr < 0 || cc >= width || rr >= height) continue;
          const v = data[rr * width + cc];
          if (v > 1) (sum += v), n++;
        }
        if (n) data[k] = sum / n;
        else missing++;
      }
  }
  if (missing) throw new Error(`${missing} pixels not covered`);
  return { west, north, dlon: d, dlat: d, width, height, data };
}

function save(name: string, w: Window, int16: boolean, source: string[]): void {
  const bytes = int16 ? Buffer.from(Int16Array.from(w.data, (v) => Math.round(v * 10)).buffer) : Buffer.from(w.data.buffer);
  writeFileSync(new URL(`${name}.bin`, OUT), bytes);
  const meta = {
    source: source.length === 1 ? source[0] : source,
    license: LICENSE,
    format: int16 ? "Int16 little-endian decimetres, row-major, north row first; above sea level" : "Float32 little-endian, row-major, north row first; metres above sea level",
    width: w.width,
    height: w.height,
    /** Lon/lat of the centre of the top-left pixel, and degrees per pixel. */
    west: w.west,
    north: w.north,
    dlon: w.dlon,
    dlat: w.dlat,
  };
  writeFileSync(new URL(`${name}.json`, OUT), JSON.stringify(meta, null, 2) + "\n");
  console.log(`${name}: ${w.width} × ${w.height} px, ${(bytes.length / 1024).toFixed(0)} KB`);
}

const sources = (box: { lonMin: number; lonMax: number; latMin: number; latMax: number }) => {
  const out: string[] = [];
  for (let lat = Math.floor(box.latMin); lat <= Math.floor(box.latMax); lat++) for (let lon = Math.floor(box.lonMin); lon <= Math.floor(box.lonMax); lon++) out.push(tileUrl(tileName(lat, lon)));
  return out;
};

mkdirSync(OUT, { recursive: true });
if (process.argv.includes("far")) {
  save("far", await window(FAR.box, 1), true, sources(FAR.box));
  save("wide", await window(FAR.wide, 4), true, sources(FAR.wide));
} else {
  // About 1 km: room for build-terrain's blur and opening filters at the world edge.
  const PAD = 0.01;
  const box = { lonMin: WORLD.lonMin - PAD, lonMax: WORLD.lonMax + PAD, latMin: WORLD.latMin - PAD, latMax: WORLD.latMax + PAD };
  save("glo30", await window(box, 1), false, sources(box));
}
