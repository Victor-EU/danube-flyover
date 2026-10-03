// The river's craft, built in code: the sightseeing boats that ply the river, the
// river-cruise hotel ships moored along the quays, and the steel landing pontoons. Each is a
// pair of geometries: the body (vertex colours) and its glazing, whose windows light one by
// one after dusk. Ships face -Z, their waterline at y = 0; a pontoon's ramp climbs to the quay
// on its left (-X).

import { BoxGeometry, BufferAttribute, BufferGeometry, Color, Float32BufferAttribute, type Material, MeshStandardMaterial, type Texture } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import earcut from "earcut";
import { SHARED } from "./world/night";
import { HASH_GLSL, patchMaterial } from "./world/shaderPatch";

type Ring = [number, number][];

export interface Craft {
  body: BufferGeometry;
  glass: BufferGeometry;
}

const WHITE = "#f1efe9";
const NAVY = "#203a5c";
const DECK = "#8e8a82";
const STEEL = "#3c4144";

/** Half the beam at z along a hull of length L: a spoon bow and a rounded stern. */
function hullPlan(L: number, B: number, bow: number, stern: number, steps = 18): Ring {
  const half = B / 2;
  const side: [number, number][] = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const z = -L / 2 + t * L;
    let w = half;
    const fromBow = z + L / 2;
    const fromStern = L / 2 - z;
    if (fromBow < bow) w = half * Math.sqrt(Math.max(0, 1 - ((bow - fromBow) / bow) ** 2)) ** 0.8;
    if (fromStern < stern) w = Math.min(w, half * Math.sqrt(Math.max(0, 1 - ((stern - fromStern) / stern) ** 2)));
    side.push([Math.max(w, 0.05), z]);
  }
  // Counter-clockwise seen from above in (x, z): down the starboard side, back up the port.
  return [...side.map(([w, z]) => [w, z] as [number, number]), ...side.reverse().map(([w, z]) => [-w, z] as [number, number])];
}

/** A ring shrunk toward its centre line by `inset` metres across and trimmed at the ends. */
function deckPlan(B: number, z0: number, z1: number, inset: number, round: number): Ring {
  const half = B / 2 - inset;
  const pts: [number, number][] = [];
  const steps = 6;
  for (let k = 0; k <= steps; k++) {
    const a = (k / steps) * (Math.PI / 2);
    pts.push([half - round + Math.sin(a) * round, z0 + round - Math.cos(a) * round]);
  }
  for (let k = 0; k <= steps; k++) {
    const a = (k / steps) * (Math.PI / 2);
    pts.push([half - round + Math.cos(a) * round, z1 - round + Math.sin(a) * round]);
  }
  const mirrored = pts.map(([x, z]) => [-x, z] as [number, number]).reverse();
  return [...pts, ...mirrored];
}

class Parts {
  readonly body: BufferGeometry[] = [];
  readonly glass: BufferGeometry[] = [];

