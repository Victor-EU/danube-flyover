// The trees from public/data/trees.json, grown by tools/build-trees.ts (trees/trees.glb and the
// leaf clusters in trees/leaves.webp): nine species in three shapes each, at three levels of
// detail chosen by distance (re-sorted a few times a second, and only for trees in or near
// the view). Leaves are alpha-tested cards whose shading normals lean out from the crown, so a
// crown lights as a volume; each tree has its own share of turned leaves and autumn hue, and
// sways a little in the wind. Every instanced mesh is one species, shape and level.

import {
  BufferAttribute,
  type BufferGeometry,
  Color,
  DataArrayTexture,
  DoubleSide,
  DynamicDrawUsage,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  type Mesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
  Quaternion,
  RGBADepthPacking,
  Sphere,
  Vector3,
} from "three";
import { TREE_SPECIES, TREE_VARIANTS } from "../config";
import { SHARED } from "./night";
import { HASH_GLSL, patchMaterial } from "./shaderPatch";
import type { Terrain } from "./terrain";

export interface TreesJson {
  /** Flat [x, z, scale, species, ...] in local metres. */
  trees: number[];
}

/** Level-of-detail distances (m): full trees nearer than the first, the coarsest beyond the second. */
const LOD_RANGES = [150, 560];
const REBUCKET = 0.12; // seconds

/** Bark colours per species (sRGB): a base and the patches or furrows over it. */
const BARK: Record<string, [string, string, number]> = {
  plane: ["#a39d86", "#6f6a55", 1],
  chestnut: ["#5d5246", "#3e352d", 0],
  linden: ["#5f574d", "#3f3933", 0],
  maple: ["#665d52", "#433c35", 0],
  poplar: ["#a7a597", "#5d5a52", 1],
  willow: ["#6a604f", "#3d362c", 0],
  oak: ["#58514a", "#332e29", 0],
  robinia: ["#6b5f4f", "#3b3329", 0],
  pine: ["#8a5a3a", "#4e3424", 0],
};

const LEAF_GLSL = /* glsl */ `
uniform sampler2DArray uLeaves;
uniform float uLayer;
uniform float uTurned;
uniform vec3 uBarkA;
uniform vec3 uBarkB;
uniform float uMottle;
varying float vKind;
varying vec4 vTree;
varying vec2 vLeafUv;
${HASH_GLSL}
/** Autumn: from green through yellow and orange to rust and brown, by the tree's hue and the leaf. */
vec3 leafColour(float leaf, float lum) {
  vec3 green = mix(vec3(0.12, 0.2, 0.05), vec3(0.2, 0.27, 0.07), leaf);
  float turned = step(leaf, clamp(uTurned + vTree.x, 0.0, 1.0));
  float h = fract(vTree.y + leaf * 0.35);
  vec3 autumn = h < 0.45 ? mix(vec3(0.62, 0.46, 0.07), vec3(0.66, 0.36, 0.05), h / 0.45)
              : h < 0.8 ? mix(vec3(0.66, 0.36, 0.05), vec3(0.5, 0.17, 0.05), (h - 0.45) / 0.35)
              : mix(vec3(0.5, 0.17, 0.05), vec3(0.36, 0.24, 0.09), (h - 0.8) / 0.2);
  return mix(green, autumn, turned) * (0.55 + 0.75 * lum) * vTree.w;
}
`;

export class Forest {
  readonly group = new Group();
  private readonly meshes: InstancedMesh[][] = []; // [species * VARIANTS + variant][lod]
  private readonly trees: { x: number; y: number; z: number; m: Float32Array; a: Float32Array; key: number; r: number }[] = [];
  private readonly order: number[];
  private share = 1;
  private t = 0;
  readonly count: number;
  private readonly frustum = new Frustum();
  private readonly sphere = new Sphere();
  private readonly pv = new Matrix4();
  /** Draw counts per level, for the debug panel. */
  readonly drawn = [0, 0, 0];

