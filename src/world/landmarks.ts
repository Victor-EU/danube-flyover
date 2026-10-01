// Landmarks from public/data/landmarks.json (hand-edited): the sights the cards and the orbit
// camera aim at and, until M4's hero models, a placeholder block per landmark at its real
// position with a floating name label.
// The same placement code serves the runtime meshes and the tools/ pipeline (which keeps the
// filler city out of the blocks and puts them in the floor grid), so the two always agree.

import {
  BoxGeometry,
  CanvasTexture,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
  type Vector3,
} from "three";
import { WORLD } from "../config";
import { lonLatToLocal } from "../geo";

export interface PartJson {
  shape: "box" | "cyl" | "cone";
  /** Box width (across the heading) and depth (along it); radius for cylinders and cones. */
  w?: number;
  d?: number;
  r?: number;
  h: number;
  /** Height of the part's base above the landmark's base. */
  y?: number;
  /** Offset from the landmark position along the heading, and to its right. */
  along?: number;
  across?: number;
  color: string;
}

export interface LandmarkJson {
  id: string;
  name: string;
  position: { lat: number; lon: number };
  triggerRadius: number;
  /** Hero model file (M4); null while the placeholder stands in. */
  model: string | null;
  note: string;
  illustration: string | null;
  /** OSM buildings the hero replaces; the filler city leaves them out. */
  osm?: string[];
  /** Placeholder block (none for the bridges, which are their own placeholders). */
  placeholder?: {
    /** Compass heading (degrees) of the block's depth axis. */
    heading: number;
    /** "ground" (default): terrain height at the position; "quay": on the quay strip. */
    base?: "ground" | "quay";
    parts: PartJson[];
  };
}

export interface LandmarksJson {
  license?: string;
  landmarks: LandmarkJson[];
}

/** A placed part: world position of its base centre, rotation about Y, and its top. */
export interface PlacedPart {
  part: PartJson;
  x: number;
  z: number;
  y0: number;
  top: number;
  /** Mesh rotation about Y; the part's depth axis runs along (sin rot, cos rot). */
  rot: number;
  /** Footprint half extents across and along (radius for round parts). */
  hw: number;
  hd: number;
}

export function placeParts(l: LandmarkJson, groundAt: (x: number, z: number) => number): PlacedPart[] {
  const ph = l.placeholder;
  if (!ph) return [];
  const c = lonLatToLocal(l.position.lon, l.position.lat);
  const h = (ph.heading * Math.PI) / 180;
  // Compass heading h points along (sin h, -cos h); the mesh rotation that aligns local +Z with it.
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const rot = Math.atan2(fx, fz);
  const base = ph.base === "quay" ? WORLD.quayHeight : Math.max(groundAt(c.x, c.z), WORLD.landBase);
  return ph.parts.map((part) => {
    const along = part.along ?? 0;
    const across = part.across ?? 0;
    // Right of the heading is (-fz, fx).
    const x = c.x + fx * along - fz * across;
    const z = c.z + fz * along + fx * across;
    const y0 = base + (part.y ?? 0);
    const round = part.shape !== "box";
    return { part, x, z, y0, top: y0 + part.h, rot, hw: round ? part.r! : part.w! / 2, hd: round ? part.r! : part.d! / 2 };
  });
}

/** A landmark as the cards and the camera see it: where it is and the point to aim at. */
export interface Sight {
  id: string;
  name: string;
  note: string;
  illustration: string | null;
  x: number;
  z: number;
  /** Height of the aim point: half way up the placeholder, or deck height for a bridge. */
  y: number;
  radius: number;
}