  /** Walls around a ring from y0 to y1 (flat-shaded quads), coloured; uv u is metres around. */
  walls(ring: Ring, y0: number, y1: number, colour: string, glass = false, deck = 0): void {
    const pos: number[] = [];
    const nor: number[] = [];
    const uv: number[] = [];
    let along = 0;
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i];
      const [bx, bz] = ring[(i + 1) % ring.length];
      const l = Math.hypot(bx - ax, bz - az);
      if (l < 1e-4) continue;
      // Outward for a counter-clockwise ring in (x, z).
      const nx = (bz - az) / l;
      const nz = -(bx - ax) / l;
      const quad = [[ax, y0, az, along, 0], [bx, y0, bz, along + l, 0], [bx, y1, bz, along + l, 1], [ax, y1, az, along, 1]];
      for (const k of [0, 2, 1, 0, 3, 2]) {
        const q = quad[k];
        pos.push(q[0], q[1], q[2]);
        nor.push(nx, 0, nz);
        uv.push(q[3], deck + q[4]);
      }
      along += l;
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new Float32BufferAttribute(nor, 3));
    g.setAttribute("uv", new Float32BufferAttribute(uv, 2));
    if (glass) this.glass.push(g);
    else this.body.push(paint(g, colour));
  }

  /** A flat cap over a ring at y, facing up (or down). */
  cap(ring: Ring, y: number, colour: string, down = false): void {
    const flat = ring.flatMap(([x, z]) => [x, z]);
    const tris = earcut(flat);
    const pos: number[] = [];
    for (let t = 0; t < tris.length; t += 3) {
      let [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
      // Wound to face up (or down): the y of (b - a) × (c - a) is dz·ex − dx·ez.
      const cy = (flat[c * 2 + 1] - flat[a * 2 + 1]) * (flat[b * 2] - flat[a * 2]) - (flat[c * 2] - flat[a * 2]) * (flat[b * 2 + 1] - flat[a * 2 + 1]);
      if (cy < 0 !== down) [b, c] = [c, b];
      for (const i of [a, b, c]) pos.push(flat[i * 2], y, flat[i * 2 + 1]);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    g.setAttribute("uv", new Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
    this.body.push(paint(g, colour));
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, colour: string): void {
    const g = new BoxGeometry(w, h, d).toNonIndexed();
    g.translate(x, y + h / 2, z);
    this.body.push(paint(g, colour));
  }

  /** A railing round a ring at deck height y: posts every 2.5 m, a top rail and a mid rail. */
  railing(ring: Ring, y: number, colour = WHITE): void {
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i];
      const [bx, bz] = ring[(i + 1) % ring.length];
      const l = Math.hypot(bx - ax, bz - az);
      if (l < 0.05) continue;
      const a = Math.atan2(bx - ax, bz - az);
      for (const [h, t] of [[1.05, 0.06], [0.5, 0.035]]) {
        const g = new BoxGeometry(t, t, l).toNonIndexed();
        g.rotateY(a);
        g.translate((ax + bx) / 2, y + h, (az + bz) / 2);
        this.body.push(paint(g, colour));
      }
      for (let d = 0; d < l; d += 2.5) {
        const t = d / l;
        this.box(0.05, 1.05, 0.05, ax + (bx - ax) * t, y, az + (bz - az) * t, colour);
      }
    }
  }

  /** A deck house: solid below the windows, a glazed band, solid above, and a roof. */
  house(ring: Ring, y0: number, h: number, sill: number, head: number, colour: string, roof: string, deck: number): void {
    this.walls(ring, y0, y0 + sill, colour);
    this.walls(ring, y0 + sill, y0 + h - head, colour, true, deck);
    this.walls(ring, y0 + h - head, y0 + h, colour);
    this.cap(ring, y0 + h, roof);
  }

  build(): Craft {
    const body = mergeGeometries(this.body.map((g) => (g.index ? g.toNonIndexed() : g)))!;
    const glass = mergeGeometries(this.glass)!;
    return { body, glass };
  }
}

function paint(g: BufferGeometry, colour: string): BufferGeometry {
  const c = new Color(colour);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("color", new BufferAttribute(arr, 3));
  if (!g.attributes.uv) g.setAttribute("uv", new Float32BufferAttribute(new Float32Array(n * 2), 2));
  return g;
}

/** A hull: the plan extruded from below the waterline to the deck, a boot band at the water. */
function hull(p: Parts, L: number, B: number, freeboard: number, bow: number, stern: number, band: string): Ring {
  const plan = hullPlan(L, B, bow, stern);
  p.walls(plan, -1.2, 0.5, band);
  p.walls(plan, 0.5, freeboard - 0.25, WHITE);
  p.walls(plan, freeboard - 0.25, freeboard, band);
  p.cap(plan, freeboard, DECK);
  return plan;
}

/** A Danube sightseeing boat, about 32 m: a glazed saloon, an open top deck, a wheelhouse forward. */
export function sightseeingBoat(): Craft {
  const p = new Parts();
  const L = 32;
  const B = 6.6;
  const F = 1.3;
  hull(p, L, B, F, 7, 2.6, NAVY);
  const saloon = deckPlan(B, -L / 2 + 6.5, L / 2 - 2.2, 0.35, 1.2);
  p.house(saloon, F, 2.5, 0.7, 0.35, WHITE, "#e4e2dc", 0);
  // The top deck: railing round the saloon roof, benches, the wheelhouse at its front.
  const top = F + 2.5;
  p.railing(deckPlan(B, -L / 2 + 6.7, L / 2 - 2.4, 0.45, 1.1), top);
  const wheel = deckPlan(B * 0.55, -L / 2 + 7.2, -L / 2 + 10.4, 0.2, 0.6);
  p.house(wheel, top, 2.1, 0.8, 0.25, WHITE, NAVY, 1);
  for (let z = -L / 2 + 12; z < L / 2 - 4; z += 2.2) for (const x of [-1.5, 1.5]) p.box(2, 0.45, 0.5, x, top, z, "#6b4e36");
  return p.build();
}