  constructor(data: TreesJson, terrain: Terrain, model: Object3D, leaves: DataArrayTexture) {
    // Geometry by "species variant lod".
    // The glTF is quantised: each node's transform scales its positions back, so bake it in.
    const geos = new Map<string, BufferGeometry>();
    model.updateMatrixWorld(true);
    model.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const geo = mesh.geometry.clone();
      for (const [name, attr] of Object.entries(geo.attributes)) {
        const a = attr as BufferAttribute;
        const out = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
        geo.setAttribute(name, new BufferAttribute(out, a.itemSize));
      }
      geo.applyMatrix4(mesh.matrixWorld);
      geos.set(mesh.name.replace(/^tree[ _]/, "").replace(/_/g, " "), geo);
    });
    const t = data.trees;
    this.count = t.length / 4;
    const counts = new Array(TREE_SPECIES.length * TREE_VARIANTS).fill(0);
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const p = new Vector3();
    const s = new Vector3();
    for (let i = 0; i < this.count; i++) {
      const [x, z, sc, sp] = [t[i * 4], t[i * 4 + 1], t[i * 4 + 2], t[i * 4 + 3]];
      const h = Math.abs(Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
      const h2 = Math.abs(Math.sin(x * 39.346 + z * 11.135) * 24634.6345) % 1;
      const variant = Math.floor(h * TREE_VARIANTS) % TREE_VARIANTS;
      const key = sp * TREE_VARIANTS + variant;
      counts[key]++;
      const y = terrain.heightAt(x, z) - 0.25;
      q.setFromAxisAngle(up, h2 * Math.PI * 2);
      const k = sc * (0.92 + 0.16 * h);
      m.compose(p.set(x, y, z), q, s.set(k, sc * (0.9 + 0.2 * h2), k));
      // Per tree: extra turned share, autumn hue, wind phase, brightness. Neighbours turn together.
      const drift = 0.5 + 0.25 * (Math.sin(x * 0.0061 + 1.3) + Math.sin(z * 0.0047 - 0.4));
      const a = new Float32Array([(h2 - 0.5) * 0.5 + (drift - 0.5) * 0.4, (h * 0.6 + drift * 0.4) % 1, h2 * 6.28, 0.85 + 0.3 * h]);
      this.trees.push({ x, y, z, m: Float32Array.from(m.elements), a, key, r: TREE_SPECIES[sp].height * sc });
    }
    // A shuffled (but fixed) order, so drawing only a share of the trees (the lower tiers) thins every park evenly.
    this.order = Array.from({ length: this.count }, (_, i) => i);
    let seed = 1873;
    for (let i = this.count - 1; i > 0; i--) {
      seed = (seed * 16807) % 2147483647;
      const j = seed % (i + 1);
      [this.order[i], this.order[j]] = [this.order[j], this.order[i]];
    }

    TREE_SPECIES.forEach((sp, si) => {
      const [a, b, mottle] = BARK[sp.name];
      const uniforms = {
        uLeaves: { value: leaves },
        uLayer: { value: si },
        uTurned: { value: sp.turned },
        uBarkA: { value: new Color(a) },
        uBarkB: { value: new Color(b) },
        uMottle: { value: mottle },
        uTime: SHARED.uTime,
      };
      const mat = new MeshStandardMaterial({ roughness: 0.82, side: DoubleSide });
      patchTree(mat, uniforms);
      const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking, side: DoubleSide });
      patchTreeDepth(depth, uniforms);
      for (let v = 0; v < TREE_VARIANTS; v++) {
        const row: InstancedMesh[] = [];
        for (let lod = 0; lod < 3; lod++) {
          const geo = geos.get(`${sp.name} ${v} ${lod}`);
          if (!geo) throw new Error(`trees.glb has no ${sp.name} ${v} ${lod}`);
          const n = Math.max(1, counts[si * TREE_VARIANTS + v]);
          const mesh = new InstancedMesh(geo, mat, n);
          mesh.instanceMatrix.setUsage(DynamicDrawUsage);
          const attr = new InstancedBufferAttribute(new Float32Array(n * 4), 4).setUsage(DynamicDrawUsage);
          geo.setAttribute("aTree", attr);
          mesh.customDepthMaterial = depth;
          mesh.castShadow = lod < 2;
          mesh.receiveShadow = true;
          mesh.frustumCulled = false; // culled per tree when sorting
          mesh.count = 0;
          mesh.name = `trees ${sp.name} ${v} ${lod}`;
          row.push(mesh);
          this.group.add(mesh);
        }
        this.meshes.push(row);
      }
    });
    this.group.name = "trees";
  }

  /** Share of the trees drawn (the quality tiers). */
  setShare(share: number): void {
    this.share = share;
    this.t = 0;
  }

  update(camera: PerspectiveCamera, dt: number): void {
    this.t -= dt;
    if (this.t > 0) return;
    this.t = REBUCKET;
    camera.updateMatrixWorld();
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const r0 = LOD_RANGES[0] ** 2;
    const r1 = LOD_RANGES[1] ** 2;
    for (const row of this.meshes) for (const mesh of row) mesh.count = 0;
    this.drawn.fill(0);
    const n = Math.round(this.count * this.share);
    for (let o = 0; o < n; o++) {
      const tr = this.trees[this.order[o]];
      // In view, with a margin for the shadows of trees just outside it.
      this.sphere.center.set(tr.x, tr.y + tr.r * 0.5, tr.z);
      this.sphere.radius = tr.r + 25;
      if (!this.frustum.intersectsSphere(this.sphere)) continue;
      const d2 = (tr.x - cx) ** 2 + (tr.y - cy) ** 2 + (tr.z - cz) ** 2;
      const lod = d2 < r0 ? 0 : d2 < r1 ? 1 : 2;
      const mesh = this.meshes[tr.key][lod];
      const k = mesh.count++;
      (mesh.instanceMatrix.array as Float32Array).set(tr.m, k * 16);
      ((mesh.geometry.getAttribute("aTree") as InstancedBufferAttribute).array as Float32Array).set(tr.a, k * 4);
      this.drawn[lod]++;
    }
    for (const row of this.meshes)
      for (const mesh of row) {
        if (!mesh.count) continue;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.geometry.getAttribute("aTree").needsUpdate = true;
      }
  }
}

