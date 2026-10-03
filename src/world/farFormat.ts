// The far field's buildings file, far/buildings.bin: written by tools/build-far.ts, read by the
// runtime's worker (farWorker.ts), which builds the meshes. No three.js here: the worker loads it.
//
// zlib( "DFB3" magic, u32 header length, JSON header, padding to 4, body ). The header lists
// the tiles (FAR_TILE metres square): their origin and where their buildings start in the
// body. Numbers marked v are varints (7 bits a byte, low first), z zigzagged (signed) varints.
// Each building is
//   int16 base, int16 eave         world heights in decimetres: the walls run from one to the other
//   u8 × 3 wall colour, u8 × 3 roof colour   linear colour bytes, as the world's vertex colours
//   u8 layers                      the facade's surface layer (low 4 bits) and the roof's (high 4)
//   u8 seed
//   z ox, z oz                     its origin, in 0.1 m from the tile's centre
//   v rings, then v points per ring (the outline first, then any courtyards)
//   v m, v k                       the upper mesh's own vertices and its triangles
//   per ring point: z (dx · 2 + party), z dz, in 0.05 m from the point before (the first from
//     the origin); party set: the wall from this point to the next isn't drawn. A street wall
//     follows with its baked canyon at its start and end: u8 distance, u8 height each, in
//     FAR_CANYON_UNIT / 255 metres;
//   per upper vertex: z (dx · 2 + firewall), z dz, z dh, from the vertex before (the first from
//     the origin, height 0): x, z as the ring's, the height above the eaves in cm; firewall set:
//     the blank wall over a lower neighbour or a gable, rather than roof;
//   k × 3 z index deltas (from the index before). Indices below the ring's point count are the
//     ring's own points at the eaves, as roof; the rest are the upper vertices. Triangles face out.
// Rings run counter-clockwise in (x, z), courtyards clockwise, so every wall faces out of the building.

import { unzlibSync, zlibSync } from "fflate";

export const FAR_TILE = 1000;
const MAGIC = 0x33424644; // "DFB3"
/** Baked canyon values (distance, height) are stored in units of this many metres / 255. */
export const FAR_CANYON_UNIT = 128;

export interface FarBuilding {
  base: number;
  eave: number;
  /** Linear, 0..1. */
  wall: [number, number, number];
  roof: [number, number, number];
  facade: number;
  roofLayer: number;
  seed: number;
  /** Rings in world metres; `party[r][i]`: the wall from point i to i + 1 isn't drawn. */
  rings: [number, number][][];
  party: boolean[][];
  /** Per ring point: the canyon at the start and the end of its wall, [d0, h0, d1, h1] in metres. */
  canyon: [number, number, number, number][][];
  /** The upper mesh: world x, z, height above the eaves, and whether it's a firewall. */
  upper: { x: number; z: number; h: number; firewall: boolean }[];
  /** Indices: below the rings' point count, a ring point at the eaves; above, `upper[i - count]`. */
  triangles: number[];
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

class Writer {
  bytes = new Uint8Array(1 << 20);
  at = 0;
  private room(n: number) {
    if (this.at + n <= this.bytes.length) return;
    const next = new Uint8Array(Math.max(this.bytes.length * 2, this.at + n));
    next.set(this.bytes.subarray(0, this.at));
    this.bytes = next;
  }
  u8(v: number) {
    this.room(1);
    this.bytes[this.at++] = v;
  }
  i16(v: number) {
    this.room(2);
    const c = Math.max(-32768, Math.min(32767, Math.round(v)));
    this.bytes[this.at++] = c & 255;
    this.bytes[this.at++] = (c >> 8) & 255;
  }
  v(n: number) {
    this.room(5);
    let x = n >>> 0;
    while (x >= 128) {
      this.bytes[this.at++] = (x & 127) | 128;
      x >>>= 7;
    }
    this.bytes[this.at++] = x;
  }
  z(n: number) {
    this.v(n >= 0 ? n * 2 : -n * 2 - 1);
  }
}

export function encodeFarBuildings(tiles: { x: number; z: number; buildings: FarBuilding[] }[], extra: Record<string, unknown> = {}): Uint8Array {
  const w = new Writer();
  const header: FarHeader = { tile: FAR_TILE, tiles: [], ...extra };
  const c8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const canyon = (m: number) => c8((Math.max(0, m) / FAR_CANYON_UNIT) * 255);
  const q = (v: number) => Math.round(v / 0.05);
  for (const t of tiles) {
    header.tiles.push({ x: t.x, z: t.z, count: t.buildings.length, offset: w.at });
    const cx = t.x + FAR_TILE / 2;
    const cz = t.z + FAR_TILE / 2;
    for (const b of t.buildings) {
      const ox = Math.round((b.rings[0][0][0] - cx) / 0.1);
      const oz = Math.round((b.rings[0][0][1] - cz) / 0.1);
      const wx = cx + ox * 0.1;
      const wz = cz + oz * 0.1;
      w.i16(b.base * 10);
      w.i16(b.eave * 10);
      for (const c of b.wall) w.u8(c8(c * 255));
      for (const c of b.roof) w.u8(c8(c * 255));
      w.u8((b.facade & 15) | ((b.roofLayer & 15) << 4));
      w.u8(c8(b.seed * 255));
      w.z(ox);
      w.z(oz);
      w.v(b.rings.length);
      for (const r of b.rings) w.v(r.length);
      w.v(b.upper.length);
      w.v(b.triangles.length / 3);
      let px = 0;
      let pz = 0;
      b.rings.forEach((r, ri) =>
        r.forEach(([x, z], i) => {
          const qx = q(x - wx);
          const qz = q(z - wz);
          const party = b.party[ri][i];
          w.z((qx - px) * 2 + (party ? 1 : 0));
          w.z(qz - pz);
          px = qx;
          pz = qz;
          if (!party) for (const c of b.canyon[ri][i]) w.u8(canyon(c));
        }),
      );
      px = 0;
      pz = 0;
      let ph = 0;
      for (const u of b.upper) {
        const qx = q(u.x - wx);
        const qz = q(u.z - wz);
        const qh = Math.round(u.h * 100);
        w.z((qx - px) * 2 + (u.firewall ? 1 : 0));
        w.z(qz - pz);
        w.z(qh - ph);
        px = qx;
        pz = qz;
        ph = qh;
      }
      let pi = 0;
      for (const i of b.triangles) {
        w.z(i - pi);
        pi = i;
      }
    }
  }
  const body = w.bytes.subarray(0, w.at);
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
export function decodeFarBuildings(file: Uint8Array): { header: FarHeader; body: Uint8Array } {
  const raw = unzlibSync(file);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("Not a far buildings file (DFB3)");
  const len = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + len))) as FarHeader;
  return { header, body: raw.subarray(8 + ((len + 3) & ~3)) };
}