/** A river-cruise hotel ship of length L: three decks of windows, a sun deck, the bridge forward. */
export function cruiseShip(L: number): Craft {
  const p = new Parts();
  const B = 11.4;
  const F = 2.3;
  hull(p, L, B, F, 13, 3.5, NAVY);
  // The lowest deck's small windows are in the hull's side: a glazed strip.
  p.walls(hullPlan(L * 0.86, B + 0.02, 8, 2), 0.9, 1.45, WHITE, true, 0);
  const deck2 = deckPlan(B, -L / 2 + 12, L / 2 - 4, 0.25, 2.5);
  p.house(deck2, F, 2.8, 0.55, 0.45, WHITE, WHITE, 1);
  const deck3 = deckPlan(B, -L / 2 + 14, L / 2 - 5, 0.3, 2.5);
  p.house(deck3, F + 2.8, 2.8, 0.55, 0.45, WHITE, "#7b8a8e", 2);
  const sun = F + 5.6;
  p.railing(deckPlan(B, -L / 2 + 14.2, L / 2 - 5.2, 0.4, 2.3), sun);
  // The bridge: a wide low wheelhouse, glazed all round, near the bow.
  p.house(deckPlan(B * 0.8, -L / 2 + 15, -L / 2 + 20, 0.2, 1), sun, 2.4, 0.9, 0.25, WHITE, WHITE, 3);
  // Awnings over the sun deck aft, a pool box, loungers.
  for (const z of [L * 0.12, L * 0.3]) {
    p.box(B - 2.4, 0.12, 7, 0, sun + 2.6, z, "#e7e3d8");
    for (const [x, dz] of [[-(B / 2 - 1.4), -3.3], [B / 2 - 1.4, -3.3], [-(B / 2 - 1.4), 3.3], [B / 2 - 1.4, 3.3]]) p.box(0.1, 2.6, 0.1, x, sun, z + dz, "#d8d4c8");
  }
  for (let z = -L / 2 + 24; z < L / 2 - 10; z += 3) for (const x of [-3.4, 3.4]) p.box(0.7, 0.35, 1.9, x, sun, z, "#cfc7b6");
  // The foredeck's mooring gear.
  p.box(2.2, 0.8, 1.6, 0, F, -L / 2 + 7, STEEL);
  return p.build();
}

/** A landing pontoon of length L: a steel float, a shelter, railings, and the ramp to the quay. */
export function pontoon(L: number, gap: number): Craft {
  const p = new Parts();
  const W = 6;
  const F = 1.1;
  const plan: Ring = [[W / 2, -L / 2], [W / 2, L / 2], [-W / 2, L / 2], [-W / 2, -L / 2]];
  p.walls(plan, -0.8, F, STEEL);
  p.cap(plan, F, "#5c5f5e");
  p.railing([[W / 2 - 0.15, -L / 2 + 0.3], [W / 2 - 0.15, L / 2 - 0.3]].map(([x, z]) => [x, z]) as Ring, F, "#2e5a7a");
  const shelter = deckPlan(3.2, -2.5, 2.5, 0, 0.2);
  for (const r of [shelter]) for (const pt of r) pt[0] += 0.6;
  p.house(shelter, F, 2.5, 0.9, 0.3, "#e9e6df", "#2e5a7a", 0);
  // The ramp: from the float's landward edge up to the quay's top, 4.5 m above the water.
  const run = Math.max(6, gap + 2);
  const g = new BoxGeometry(2.2, 0.25, Math.hypot(run, 3.4)).toNonIndexed();
  g.rotateX(-Math.atan2(3.4, run));
  g.rotateY(-Math.PI / 2);
  g.translate(-W / 2 - run / 2, F + 1.7, 0);
  p.body.push(paint(g, "#4a4f52"));
  return p.build();
}

/**
 * The craft's two materials: painted steel (vertex colours) and glazing whose panes, 1.6 m
 * apart, light one by one at dusk, about two in three.
 */
export function craftMaterials(env: Texture): { body: Material; glass: MeshStandardMaterial } {
  const body = new MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, envMap: env, envMapIntensity: 0.5 });
  const glass = new MeshStandardMaterial({ color: "#26323a", roughness: 0.12, metalness: 0.4, envMap: env, envMapIntensity: 1, emissive: "#ffcf8f", emissiveIntensity: 0 });
  patchMaterial(glass, {
    key: "craftGlass",
    uniforms: { uSunElevation: SHARED.uSunElevation },
    vertexPars: "varying vec2 vPane;",
    vertex: [["uv_vertex", "vPane = uv;"]],
    fragmentPars: `uniform float uSunElevation;\nvarying vec2 vPane;\n${HASH_GLSL}`,
    fragment: [
      [
        "emissivemap_fragment",
        /* glsl */ `
        {
          float pane = floor(vPane.x / 1.6);
          float deck = floor(vPane.y);
          float frame = step(0.9, fract(vPane.x / 1.6)) + step(0.92, fract(vPane.y)) + step(fract(vPane.y), 0.06);
          float h = hash12(vec2(pane, deck + 17.0));
          float at = 2.0 - 12.0 * hash12(vec2(deck, pane * 1.7));
          float on = smoothstep(at + 0.5, at - 0.5, uSunElevation) * step(0.34, h) * (1.0 - min(frame, 1.0));
          totalEmissiveRadiance = vec3(1.0, 0.72, 0.42) * on * (0.35 + 0.4 * h);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92), min(frame, 1.0));
        }`,
      ],
    ],
  });
  return { body, glass };
}
