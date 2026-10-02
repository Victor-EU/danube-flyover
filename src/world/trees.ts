// Placeholder trees from public/data/trees.json: one instanced low-poly crown on a trunk.
// The crown spans 4–13 m above the ground at scale 1, matching what build-floor assumes.
// Early October: most crowns have turned (gold, orange, rust, brown) and a quarter are still green.

import { BufferAttribute, type BufferGeometry, Color, CylinderGeometry, IcosahedronGeometry, InstancedMesh, Matrix4, MeshStandardMaterial } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Terrain } from "./terrain";

export interface TreesJson {
  /** Flat [x, z, scale, ...] in local metres. */
  trees: number[];
}

/** Leaf colours, each listed as often as it is common (20 in all), green first and brown last. */
const AUTUMN: [hex: string, weight: number][] = [
  ["#6f8a46", 3], ["#7c8f4a", 2], // still green
  ["#d9a93c", 3], ["#e3b94e", 2], ["#c8962f", 2], // linden and maple gold
  ["#d0782c", 2], ["#c4652a", 2], // orange
  ["#b85a33", 2], ["#a8452b", 1], // rust and red
  ["#957238", 1], // brown oak
];

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
  // Instance colours multiply these: white crowns take the leaf colour, the trunk stays dark.
  paint(crown, new Color(1, 1, 1));
  paint(trunk, new Color(0.55, 0.42, 0.3));
  const geo = mergeGeometries([crown, trunk.toNonIndexed()])!; // the icosahedron is already non-indexed
  geo.computeVertexNormals();

  const t = data.trees;
  const count = t.length / 3;
  // Instances in a shuffled (but fixed) order, so drawing only the first n of them (the lower
  // quality tiers) thins every park evenly.
  const order = Array.from({ length: count }, (_, i) => i);
  let seed = 1873;
  for (let i = count - 1; i > 0; i--) {
    seed = (seed * 16807) % 2147483647;
    const j = seed % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const mesh = new InstancedMesh(geo, new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }), count);
  const leaves = AUTUMN.flatMap(([hex, weight]) => Array<Color>(weight).fill(new Color(hex)));
  const m = new Matrix4();
  for (let n = 0; n < count; n++) {
    const i = order[n];
    const [x, z, s] = [t[i * 3], t[i * 3 + 1], t[i * 3 + 2]];
    // A stable per-tree variation in height (never taller than build-floor assumes) and colour,
    // with the colour also drifting slowly across the city, so neighbouring trees turn together.
    const v = Math.abs((Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1);
    const drift = 0.5 + 0.25 * (Math.sin(x * 0.0061 + 1.3) + Math.sin(z * 0.0047 - 0.4));
    const c = (v * 0.7 + drift * 0.3) % 1;
    m.makeScale(s, s * (0.86 + v * 0.14), s);
    m.setPosition(x, terrain.heightAt(x, z) - 0.3, z);
    mesh.setMatrixAt(n, m);
    mesh.setColorAt(n, leaves[Math.floor(c * leaves.length) % leaves.length]);
  }
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.name = "trees";
  return mesh;
}