/** No DOM or meshes, so tools/simulate.ts can run the cards and the camera too. */
export function buildSights(data: LandmarksJson, groundAt: (x: number, z: number) => number): Sight[] {
  return data.landmarks.map((l) => {
    const c = lonLatToLocal(l.position.lon, l.position.lat);
    const parts = placeParts(l, groundAt);
    let y: number;
    if (parts.length) {
      const base = Math.min(...parts.map((p) => p.y0));
      y = base + (Math.max(...parts.map((p) => p.top)) - base) / 2;
    } else y = Math.max(groundAt(c.x, c.z), 0) + 8;
    return { id: l.id, name: l.name, note: l.note, illustration: l.illustration, x: c.x, z: c.z, y, radius: l.triggerRadius };
  });
}

/** True if (x, z) lies within a placed part's footprint grown by `margin`. */
export function inPart(p: PlacedPart, x: number, z: number, margin: number): boolean {
  const dx = x - p.x;
  const dz = z - p.z;
  if (p.part.shape !== "box") return Math.hypot(dx, dz) <= p.hw + margin;
  // Into the part's frame: depth axis (sin rot, cos rot), width axis (cos rot, -sin rot).
  const s = Math.sin(p.rot);
  const c = Math.cos(p.rot);
  const along = dx * s + dz * c;
  const across = dx * c - dz * s;
  return Math.abs(across) <= p.hw + margin && Math.abs(along) <= p.hd + margin;
}

/** Labels fade out between these camera distances, so far ones don't crowd the horizon. */
const LABEL_FADE = [700, 1300];

export class Landmarks {
  readonly group = new Group();
  readonly list: LandmarkJson[];
  readonly parts: PlacedPart[] = [];
  private readonly labels: Sprite[] = [];

  constructor(data: LandmarksJson, groundAt: (x: number, z: number) => number) {
    this.list = data.landmarks;
    for (const l of this.list) {
      const placed = placeParts(l, groundAt);
      if (!placed.length) continue;
      this.parts.push(...placed);
      let top = 0;
      for (const p of placed) {
        const mat = new MeshStandardMaterial({ color: p.part.color, roughness: 0.85, flatShading: true });
        const part = p.part;
        const geo =
          part.shape === "box"
            ? new BoxGeometry(part.w, part.h, part.d)
            : part.shape === "cyl"
              ? new CylinderGeometry(part.r! * 0.92, part.r, part.h, 12)
              : new ConeGeometry(part.r, part.h, 12);
        const mesh = new Mesh(geo, mat);
        mesh.position.set(p.x, p.y0 + part.h / 2, p.z);
        mesh.rotation.y = p.rot;
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.name = l.id;
        this.group.add(mesh);
        top = Math.max(top, p.top);
      }
      const label = makeLabel(l.name);
      const c = lonLatToLocal(l.position.lon, l.position.lat);
      label.position.set(c.x, top + 6, c.z);
      this.labels.push(label);
      this.group.add(label);
    }
  }

  update(camera: Vector3): void {
    for (const l of this.labels) {
      const d = l.position.distanceTo(camera);
      const t = Math.min(1, Math.max(0, (d - LABEL_FADE[0]) / (LABEL_FADE[1] - LABEL_FADE[0])));
      l.material.opacity = 1 - t;
      l.visible = t < 1;
    }
  }
}

/** A name tag that always faces the camera, at a readable size whatever the distance. */
function makeLabel(text: string): Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = "600 44px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 48;
  canvas.width = w;
  canvas.height = 76;
  ctx.font = font;
  ctx.fillStyle = "rgba(20, 24, 32, 0.72)";
  ctx.beginPath();
  ctx.roundRect(0, 0, w, 76, 38);
  ctx.fill();
  ctx.fillStyle = "#f4ead6";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 24, 40);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  // A constant size on screen (sizeAttenuation off: scale is a fraction of the view height).
  const sprite = new Sprite(new SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, toneMapped: false, sizeAttenuation: false }));
  const h = 0.032;
  sprite.scale.set((w / 76) * h, h, 1);
  sprite.center.set(0.5, 0);
  sprite.name = `label:${text}`;
  return sprite;
}
