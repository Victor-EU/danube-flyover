// Writes meshes as a meshopt-compressed, quantised .glb with glTF-Transform.
// Vertex colours are given in sRGB and stored linear, as glTF requires.

import { Document, NodeIO, type Primitive } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { meshopt } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import { writeFileSync } from "node:fs";
import { DATA_DIR } from "./io";

export interface MaterialDef {
  name: string;
  color?: [number, number, number];
  roughness?: number;
  metalness?: number;
  doubleSided?: boolean;
}

export interface MeshDef {
  name: string;
  material: MaterialDef;
  position: Float32Array;
  normal?: Float32Array;
  /** sRGB 0..1, three per vertex. */
  color?: Float32Array;
  uv?: Float32Array;
  index?: Uint32Array;
  /** Custom per-vertex attributes; names must start with an underscore (glTF rule). */
  extra?: Record<string, { array: Float32Array; size: 1 | 2 | 3 | 4 }>;
  extras?: Record<string, unknown>;
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export async function writeGlb(file: string, meshes: MeshDef[], extras: Record<string, unknown> = {}): Promise<number> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("world");
  scene.setExtras(extras);
  const materials = new Map<string, ReturnType<Document["createMaterial"]>>();
  for (const m of meshes) {
    let mat = materials.get(m.material.name);
    if (!mat) {
      const d = m.material;
      const c = d.color ?? [1, 1, 1];
      mat = doc
        .createMaterial(d.name)
        .setBaseColorFactor([toLinear(c[0]), toLinear(c[1]), toLinear(c[2]), 1])
        .setRoughnessFactor(d.roughness ?? 0.9)
        .setMetallicFactor(d.metalness ?? 0)
        .setDoubleSided(d.doubleSided ?? false);
      materials.set(d.name, mat);
    }
    const acc = (array: Float32Array | Uint32Array, type: "SCALAR" | "VEC2" | "VEC3" | "VEC4") =>
      doc.createAccessor().setType(type).setArray(array as Float32Array<ArrayBuffer>).setBuffer(buffer);
    const prim: Primitive = doc.createPrimitive().setMaterial(mat);
    prim.setAttribute("POSITION", acc(m.position, "VEC3"));
    if (m.normal) prim.setAttribute("NORMAL", acc(m.normal, "VEC3"));
    if (m.uv) prim.setAttribute("TEXCOORD_0", acc(m.uv, "VEC2"));
    if (m.color) {
      const lin = new Float32Array(m.color.length);
      for (let i = 0; i < lin.length; i++) lin[i] = toLinear(m.color[i]);
      prim.setAttribute("COLOR_0", acc(lin, "VEC3"));
    }
    for (const [name, a] of Object.entries(m.extra ?? {}))
      prim.setAttribute(name, acc(a.array, (["SCALAR", "VEC2", "VEC3", "VEC4"] as const)[a.size - 1]));
    if (m.index) prim.setIndices(acc(m.index, "SCALAR"));
    const mesh = doc.createMesh(m.name).addPrimitive(prim);
    const node = doc.createNode(m.name).setMesh(mesh);
    if (m.extras) node.setExtras(m.extras);
    scene.addChild(node);
  }
  await MeshoptEncoder.ready;
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await doc.transform(
    meshopt({ encoder: MeshoptEncoder, level: "medium", quantizePosition: 16, quantizeTexcoord: 16, quantizeNormal: 8, quantizeColor: 8, quantizeGeneric: 12 }),
  );
  const io = new NodeIO().registerExtensions([KHRMeshQuantization, EXTMeshoptCompression]).registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  const bytes = await io.writeBinary(doc);
  writeFileSync(new URL(file, DATA_DIR), bytes);
  return bytes.byteLength;
}
