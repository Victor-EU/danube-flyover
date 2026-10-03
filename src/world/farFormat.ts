// The far field's buildings file, far/buildings.bin: written by tools/build-far.ts, read by the
// runtime's worker (farWorker.ts), which extrudes it. No three.js here: the worker loads it.
//
// zlib( "DFB1" magic, u32 header length, JSON header, padding to 4, body ). The header lists
// the tiles (FAR_TILE metres square): their origin and where their buildings start in the
// body. Each building is
//   int16 base (decimetres above the river), uint16 eave height above the base (dm),
//   uint8 roof rise (in 0.2 m: a hipped roof's ridge above the eaves; 0 is flat),
//   uint8 wall colour, uint8 roof colour, uint8 point count n,
//   n × (int16 x, int16 z) in 0.2 m from the tile's origin, the ring counter-clockwise
//   (x, z axes); bit 0 of x set means the wall from this point to the next isn't drawn (it's
//   a party wall, shared with a neighbour of about the same height).

import { unzlibSync, zlibSync } from "fflate";

export const FAR_TILE = 1000;
const MAGIC = 0x31424644; // "DFB1"

/** sRGB colours, indexed by the file's wall and roof bytes (as their own palettes). */
export const FAR_WALLS = [
  // Pest's plaster: ochres, creams and greys
  "#d9c9a8", "#cdb48c", "#e0d4b8", "#c8a984", "#d4bfa0", "#bfa98a", "#d8bf98", "#c9b79c", "#b9ab98", "#d6c6b2",
  // Buda's paler plaster
  "#d8cdb5", "#c9b99c", "#bfae8f", "#d1c4a6", "#ddd3bf", "#cfc0a2",
  // modern: concrete, render, glass and steel
  "#b8b5ae", "#a9aaa6", "#c2bfb7", "#b3aea4", "#9fa3a6", "#8f979c", "#c9c6bd",
  // industrial sheds and brick
  "#9c968c", "#a88b72", "#8e8a82",
];
export const FAR_WALL_GROUPS = { pest: [0, 10], buda: [10, 16], modern: [16, 23], industrial: [23, 26] } as const;
export const FAR_ROOFS = [
  // tile
  "#9a5b45", "#8c4f3d", "#a86a4f", "#94604b", "#7f4c3c", "#a5644a",
  // slate, eternit and tin
  "#5d5f63", "#6b6d70", "#545a60", "#6f6a62", "#5f6660",
  // flat: bitumen, gravel and membranes
  "#8f8d88", "#9c9a94", "#85827c", "#a5a29b", "#76746f",
  // copper
  "#6f9384",
];
export const FAR_ROOF_GROUPS = { tile: [0, 6], slate: [6, 11], flat: [11, 16], copper: [16, 17] } as const;

export interface FarBuilding {
  base: number;
  eave: number;
  rise: number;
  wall: number;
  roof: number;
  /** Ring in local metres, counter-clockwise in (x, z); `hidden[i]`: the wall from point i to i + 1 is a party wall. */
  ring: [number, number][];
  hidden: boolean[];
}

export interface FarTile {
  /** World position of the tile's origin (its north-west corner), metres. */
  x: number;
  z: number;
  count: number;
  offset: number;
}

export interface FarHeader {
  tile: number;
  tiles: FarTile[];
  license?: string[];
}

export function encodeFarBuildings(tiles: { x: number; z: number; buildings: FarBuilding[] }[], extra: Record<string, unknown> = {}): Uint8Array {
  let size = 0;
  for (const t of tiles) for (const b of t.buildings) size += 8 + 4 * b.ring.length;
  const body = new Uint8Array(size);
  const view = new DataView(body.buffer);
  const header: FarHeader = { tile: FAR_TILE, tiles: [], ...extra };
  let at = 0;
  const q = (v: number) => Math.max(-16383, Math.min(16383, Math.round(v / 0.2)));
  for (const t of tiles) {
    header.tiles.push({ x: t.x, z: t.z, count: t.buildings.length, offset: at });
    for (const b of t.buildings) {
      view.setInt16(at, Math.round(b.base * 10), true);
      view.setUint16(at + 2, Math.min(65535, Math.round(b.eave * 10)), true);
      view.setUint8(at + 4, Math.min(255, Math.round(b.rise / 0.2)));
      view.setUint8(at + 5, b.wall);
      view.setUint8(at + 6, b.roof);
      view.setUint8(at + 7, b.ring.length);
      at += 8;
      b.ring.forEach(([x, z], i) => {
        view.setInt16(at, q(x - t.x) * 2 + (b.hidden[i] ? 1 : 0), true);
        view.setInt16(at + 2, q(z - t.z), true);
        at += 4;
      });
    }
  }
  const head = new TextEncoder().encode(JSON.stringify(header));
  const pad = (head.length + 3) & ~3;
  const out = new Uint8Array(8 + pad + body.length);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, MAGIC, true);
  ov.setUint32(4, head.length, true);
  out.set(head, 8);
  out.set(body, 8 + pad);
  return zlibSync(out, { level: 9 });
}

/** The header and the body (for `forEachFarBuilding`). */
export function decodeFarBuildings(file: Uint8Array): { header: FarHeader; body: DataView } {
  const raw = unzlibSync(file);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("Not a far buildings file");
  const len = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + len))) as FarHeader;
  const start = 8 + ((len + 3) & ~3);
  return { header, body: new DataView(raw.buffer, raw.byteOffset + start, raw.byteLength - start) };
}

/**
 * Calls `f` for each building of a tile with its fields and its ring as a flat array of
 * x, z (metres from the tile's origin) and the hidden flags; the arrays are reused.
 */
export function forEachFarBuilding(
  body: DataView,
  tile: FarTile,
  f: (base: number, eave: number, rise: number, wall: number, roof: number, n: number, xz: Float32Array, hidden: Uint8Array) => void,
): void {
  const xz = new Float32Array(512);
  const hidden = new Uint8Array(256);
  let at = tile.offset;
  for (let k = 0; k < tile.count; k++) {
    const base = body.getInt16(at, true) / 10;
    const eave = body.getUint16(at + 2, true) / 10;
    const rise = body.getUint8(at + 4) * 0.2;
    const wall = body.getUint8(at + 5);
    const roof = body.getUint8(at + 6);
    const n = body.getUint8(at + 7);
    at += 8;
    for (let i = 0; i < n; i++) {
      const xq = body.getInt16(at, true);
      hidden[i] = xq & 1;
      xz[i * 2] = (xq >> 1) * 0.2;
      xz[i * 2 + 1] = body.getInt16(at + 2, true) * 0.2;
      at += 4;
    }
    f(base, eave, rise, wall, roof, n, xz, hidden);
  }
}
