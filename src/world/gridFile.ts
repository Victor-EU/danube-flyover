// A small container for the baked grids (terrain.bin, floor.bin): a JSON header describing a
// regular grid in local metres and its layers, followed by the layers as typed arrays, the
// whole file zlib-compressed. The tools/ pipeline writes it, the runtime and Node read it.

import { unzlibSync, zlibSync } from "fflate";

export type LayerType = "int16" | "uint16" | "uint8" | "float32";

export interface GridHeader {
  kind: string;
  /** World position of cell (0, 0): its centre for cell grids, its vertex for vertex grids. */
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
  layers: { name: string; type: LayerType; scale?: number; offset?: number }[];
  [extra: string]: unknown;
}

type Arr = Int16Array | Uint16Array | Uint8Array | Float32Array;
const CTOR = { int16: Int16Array, uint16: Uint16Array, uint8: Uint8Array, float32: Float32Array } as const;
const MAGIC = 0x31474644; // "DFG1"

export function encodeGrid(header: GridHeader, layers: Arr[]): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const pad = (n: number) => (n + 3) & ~3;
  let size = 8 + pad(head.length);
  for (const l of layers) size += pad(l.byteLength);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, head.length, true);
  out.set(head, 8);
  let at = 8 + pad(head.length);
  for (const l of layers) {
    out.set(new Uint8Array(l.buffer, l.byteOffset, l.byteLength), at);
    at += pad(l.byteLength);
  }
  return zlibSync(out, { level: 9 });
}

export interface Grid {
  header: GridHeader;
  layers: Record<string, Arr>;
}

export function decodeGrid(file: ArrayBuffer | Uint8Array): Grid {
  const raw = unzlibSync(file instanceof Uint8Array ? file : new Uint8Array(file));
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("Not a Danube Flyover grid file");
  const headLen = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + headLen))) as GridHeader;
  const layers: Record<string, Arr> = {};
  let at = 8 + ((headLen + 3) & ~3);
  const count = header.nx * header.nz;
  for (const l of header.layers) {
    const C = CTOR[l.type];
    // Copy into an aligned buffer: the decompressed bytes start at an arbitrary offset.
    const bytes = raw.slice(at, at + count * C.BYTES_PER_ELEMENT);
    layers[l.name] = new C(bytes.buffer);
    at += (count * C.BYTES_PER_ELEMENT + 3) & ~3;
  }
  return { header, layers };
}
