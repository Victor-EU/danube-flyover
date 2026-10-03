// The roofs' small detail from public/data/roofbits.bin (tools/build-city.ts): the chimney
// stacks near the ridges, capped, and the units on the flat roofs, instanced in 320 m tiles
// and drawn only in the tiles near the camera, where they show. They keep out of the
// reflection and cast no shadows (too small for the shadow map's texels).

import { BoxGeometry, Box3, Color, DynamicDrawUsage, Group, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3, type BufferGeometry } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { LAYER } from "./water";

const FLOATS = 12;
const TILE = 320;
/** Detail shows within this distance of the camera (from the tile's bounds). */
const RANGE = 700;

/** A unit stack (x, z across -0.5..0.5, y up 0..1) with its capping slab. */
function chimneyGeometry(): BufferGeometry {
  const stack = new BoxGeometry(1, 1, 1);
  stack.translate(0, 0.5, 0);
  const cap = new BoxGeometry(1.3, 0.06, 1.3);
  cap.translate(0, 1.03, 0);
  return mergeGeometries([stack, cap])!;
}

export class RoofBits {
  readonly group = new Group();
  private readonly tiles: { mesh: InstancedMesh; box: Box3 }[] = [];
  readonly count: number;

  constructor(bytes: ArrayBuffer | Uint8Array) {
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const f = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
    this.count = f.length / FLOATS;
    const byTile = new Map<string, number[]>();
    for (let i = 0; i < this.count; i++) {
      const key = `${Math.floor(f[i * FLOATS] / TILE)},${Math.floor(f[i * FLOATS + 1] / TILE)},${f[i * FLOATS + 11]}`;
      const list = byTile.get(key);
      if (list) list.push(i);
      else byTile.set(key, [i]);
    }
    const geos = [chimneyGeometry(), new BoxGeometry(1, 1, 1).translate(0, 0.5, 0)];
    const mat = new MeshStandardMaterial({ roughness: 0.92 });
    const m = new Matrix4();
    const q = new Quaternion();
    const p = new Vector3();
    const s = new Vector3();
    const c = new Color();
    const up = new Vector3(0, 1, 0);
    for (const [key, list] of byTile) {
      const kind = Number(key.split(",")[2]);
      const mesh = new InstancedMesh(geos[kind], mat, list.length);
      const box = new Box3();
      list.forEach((i, n) => {
        const o = i * FLOATS;
        const [x, z, y0, y1, ax, az, hu, hv] = f.subarray(o, o + 8);
        p.set(x, y0, z);
        s.set(hu * 2, y1 - y0, hv * 2);
        q.setFromAxisAngle(up, Math.atan2(-az, ax));
        m.compose(p, q, s);
        mesh.setMatrixAt(n, m);
        // Colours are given in sRGB.
        mesh.setColorAt(n, c.setRGB(f[o + 8], f[o + 9], f[o + 10]).convertSRGBToLinear());
        box.expandByPoint(p.set(x - 3, y0, z - 3)).expandByPoint(p.set(x + 3, y1, z + 3));
      });
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.computeBoundingSphere();
      mesh.layers.set(LAYER.details);
      mesh.receiveShadow = true;
      mesh.name = kind === 0 ? "chimneys" : "rooftop units";
      this.group.add(mesh);
      this.tiles.push({ mesh, box });
    }
  }

  update(camera: Vector3): void {
    for (const t of this.tiles) t.mesh.visible = t.box.distanceToPoint(camera) < RANGE;
  }
}
