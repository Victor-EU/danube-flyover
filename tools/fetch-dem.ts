// Fetches the Copernicus GLO-30 DEM window over the world (plus a margin) from the public
// cloud-optimised GeoTIFF on AWS, reading only the needed tiles, and caches it in tools/dem/
// so build-terrain runs offline. Heights are metres above sea level (EGM2008).
// Usage: npm run fetch-dem

import { mkdirSync, writeFileSync } from "node:fs";
import { fromUrl } from "geotiff";
import { WORLD } from "../src/config";

const TILE = "Copernicus_DSM_COG_10_N47_00_E019_00_DEM";
const URL_ = `https://copernicus-dem-30m.s3.amazonaws.com/${TILE}/${TILE}.tif`;
const PAD = 0.01; // about 1 km: room for the blur and opening filters at the world edge

const tiff = await fromUrl(URL_);
const img = await tiff.getImage();
const [ox, oy] = img.getOrigin();
const [rx, ry] = img.getResolution();
const lon0 = WORLD.lonMin - PAD;
const lon1 = WORLD.lonMax + PAD;
const lat0 = WORLD.latMin - PAD;
const lat1 = WORLD.latMax + PAD;
const x0 = Math.floor((lon0 - ox) / rx);
const x1 = Math.ceil((lon1 - ox) / rx);
const y0 = Math.floor((lat1 - oy) / ry);
const y1 = Math.ceil((lat0 - oy) / ry);
const rasters = await img.readRasters({ window: [x0, y0, x1, y1] });
const data = Float32Array.from(rasters[0] as ArrayLike<number>);

const out = new URL("./dem/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("glo30.bin", out), Buffer.from(data.buffer));
const meta = {
  source: URL_,
  license: "Copernicus DEM GLO-30, © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. Free licence: https://spacedata.copernicus.eu/documents/20123/121286/CSCDA_ESA_Mission-specific+Annex_31_Oct_22.pdf",
  format: "Float32 little-endian, row-major, north row first; metres above sea level",
  width: x1 - x0,
  height: y1 - y0,
  /** Lon/lat of the centre of the top-left pixel (the tile is PixelIsPoint), and degrees per pixel. */
  west: ox + x0 * rx,
  north: oy + y0 * ry,
  dlon: rx,
  dlat: -ry,
};
writeFileSync(new URL("glo30.json", out), JSON.stringify(meta, null, 2) + "\n");
console.log(`GLO-30 window ${meta.width} × ${meta.height} px, ${(data.byteLength / 1024).toFixed(0)} KB`);
