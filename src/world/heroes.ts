// The hero landmarks from public/data/heroes/ (tools/build-heroes.ts): one glb per landmark,
// already in world space. Each gets its own material, so the night lights can floodlight it
// with its own colour and direction; they all share one program.

import { Group, type Mesh, MeshStandardMaterial, type Object3D } from "three";
import type { TextureSet } from "../textures";
import { patchHero } from "./surfaces";

export class Heroes {
  readonly group = new Group();
  /** Meshes and the material of each hero, by landmark id. */
  readonly byId = new Map<string, { meshes: Mesh[]; material: MeshStandardMaterial }>();
  /** The same, by landmark name (the bridges look themselves up by name). */
  readonly byName = new Map<string, { meshes: Mesh[]; material: MeshStandardMaterial }>();

  constructor(models: Record<string, Object3D>, tex: TextureSet, names: Record<string, string>) {
    this.group.name = "heroes";
    for (const [id, root] of Object.entries(models)) {
      const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0, name: `hero ${id}` });
      patchHero(material, tex);
      const meshes: Mesh[] = [];
      root.traverse((o) => {
        if (!(o as Mesh).isMesh) return;
        const mesh = o as Mesh;
        mesh.material = material;
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.name = id;
        meshes.push(mesh);
      });
      root.name = id;
      this.group.add(root);
      this.byId.set(id, { meshes, material });
      this.byName.set(names[id] ?? id, { meshes, material });
    }
  }
}
