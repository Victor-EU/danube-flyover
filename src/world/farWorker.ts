// A worker that extrudes the far field's buildings (far/buildings.bin, see farFormat.ts), so the
// main thread never stalls on them: per tile, walls (party walls left out) and a roof, flat or
// hipped. Vertices are shared between the walls and the roof: the far material is flat-shaded
// from screen derivatives and tells roof from wall by the face's slope. Posts one message per
// tile (its arrays transferred), then { done: true }.

import earcut from "earcut";
import { decodeFarBuildings, forEachFarBuilding } from "./farFormat";

export interface FarTileMessage {
  /** Tile origin (world metres); positions are relative to it. */
  x: number;
  z: number;
  /** x, y, z per vertex. */
  position: Float32Array;
  /** Wall colour, roof colour, a random seed, 0, per vertex. */
  info: Uint8Array;
  /** The building's base height per vertex (for the storeys of its windows). */
  base: Float32Array;
  index: Uint32Array;
  buildings: number;
}

self.onmessage = (e: MessageEvent<{ bytes: ArrayBuffer }>) => {
  const { header, body } = decodeFarBuildings(new Uint8Array(e.data.bytes));
  let seed = 1;
  for (const tile of header.tiles) {
    // Sizes first: two rings of n vertices (and two ridge points), up to 2n wall triangles, n roof triangles.
    let nv = 0;
    let ni = 0;
    forEachFarBuilding(body, tile, (_b, _e, rise, _w, _r, n) => {
      nv += 2 * n + (rise > 0 ? 2 : 0);
      ni += 6 * n + 3 * (n + 4);
    });
    const position = new Float32Array(nv * 3);
    const info = new Uint8Array(nv * 4);
    const base = new Float32Array(nv);
    const index = new Uint32Array(ni);
    let v = 0;
    let t = 0;
    const tri = (a: number, b: number, c: number) => {
      // Keep roofs facing up: (b - a) × (c - a) must have a positive y.
      const ax = position[a * 3];
      const az = position[a * 3 + 2];
      const cy = (position[c * 3] - ax) * (position[b * 3 + 2] - az) - (position[c * 3 + 2] - az) * (position[b * 3] - ax);
      if (cy >= 0) index.set([a, b, c], t);
      else index.set([a, c, b], t);
      t += 3;
    };
    forEachFarBuilding(body, tile, (b0, eave, rise, wall, roof, n, xz, hidden) => {
      const v0 = v;
      const top = b0 + eave;
      seed = (seed * 16807) % 2147483647;
      const s = seed & 255;
      const vert = (x: number, y: number, z: number) => {
        position.set([x, y, z], v * 3);
        info.set([wall, roof, s, 0], v * 4);
        base[v] = b0;
        return v++;
      };
      for (let i = 0; i < n; i++) vert(xz[i * 2], b0, xz[i * 2 + 1]);
      for (let i = 0; i < n; i++) vert(xz[i * 2], top, xz[i * 2 + 1]);
      // Walls, facing out (the ring runs counter-clockwise in x, z).
      for (let i = 0; i < n; i++) {
        if (hidden[i]) continue;
        const j = (i + 1) % n;
        index.set([v0 + i, v0 + n + i, v0 + n + j, v0 + i, v0 + n + j, v0 + j], t);
        t += 6;
      }
      if (rise > 0 && n === 4) {
        // A hipped roof: the ridge along the longer sides, set in from each end by half the width.
        const p = (k: number) => [xz[(k % 4) * 2], xz[(k % 4) * 2 + 1]];
        const l01 = Math.hypot(p(1)[0] - p(0)[0], p(1)[1] - p(0)[1]);
        const l12 = Math.hypot(p(2)[0] - p(1)[0], p(2)[1] - p(1)[1]);
        const o = l01 >= l12 ? 0 : 1;
        const [a, b, c, d] = [p(o), p(o + 1), p(o + 2), p(o + 3)];
        const long = Math.max(l01, l12);
        const short = Math.min(l01, l12);
        const ux = (b[0] - a[0]) / long;
        const uz = (b[1] - a[1]) / long;
        const inset = Math.min(short / 2, long / 2);
        const ra = vert((d[0] + a[0]) / 2 + ux * inset, top + rise, (d[1] + a[1]) / 2 + uz * inset);
        const rb = vert((b[0] + c[0]) / 2 - ux * inset, top + rise, (b[1] + c[1]) / 2 - uz * inset);
        const T = (k: number) => v0 + n + ((k + o) % 4);
        tri(T(0), T(1), rb);
        tri(T(0), rb, ra);
        tri(T(2), T(3), ra);
        tri(T(2), ra, rb);
        tri(T(1), T(2), rb);
        tri(T(3), T(0), ra);
      } else {
        const flat = Array.from(xz.subarray(0, n * 2));
        const tris = earcut(flat);
        for (let k = 0; k < tris.length; k += 3) tri(v0 + n + tris[k], v0 + n + tris[k + 1], v0 + n + tris[k + 2]);
      }
    });
    const msg: FarTileMessage = {
      x: tile.x,
      z: tile.z,
      position: position.slice(0, v * 3),
      info: info.slice(0, v * 4),
      base: base.slice(0, v),
      index: index.slice(0, t),
      buildings: tile.count,
    };
    (self as unknown as Worker).postMessage(msg, [msg.position.buffer, msg.info.buffer, msg.base.buffer, msg.index.buffer]);
  }
  (self as unknown as Worker).postMessage({ done: true });
};