function patchTree(mat: MeshStandardMaterial, uniforms: Record<string, { value: unknown }>): void {
  patchMaterial(mat, {
    key: "tree",
    uniforms,
    vertexPars: /* glsl */ `
      attribute float _kind;
      attribute vec4 aTree;
      uniform float uTime;
      varying float vKind;
      varying vec4 vTree;
      varying vec2 vLeafUv;`,
    vertex: [
      [
        "begin_vertex",
        /* glsl */ `
        vKind = _kind;
        vTree = aTree;
        vLeafUv = uv;
        // Wind: the crown sways from the trunk's top, the leaf cards flutter.
        float sway = transformed.y * transformed.y * 0.0009;
        transformed.x += sin(uTime * 0.9 + aTree.z) * sway;
        transformed.z += cos(uTime * 0.7 + aTree.z * 1.3) * sway * 0.7;
        transformed += _kind * 0.05 * vec3(sin(uTime * 3.1 + transformed.y + aTree.z), sin(uTime * 2.3 + transformed.x), cos(uTime * 2.7 + transformed.z));`,
      ],
    ],
    fragmentPars: LEAF_GLSL,
    fragment: [
      [
        "map_fragment",
        /* glsl */ `
        if (vKind > 0.5) {
          vec4 leaf = texture(uLeaves, vec3(vLeafUv, uLayer));
          // Mipmaps average the cut-out's coverage away: lower the threshold as they do.
          float mip = log2(max(max(length(dFdx(vLeafUv)), length(dFdy(vLeafUv))) * 512.0, 1.0));
          if (leaf.a < mix(0.5, 0.16, clamp(mip / 5.0, 0.0, 1.0))) discard;
          diffuseColor.rgb = leaf.b > 0.5 ? uBarkB * 0.8 : leafColour(leaf.g, leaf.r);
        } else {
          // Bark: furrows along the stem, and the plane's and poplar's pale patches.
          float n = vnoise(vLeafUv * vec2(9.0, 1.4));
          float patches = smoothstep(0.45, 0.55, vnoise(vLeafUv * vec2(2.2, 1.1) + 3.0));
          diffuseColor.rgb = mix(uBarkB, uBarkA, mix(n, patches, uMottle));
        }`,
        true,
      ],
      // Leaves keep their outward normal on both faces, so a crown shades as one volume.
      ["normal_fragment_begin", "if (vKind > 0.5) normal = normalize(vNormal);"],
      ["roughnessmap_fragment", "roughnessFactor = vKind > 0.5 ? 0.7 : 0.9;"],
    ],
  });
}

/** The same cut-outs (and sway) in the shadow map. */
function patchTreeDepth(mat: MeshDepthMaterial, uniforms: Record<string, { value: unknown }>): void {
  patchMaterial(mat, {
    key: "treeDepth",
    uniforms,
    vertexPars: "attribute float _kind;\nattribute vec4 aTree;\nuniform float uTime;\nvarying float vKind;\nvarying vec2 vLeafUv;",
    vertex: [
      [
        "begin_vertex",
        `vKind = _kind;
        vLeafUv = uv;
        float sway = transformed.y * transformed.y * 0.0009;
        transformed.x += sin(uTime * 0.9 + aTree.z) * sway;
        transformed.z += cos(uTime * 0.7 + aTree.z * 1.3) * sway * 0.7;`,
      ],
    ],
    fragmentPars: "uniform sampler2DArray uLeaves;\nuniform float uLayer;\nvarying float vKind;\nvarying vec2 vLeafUv;",
    fragment: [
      [
        "clipping_planes_fragment",
        `if (vKind > 0.5) {
          float mip = log2(max(max(length(dFdx(vLeafUv)), length(dFdy(vLeafUv))) * 512.0, 1.0));
          if (texture(uLeaves, vec3(vLeafUv, uLayer)).a < mix(0.5, 0.16, clamp(mip / 5.0, 0.0, 1.0))) discard;
        }`,
      ],
    ],
  });
}
