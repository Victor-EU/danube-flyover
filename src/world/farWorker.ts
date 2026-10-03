// A worker that builds the far field's building meshes (far/buildings.bin, see farFormat.ts),
// so the main thread never stalls on them: per tile, the street walls (a quad each, from the
// base to the eaves, along the perimeter as the world's are) and the upper mesh build-far made
// (the roofs from the block skeletons, and the firewalls). Vertices are compact: positions as
// 16-bit integers from the tile's centre (the mesh is scaled back), colours as bytes, and the
// surface layer, seed and heights for the city's shader (surfaces.ts, patchFarBuildings). A
// tile goes out in chunks of at most 65536 vertices (16-bit indices), one message each (the
// arrays transferred), then { done: true }.

import { decodeFarBuildings, FAR_TILE, forEachFarBuilding, type FarRecord } from "./farFormat";

export interface FarChunkMessage {
  /** The tile's centre (world metres) and the positions' unit (metres). */
  x: number;
  z: number;
  scale: number;
  /** x, y, z per vertex in `scale` from the tile's centre. */
  position: Int16Array;
  /** Linear colour bytes. */
  color: Uint8Array;
  /** Distance along the building's perimeter (1/32 m, so 2048 m before it wraps). */
  along: Uint16Array;
  /** The street's canyon (distance, height) in bytes of 128 m. */
  canyon: Uint8Array;
  /** Surface layer, seed byte. */
  info: Uint8Array;
  /** The building's base and eaves, world decimetres. */
  level: Int16Array;
  index: Uint16Array;
  buildings: number;
}

const OPEN_CANYON = Math.round((96 / 128) * 255);
const LAYER_FIREWALL = 15;
const MAX_VERTICES = 65536;

const wallCount = (b: FarRecord) => {
  let n = 0;
  for (let i = 0; i < b.points; i++) if (!b.party[i]) n++;
  return n;
};
/** The upper vertices the triangles use (the ring's points only where the roof meets them), each numbered once. */
let used = new Int32Array(4096);
const useUpper = (b: FarRecord) => {
  if (used.length < b.upper) used = new Int32Array(b.upper * 2);
  used.fill(-1, 0, b.upper);
  let n = 0;
  for (let i = 0; i < b.triangles * 3; i++) if (used[b.index[i]] < 0) used[b.index[i]] = n++;
  return n;
};

