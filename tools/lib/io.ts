// File helpers for the pipeline: the committed OSM extracts in, public/data/ out.

import { readFileSync, writeFileSync } from "node:fs";

export const OSM_DIR = new URL("../osm/", import.meta.url);
export const DATA_DIR = new URL("../../public/data/", import.meta.url);

export interface OsmFeature {
  properties: Record<string, string | undefined> & { id: string };
  geometry: { type: string; coordinates: unknown };
}

export function readOsm(group: string): OsmFeature[] {
  const fc = JSON.parse(readFileSync(new URL(`${group}.geojson`, OSM_DIR), "utf8")) as { features: OsmFeature[] };
  return fc.features;
}

export function readData<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, DATA_DIR), "utf8")) as T;
}

export function readDataBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, DATA_DIR)));
}

/** Writes JSON with one top-level entry per line (diff-friendly, still compact). */
export function writeData(name: string, value: unknown): number {
  let text: string;
  if (Array.isArray(value)) text = `[\n${value.map((v) => JSON.stringify(v)).join(",\n")}\n]\n`;
  else if (value && typeof value === "object")
    text = `{\n${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(",\n")}\n}\n`;
  else text = JSON.stringify(value);
  writeFileSync(new URL(name, DATA_DIR), text);
  return text.length;
}

export function writeDataBytes(name: string, bytes: Uint8Array): number {
  writeFileSync(new URL(name, DATA_DIR), bytes);
  return bytes.byteLength;
}

export const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

export const ODBL = "Contains OpenStreetMap data, © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)";
export const COPERNICUS = "Contains modified Copernicus DEM GLO-30 data, © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA";