/** One decoded building, its coordinates in metres from the tile's centre; the arrays are reused between calls. */
export interface FarRecord {
  base: number;
  eave: number;
  /** Wall and roof colour bytes. */
  colours: Uint8Array;
  facade: number;
  roofLayer: number;
  seed: number;
  /** Point counts per ring, and their points: x, z per point, the party flags, and four canyon bytes per point. */
  rings: number[];
  points: number;
  xz: Float32Array;
  party: Uint8Array;
  canyon: Uint8Array;
  /** Upper vertices, the ring's points first (at the eaves, as roof): x, z, height above the eaves; their firewall flags. */
  upper: number;
  uxzh: Float32Array;
  firewall: Uint8Array;
  triangles: number;
  index: Uint32Array;
}

/** Calls `f` for each building of a tile. */
export function forEachFarBuilding(body: Uint8Array, tile: FarTile, f: (b: FarRecord) => void): void {
  const r: FarRecord = {
    base: 0,
    eave: 0,
    colours: new Uint8Array(6),
    facade: 0,
    roofLayer: 0,
    seed: 0,
    rings: [],
    points: 0,
    xz: new Float32Array(2 * 1024),
    party: new Uint8Array(1024),
    canyon: new Uint8Array(4 * 1024),
    upper: 0,
    uxzh: new Float32Array(3 * 2048),
    firewall: new Uint8Array(2048),
    triangles: 0,
    index: new Uint32Array(3 * 2048),
  };
  let at = tile.offset;
  const v = () => {
    let x = 0;
    let s = 0;
    let c: number;
    do {
      c = body[at++];
      x += (c & 127) * 2 ** s;
      s += 7;
    } while (c & 128);
    return x;
  };
  const z = () => {
    const x = v();
    return x % 2 ? -(x + 1) / 2 : x / 2;
  };
  const i16 = () => {
    const x = body[at] | (body[at + 1] << 8);
    at += 2;
    return x >= 32768 ? x - 65536 : x;
  };
  for (let b = 0; b < tile.count; b++) {
    r.base = i16() / 10;
    r.eave = i16() / 10;
    for (let k = 0; k < 6; k++) r.colours[k] = body[at++];
    const layers = body[at++];
    r.facade = layers & 15;
    r.roofLayer = layers >> 4;
    r.seed = body[at++];
    const ox = z() * 0.1;
    const oz = z() * 0.1;
    const nr = v();
    r.rings.length = 0;
    let n = 0;
    for (let i = 0; i < nr; i++) {
      const c = v();
      r.rings.push(c);
      n += c;
    }
    const m = v();
    const k = v();
    r.points = n;
    r.upper = n + m;
    r.triangles = k;
    if (n > r.party.length) {
      r.xz = new Float32Array(2 * n);
      r.party = new Uint8Array(n);
      r.canyon = new Uint8Array(4 * n);
    }
    if (n + m > r.firewall.length) {
      r.uxzh = new Float32Array(3 * (n + m));
      r.firewall = new Uint8Array(n + m);
    }
    if (3 * k > r.index.length) r.index = new Uint32Array(3 * k);
    let qx = 0;
    let qz = 0;
    for (let i = 0; i < n; i++) {
      const dx = z();
      const party = ((dx % 2) + 2) % 2;
      qx += (dx - party) / 2;
      qz += z();
      r.party[i] = party;
      r.xz[i * 2] = ox + qx * 0.05;
      r.xz[i * 2 + 1] = oz + qz * 0.05;
      r.uxzh[i * 3] = r.xz[i * 2];
      r.uxzh[i * 3 + 1] = r.xz[i * 2 + 1];
      r.uxzh[i * 3 + 2] = 0;
      r.firewall[i] = 0;
      if (party) r.canyon.fill(0, i * 4, i * 4 + 4);
      else for (let c = 0; c < 4; c++) r.canyon[i * 4 + c] = body[at++];
    }
    qx = 0;
    qz = 0;
    let qh = 0;
    for (let i = n; i < n + m; i++) {
      const dx = z();
      const fw = ((dx % 2) + 2) % 2;
      qx += (dx - fw) / 2;
      qz += z();
      qh += z();
      r.firewall[i] = fw;
      r.uxzh[i * 3] = ox + qx * 0.05;
      r.uxzh[i * 3 + 1] = oz + qz * 0.05;
      r.uxzh[i * 3 + 2] = qh / 100;
    }
    let pi = 0;
    for (let i = 0; i < k * 3; i++) r.index[i] = pi += z();
    f(r);
  }
}