self.onmessage = (e: MessageEvent<{ bytes: ArrayBuffer }>) => {
  const { header, body } = decodeFarBuildings(new Uint8Array(e.data.bytes));
  for (const tile of header.tiles) {
    // Sizes first, chunk by chunk, and the tile's extent for the positions' unit.
    const chunks: { vertices: number; indices: number; buildings: number }[] = [];
    let cur = { vertices: 0, indices: 0, buildings: 0 };
    let extent = 1;
    forEachFarBuilding(body, tile, (b) => {
      const walls = wallCount(b);
      const nv = 4 * walls + useUpper(b);
      if (cur.vertices + nv > MAX_VERTICES && cur.buildings) {
        chunks.push(cur);
        cur = { vertices: 0, indices: 0, buildings: 0 };
      }
      cur.vertices += nv;
      cur.indices += 6 * walls + 3 * b.triangles;
      cur.buildings++;
      for (let i = 0; i < b.points * 2; i++) extent = Math.max(extent, Math.abs(b.xz[i]));
      extent = Math.max(extent, Math.abs(b.base), Math.abs(b.eave) + 40);
    });
    if (cur.buildings) chunks.push(cur);
    const scale = Math.max(0.02, Math.ceil((extent / 32000) * 1000) / 1000);
    const cx = tile.x + FAR_TILE / 2;
    const cz = tile.z + FAR_TILE / 2;

    let chunk = -1;
    let left = 0;
    let m: FarChunkMessage | null = null;
    let v = 0;
    let t = 0;
    const flush = () => {
      if (!m) return;
      (self as unknown as Worker).postMessage(m, [m.position.buffer, m.color.buffer, m.along.buffer, m.canyon.buffer, m.info.buffer, m.level.buffer, m.index.buffer]);
      m = null;
    };
    forEachFarBuilding(body, tile, (b) => {
      if (left === 0) {
        flush();
        const c = chunks[++chunk];
        left = c.buildings;
        v = 0;
        t = 0;
        m = {
          x: cx,
          z: cz,
          scale,
          position: new Int16Array(c.vertices * 3),
          color: new Uint8Array(c.vertices * 3),
          along: new Uint16Array(c.vertices),
          canyon: new Uint8Array(c.vertices * 2),
          info: new Uint8Array(c.vertices * 2),
          level: new Int16Array(c.vertices * 2),
          index: new Uint16Array(c.indices),
          buildings: c.buildings,
        };
      }
      left--;
      const out = m!;
      const base = Math.round(b.base * 10);
      const eave = Math.round(b.eave * 10);
      const seed = b.seed;
      const vert = (x: number, y: number, z: number, colour: number, layer: number, along: number, cd: number, ch: number) => {
        out.position[v * 3] = Math.round(x / scale);
        out.position[v * 3 + 1] = Math.round(y / scale);
        out.position[v * 3 + 2] = Math.round(z / scale);
        out.color[v * 3] = b.colours[colour];
        out.color[v * 3 + 1] = b.colours[colour + 1];
        out.color[v * 3 + 2] = b.colours[colour + 2];
        out.along[v] = Math.round(along * 32) & 65535;
        out.canyon[v * 2] = cd;
        out.canyon[v * 2 + 1] = ch;
        out.info[v * 2] = layer;
        out.info[v * 2 + 1] = seed;
        out.level[v * 2] = base;
        out.level[v * 2 + 1] = eave;
        return v++;
      };
      // The street walls, along the perimeter as the world's are (party walls still count toward it).
      let i0 = 0;
      for (const n of b.rings) {
        let along = 0;
        for (let j = 0; j < n; j++) {
          const i = i0 + j;
          const k = i0 + ((j + 1) % n);
          const ax = b.xz[i * 2];
          const az = b.xz[i * 2 + 1];
          const bx = b.xz[k * 2];
          const bz = b.xz[k * 2 + 1];
          const l = Math.hypot(bx - ax, bz - az);
          if (!b.party[i]) {
            const c = b.canyon;
            const q0 = vert(ax, b.base, az, 0, b.facade, along, c[i * 4], c[i * 4 + 1]);
            vert(bx, b.base, bz, 0, b.facade, along + l, c[i * 4 + 2], c[i * 4 + 3]);
            vert(bx, b.eave, bz, 0, b.facade, along + l, c[i * 4 + 2], c[i * 4 + 3]);
            vert(ax, b.eave, az, 0, b.facade, along, c[i * 4], c[i * 4 + 1]);
            // Base a, base c, eaves c, eaves a run clockwise seen from outside.
            out.index.set([q0, q0 + 2, q0 + 1, q0, q0 + 3, q0 + 2], t);
            t += 6;
          }
          if (l >= 0.05) along += l;
        }
        i0 += n;
      }
      // Roofs and firewalls.
      const u0 = v;
      const count = useUpper(b);
      const order = new Int32Array(count);
      for (let i = 0; i < b.upper; i++) if (used[i] >= 0) order[used[i]] = i;
      for (const i of order) {
        const fw = b.firewall[i] === 1;
        vert(b.uxzh[i * 3], b.eave + b.uxzh[i * 3 + 2], b.uxzh[i * 3 + 1], fw ? 0 : 3, fw ? LAYER_FIREWALL : b.roofLayer, 0, OPEN_CANYON, 0);
      }
      for (let i = 0; i < b.triangles * 3; i++) out.index[t++] = u0 + used[b.index[i]];
    });
    flush();
  }
  (self as unknown as Worker).postMessage({ done: true });
};
