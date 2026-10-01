// Placeholder trees from public/data/trees.json: one instanced low-poly crown on a trunk.
// The crown spans 4–13 m above the ground at scale 1, matching what build-floor assumes.

import { BufferAttribute, type BufferGeometry, Color, CylinderGeometry, IcosahedronGeometry, InstancedMesh, Matrix4, MeshStandardMaterial } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Terrain } from "./terrain";

export interface TreesJson {
  /** Flat [x, z, scale, ...] in local metres. */
  trees: number[];
}

export function buildTrees(data: TreesJson, terrain: Terrain): InstancedMesh {
  const crown = new IcosahedronGeometry(4.5, 0);
  crown.scale(1, 0.9, 1);
  crown.translate(0, 8.5, 0);
  const trunk = new CylinderGeometry(0.35, 0.45, 5, 5, 1, true);
  trunk.translate(0, 2.5, 0);
  const paint = (g: BufferGeometry, c: Color) => {
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
    g.setAttribute("color", new BufferAttribute(col, 3));
  };
  // Instance colours multiply these: white crowns take the green, the trunk stays dark.
  paint(crown, new Color(1, 1, 1));
  paint(trunk, new Color(0.55, 0.42, 0.3));
  const geo = mergeGeometries([crown, trunk.toNonIndexed()])!; // the icosahedron is already non-indexed
  geo.computeVertexNormals();

  const t = data.trees;
  const count = t.length / 3;
  const mesh = new InstancedMesh(geo, new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }), count);
  const greens = ["#6a8a4c", "#789854", "#5f7f45", "#82995a", "#738b48", "#668656"].map((c) => new Color(c));
  const m = new Matrix4();
  for (let i = 0; i < count; i++) {
    const [x, z, s] = [t[i * 3], t[i * 3 + 1], t[i * 3 + 2]];
    // A stable per-tree variation in height (never taller than build-floor assumes) and colour.
    const v = Math.abs((Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1);
    m.makeScale(s, s * (0.86 + v * 0.14), s);
    m.setPosition(x, terrain.heightAt(x, z) - 0.3, z);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, greens[Math.floor(v * greens.length) % greens.length]);
  }
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.name = "trees";
  return mesh;
}
