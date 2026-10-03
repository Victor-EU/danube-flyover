// The boat: a classic varnished-mahogany runabout in the manner of a 1960s Riva, 7 m long and
// 2.3 m in the beam, built in code. The hull is lofted from stations bow to stern (a V bottom
// with a chine and flared topsides under a rising sheer), with a cambered deck, an open
// cockpit with two leather benches behind a chrome-framed windscreen, a sun pad over the
// engine hatch and a Hungarian flag on a staff at the transom. It faces -Z, the stern at
// RIVA.stern, the waterline at y = 0. The mahogany is painted at load time onto canvases:
// planks with their grain and, on the deck, the pale caulking seams.

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SphereGeometry,
  SRGBColorSpace,
  type Texture,
  TorusGeometry,
  TubeGeometry,
  CatmullRomCurve3,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import earcut from "earcut";

/** Hull dimensions in metres: the bow's z, the length, the half beam. */
export const RIVA = { bow: -4.4, length: 7, halfBeam: 1.15, stern: 2.6 };

/** Stations (s from 0 at the bow to 1 at the transom) of the windscreen and the aft deck's edge. */
const S_SCREEN = 0.4;
const S_AFT = 0.73;
/** The side decks' width beside the cockpit, and the cockpit sole's height. */
const SIDE_DECK = 0.2;
const SOLE = 0.3;
/** The transom's rake (metres forward per metre up) and how far its middle bulges aft. */
const TRANSOM = { rake: 0.22, bulge: 0.1 };

const zAt = (s: number) => RIVA.bow + s * RIVA.length;
/** Half beam at the sheer: a fine entry, full amidships, tucked in a little at the transom. */
const beam = (s: number) => RIVA.halfBeam * (s < 0.6 ? 1 - Math.pow(1 - s / 0.6, 2.4) : 1 - 0.06 * ((s - 0.6) / 0.4) ** 2);
/** The sheer (deck edge) height: rising toward the bow. */
const sheer = (s: number) => 0.8 + 0.3 * Math.pow(1 - s, 2.2);
/** The chine: narrower than the sheer (the topsides flare) and climbing to the stem. */
const chineX = (s: number) => beam(s) * (0.86 + 0.08 * s);
const chineY = (s: number) => 0.12 + 0.56 * Math.pow(1 - s, 3);
/** Topsides bulging out between chine and sheer aft (tumblehome), straight forward. */
const tumble = (s: number) => 0.07 * Math.max(0, (s - 0.35) / 0.65);
/** The keel, level under most of the boat and sweeping up into the stem. */
const keel = (s: number) => -0.3 + 0.98 * Math.max(0, 1 - s / 0.36) ** 2;
/** Deck camber: this much higher on the centreline than at the sheer, at full beam. */
const CAMBER = 0.13;
const deckY = (s: number, x: number) => {
  const b = Math.max(beam(s), 1e-3);
  return sheer(s) + CAMBER * (b / RIVA.halfBeam) * (1 - Math.min(1, (x / b) ** 2));
};

// --- Textures -------------------------------------------------------------------------------

function hash(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/** Smooth value noise, tiling with period `p` in x. */
function noise(x: number, y: number, p: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const h = (i: number, j: number) => hash((((i % p) + p) % p) * 57.3 + j * 113.9);
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/**
 * Mahogany planking, one metre square, the grain running along v: planks `plank` metres wide
 * across u, each its own shade, with seams of `seam` colour between them.
 */
function mahogany(plank: number, seam: [number, number, number], seamWidth: number): Texture {
  const N = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(N, N);
  const planks = Math.round(1 / plank);
  for (let py = 0; py < N; py++)
    for (let px = 0; px < N; px++) {
      const u = px / N;
      const v = py / N;
      const k = Math.floor(u * planks);
      const inPlank = u * planks - k;
      const tone = 0.82 + 0.3 * hash(k + 3.7);
      // The grain: long streaks along the plank, wavering a little, with a fine figure.
      const waver = noise(k * 9.1, v * 3, 1e6) * 0.05;
      const streak = noise((u * planks + waver) * 22, v * 1.5 + k * 3.3, 22 * planks);
      const fine = noise(u * 400, v * 14 + k, 400);
      const g = 0.72 + 0.28 * streak + 0.08 * (fine - 0.5);
      const f = tone * g;
      let r = 0.42 * f;
      let gg = 0.15 * f;
      let b = 0.07 * f;
      // Seams between planks.
      const edge = Math.min(inPlank, 1 - inPlank) / planks;
      if (edge < seamWidth) {
        const t = 1 - edge / seamWidth;
        r += (seam[0] - r) * t;
        gg += (seam[1] - gg) * t;
        b += (seam[2] - b) * t;
      }
      const o = (py * N + px) * 4;
      img.data[o] = Math.min(255, r * 255 * 1.18);
      img.data[o + 1] = Math.min(255, gg * 255 * 1.18);
      img.data[o + 2] = Math.min(255, b * 255 * 1.18);
      img.data[o + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

// --- Geometry ----------------------------------------------------------------------------------

/** A surface through a grid of points (rows across, columns along), with UVs from `uv`. */
function sheet(rows: Vector3[][], uv: (p: Vector3) => [number, number], flip = false): BufferGeometry {
  const nr = rows.length;
  const nc = rows[0].length;
  const pos = new Float32Array(nr * nc * 3);
  const uvs = new Float32Array(nr * nc * 2);
  rows.forEach((row, i) =>
    row.forEach((p, j) => {
      const k = i * nc + j;
      pos.set([p.x, p.y, p.z], k * 3);
      uvs.set(uv(p), k * 2);
    }),
  );
  const idx: number[] = [];
  for (let i = 0; i + 1 < nr; i++)
    for (let j = 0; j + 1 < nc; j++) {
      const a = i * nc + j;
      const b = a + 1;
      const c = a + nc;
      const d = c + 1;
      if (flip) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("uv", new BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** The same surface on the port side: x mirrored, winding reversed. */
function mirrored(rows: Vector3[][]): Vector3[][] {
  return rows.map((r) => r.map((p) => new Vector3(-p.x, p.y, p.z)));
}

/** A flat polygon in a plane of constant z, triangulated to face +z. */
function flatPolygon(points: Vector3[], uv: (p: Vector3) => [number, number]): BufferGeometry {
  const flat: number[] = [];
  for (const p of points) flat.push(p.x, p.y);
  const tris = earcut(flat);
  // earcut keeps the ring's winding: make every triangle counter-clockwise seen from +z.
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    const cross = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
    if (cross < 0) [tris[t + 1], tris[t + 2]] = [c, b];
  }
  const pos = new Float32Array(points.length * 3);
  const uvs = new Float32Array(points.length * 2);
  points.forEach((p, i) => {
    pos.set([p.x, p.y, p.z], i * 3);
    uvs.set(uv(p), i * 2);
  });
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("uv", new BufferAttribute(uvs, 2));
  g.setIndex(tris);
  g.computeVertexNormals();
  return g;
}

const range = (n: number, f: (t: number, i: number) => number) => Array.from({ length: n + 1 }, (_, i) => f(i / n, i));

export interface Riva {
  group: Group;
  /** Navigation lights (port red, starboard green, stern white), brightened at night. */
  lamps: MeshBasicMaterial[];
  update(t: number, speed: number): void;
}

export function buildRiva(env: Texture): Riva {
  const group = new Group();
  group.name = "riva";

  // --- Materials
  const varnish = { clearcoat: 1, clearcoatRoughness: 0.05, roughness: 0.5, envMap: env, envMapIntensity: 0.65 };
  const hullWood = new MeshPhysicalMaterial({ map: mahogany(0.16, [0.12, 0.05, 0.03], 0.0012), ...varnish });
  const deckWood = new MeshPhysicalMaterial({ map: mahogany(0.1, [0.8, 0.72, 0.56], 0.0022), ...varnish, clearcoat: 0.8 });
  const bottom = new MeshPhysicalMaterial({ color: "#f3f1ea", roughness: 0.3, clearcoat: 0.6, envMap: env });
  const chrome = new MeshStandardMaterial({ color: "#f4f4f4", metalness: 1, roughness: 0.1, envMap: env, envMapIntensity: 1.2 });
  const leather = new MeshPhysicalMaterial({ color: "#cdb08a", roughness: 0.55, sheen: 0.4, sheenColor: new Color("#fff4dc"), envMap: env, envMapIntensity: 0.5 });
  const piping = new MeshStandardMaterial({ color: "#2f8f9d", roughness: 0.5, envMap: env, envMapIntensity: 0.5 });
  const sole = new MeshStandardMaterial({ color: "#3a2a20", roughness: 0.8 });
  const glass = new MeshPhysicalMaterial({ color: "#b8d2dc", roughness: 0.02, metalness: 0, transparent: true, opacity: 0.28, envMap: env, envMapIntensity: 1.4, side: DoubleSide, depthWrite: false });
  const dial = new MeshStandardMaterial({ color: "#14171a", roughness: 0.3 });

  const add = (g: BufferGeometry, m: Material, shadow = true) => {
    const mesh = new Mesh(g, m);
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  // --- Hull: bottom (keel to chine) and topsides (chine to sheer), each side.
  const ST = 48;
  const stations = range(ST, (t) => Math.pow(t, 0.85)); // closer together at the bow
  const bottomRows = range(4, (t) => t).map((t) =>
    stations.map((s) => {
      const y0 = keel(s);
      const y1 = chineY(s);
      return new Vector3(chineX(s) * t, y0 + (y1 - y0) * Math.pow(t, 0.85) - 0.025 * Math.sin(t * Math.PI), zAt(s));
    }),
  );
  const sideRows = range(6, (t) => t).map((t) =>
    stations.map((s) => {
      const x0 = chineX(s);
      const x1 = beam(s);
      return new Vector3(x0 + (x1 - x0) * Math.sin((t * Math.PI) / 2) + tumble(s) * Math.sin(t * Math.PI), chineY(s) + (sheer(s) - chineY(s)) * t, zAt(s));
    }),
  );
  const sideUv = (p: Vector3): [number, number] => [p.y * 1.0 + 0.02, p.z * 0.5];
  const bottomUv = (p: Vector3): [number, number] => [p.x, p.z];
  for (const side of [1, -1]) {
    const f = side < 0;
    add(sheet(f ? mirrored(bottomRows) : bottomRows, bottomUv, f), bottom);
    add(sheet(f ? mirrored(sideRows) : sideRows, sideUv, f), hullWood);
  }

  // --- Transom: the stern's outline (keel, chine, sheer, the cambered deck edge and back).
  {
    const s = 1;
    const z = zAt(s);
    const half: Vector3[] = [
      new Vector3(0, keel(s), z),
      ...range(4, (t) => t).slice(1).map((t) => new Vector3(chineX(s) * t, keel(s) + (chineY(s) - keel(s)) * Math.pow(t, 0.85) - 0.025 * Math.sin(t * Math.PI), z)),
      ...range(6, (t) => t).slice(1).map((t) => new Vector3(chineX(s) + (beam(s) - chineX(s)) * Math.sin((t * Math.PI) / 2) + tumble(s) * Math.sin(t * Math.PI), chineY(s) + (sheer(s) - chineY(s)) * t, z)),
    ];
    const deckEdge = range(10, (t) => t).map((t) => {
      const x = beam(s) * (1 - t);
      return new Vector3(x, deckY(s, x), z);
    });
    const starboard = [...half, ...deckEdge.slice(1)];
    const outline = [...starboard, ...starboard.slice(1, -1).reverse().map((p) => new Vector3(-p.x, p.y, p.z))];
    add(flatPolygon(outline, (p) => [p.y, p.x * 0.6]), hullWood);
  }

  // --- Deck: the foredeck to the windscreen, the side decks past the cockpit, the aft deck.
  const deckUv = (p: Vector3): [number, number] => [p.x * 1.0 + 0.5, p.z * 0.35];
  const deckPatch = (s0: number, s1: number, x0: (s: number) => number, x1: (s: number) => number, n: number) => {
    const ss = range(n, (t) => s0 + (s1 - s0) * t);
    const rows = range(8, (t) => t).map((t) =>
      ss.map((s) => {
        const x = x0(s) + (x1(s) - x0(s)) * t;
        return new Vector3(x, deckY(s, x) + 0.002, zAt(s));
      }),
    );
    add(sheet(rows, deckUv, true), deckWood);
  };
  const fore = stations.filter((s) => s <= S_SCREEN + 1e-6);
  // Foredeck: both halves in one patch, from port sheer to starboard sheer.
  {
    const ss = [...fore, S_SCREEN];
    const rows = range(16, (t) => t).map((t) =>
      ss.map((s) => {
        const x = beam(s) * (t * 2 - 1);
        return new Vector3(x, deckY(s, x) + 0.002, zAt(s));
      }),
    );
    add(sheet(rows, deckUv, true), deckWood);
  }
  const inner = (s: number) => beam(s) - SIDE_DECK;
  deckPatch(S_SCREEN, S_AFT, inner, beam, 12);
  deckPatch(S_SCREEN, S_AFT, (s) => -beam(s), (s) => -inner(s), 12);
  {
    const ss = range(14, (t) => S_AFT + (1 - S_AFT) * t);
    const rows = range(16, (t) => t).map((t) =>
      ss.map((s) => {
        const x = beam(s) * (t * 2 - 1);
        return new Vector3(x, deckY(s, x) + 0.002, zAt(s));
      }),
    );
    add(sheet(rows, deckUv, true), deckWood);
  }

  // --- Cockpit: the coaming's inner walls down to the sole, and the sole.
  {
    const ss = range(12, (t) => S_SCREEN + (S_AFT - S_SCREEN) * t);
    for (const side of [1, -1]) {
      const wall = [0, 1].map((k) => ss.map((s) => new Vector3(side * inner(s), k === 0 ? deckY(s, inner(s)) : SOLE, zAt(s))));
      add(sheet(wall, (p) => [p.y * 2, p.z * 0.5], side < 0), hullWood);
    }
    for (const s of [S_SCREEN, S_AFT]) {
      const xs = range(12, (t) => -inner(s) + 2 * inner(s) * t);
      const wall = [0, 1].map((k) => xs.map((x) => new Vector3(x, k === 0 ? deckY(s, x) : SOLE, zAt(s))));
      add(sheet(wall, (p) => [p.x, p.y * 2], s === S_AFT), hullWood);
    }
    const sole_ = [0, 1].map((k) => ss.map((s) => new Vector3((k * 2 - 1) * inner(s), SOLE, zAt(s))));
    add(sheet(sole_, (p) => [p.x, p.z], true), sole, false);
  }

  // --- Seats: a bench at the windscreen (the driver's) and one behind it, in cream leather
  // pleated into rolls, with turquoise piping.
  /** A cushion of `n` rolls side by side across x, w by h by d, centred on (x, y, z). */
  const pleated = (w: number, h: number, d: number, n: number, x: number, y: number, z: number, tilt = 0) => {
    const g = new Group();
    const rw = w / n;
    for (let k = 0; k < n; k++) {
      const roll = new Mesh(new RoundedBoxGeometry(rw - 0.006, h, d, 3, Math.min(h, rw) * 0.42), leather);
      roll.position.x = -w / 2 + rw * (k + 0.5);
      roll.castShadow = roll.receiveShadow = true;
      g.add(roll);
    }
    g.position.set(x, y, z);
    g.rotation.x = tilt;
    group.add(g);
    return g;
  };
  const bench = (s: number, w: number) => {
    const z = zAt(s);
    pleated(w, 0.15, 0.5, 6, 0, SOLE + 0.32, z);
    pleated(w, 0.48, 0.15, 6, 0, SOLE + 0.62, z + 0.3, -0.18);
    // Turquoise piping along the top of the backrest.
    const pipe = new Mesh(new CylinderGeometry(0.016, 0.016, w - 0.04, 8), piping);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(0, SOLE + 0.86, z + 0.35);
    pipe.castShadow = true;
    group.add(pipe);
  };
  bench(S_SCREEN + 0.06, 2 * inner(S_SCREEN + 0.06) - 0.06);
  bench(S_SCREEN + 0.19, 2 * inner(S_SCREEN + 0.19) - 0.06);

  // --- Dashboard and wheel (to starboard), gauges under the windscreen.
  {
    const z = zAt(S_SCREEN) + 0.04;
    const w = 2 * inner(S_SCREEN) - 0.04;
    const dash = new Mesh(new RoundedBoxGeometry(w, 0.32, 0.1, 2, 0.03), hullWood);
    dash.position.set(0, deckY(S_SCREEN, 0) - 0.12, z);
    group.add(dash);
    for (const x of [0.28, 0.42, 0.56, -0.2, -0.34]) {
      const g = new Mesh(new CylinderGeometry(0.04, 0.04, 0.02, 16), dial);
      g.rotation.x = Math.PI / 2;
      g.position.set(x, deckY(S_SCREEN, 0) - 0.08, z + 0.055);
      const bezel = new Mesh(new TorusGeometry(0.042, 0.007, 6, 18), chrome);
      bezel.position.copy(g.position);
      bezel.position.z += 0.012;
      group.add(g, bezel);
    }
    const wheel = new Group();
    const rim = new Mesh(new TorusGeometry(0.2, 0.017, 8, 32), new MeshStandardMaterial({ color: "#efe9dc", roughness: 0.35, envMap: env }));
    wheel.add(rim);
    for (let k = 0; k < 3; k++) {
      const spoke = new Mesh(new CylinderGeometry(0.008, 0.008, 0.2, 6), chrome);
      spoke.position.set(Math.cos((k * 2 * Math.PI) / 3) * 0.1, Math.sin((k * 2 * Math.PI) / 3) * 0.1, 0);
      spoke.rotation.z = (k * 2 * Math.PI) / 3 - Math.PI / 2;
      wheel.add(spoke);
    }
    const hub = new Mesh(new CylinderGeometry(0.035, 0.035, 0.04, 16), chrome);
    hub.rotation.x = Math.PI / 2;
    wheel.add(hub);
    wheel.position.set(0.42, deckY(S_SCREEN, 0) + 0.02, z + 0.22);
    wheel.rotation.x = -0.55;
    wheel.traverse((o) => (o.castShadow = true));
    group.add(wheel);
  }

  // --- Windscreen: curved glass in a chrome frame, raked back, wrapping round the sides.
  {
    const RAKE = 0.6; // metres back per metre up
    const H = 0.34;
    const s0 = S_SCREEN - 0.005;
    const arc = range(24, (t) => t).map((t) => {
      // Across the boat, then curving aft along the side decks.
      const a = (t * 2 - 1) * 1.0;
      const x = Math.sin(a * 1.2) / Math.sin(1.2) * (beam(s0) - 0.1);
      const z = zAt(s0) + (1 - Math.cos(a * 1.2)) * 0.32;
      return new Vector3(x, 0, z);
    });
    const base = arc.map((p) => new Vector3(p.x, deckY(S_SCREEN, p.x) + 0.01, p.z));
    const top = arc.map((p, i) => new Vector3(p.x * 0.97, base[i].y + H * (0.82 + 0.18 * Math.cos(((i / 24) * 2 - 1) * 1.4)), p.z + H * RAKE));
    add(sheet([base, top], (p) => [p.x, p.y]), glass, false).renderOrder = 2;
    const frame = (pts: Vector3[], r: number) => add(new TubeGeometry(new CatmullRomCurve3(pts), 48, r, 6, false), chrome);
    frame(top, 0.012);
    frame(base, 0.016);
    // The posts: at each end and the centre.
    for (const i of [0, 12, 24]) frame([base[i], top[i]], 0.011);
  }

  // --- Sun pad over the engine hatch, with a chrome grille behind it.
  {
    const s0 = S_AFT + 0.03;
    const s1 = S_AFT + 0.17;
    const w = 2 * beam(s1) - 0.5;
    pleated(w, 0.1, zAt(s1) - zAt(s0), 7, 0, deckY((s0 + s1) / 2, 0) + 0.035, (zAt(s0) + zAt(s1)) / 2);
    const grilleZ = zAt(S_AFT + 0.21);
    for (let k = -5; k <= 5; k++) {
      const bar = new Mesh(new CylinderGeometry(0.008, 0.008, 0.22, 6), chrome);
      bar.rotation.x = Math.PI / 2;
      bar.position.set(k * 0.035, deckY(S_AFT + 0.21, 0) + 0.008, grilleZ);
      group.add(bar);
    }
  }

  // --- Chrome: the rubbing strakes along the sheer, the stem band, cleats, the flagstaff.
  {
    for (const side of [1, -1]) {
      const pts = stations.map((s) => new Vector3(side * (beam(s) + 0.012), sheer(s) - 0.012, zAt(s)));
      add(new TubeGeometry(new CatmullRomCurve3(pts), 96, 0.018, 6, false), chrome);
    }
    // The band runs up the stem from the forefoot to the deck.
    const band = [new Vector3(0, 0.25, zAt(0.05) - 0.005), new Vector3(0, 0.55, zAt(0.012) - 0.006), new Vector3(0, deckY(0, 0) + 0.005, zAt(0) - 0.004)];
    add(new TubeGeometry(new CatmullRomCurve3(band), 16, 0.015, 6, false), chrome);
    const cleat = (s: number, x: number) => {
      const c = new Mesh(new CylinderGeometry(0.012, 0.012, 0.18, 8), chrome);
      c.rotation.x = Math.PI / 2;
      c.position.set(x, deckY(s, x) + 0.035, zAt(s));
      const foot = new Mesh(new CylinderGeometry(0.018, 0.024, 0.035, 8), chrome);
      foot.position.set(x, deckY(s, x) + 0.018, zAt(s));
      group.add(c, foot);
    };
    cleat(0.06, 0);
    for (const side of [1, -1]) cleat(0.97, side * (beam(0.97) - 0.18));
    // A light on a short staff at the bow.
    const bowStaff = new Mesh(new CylinderGeometry(0.008, 0.01, 0.32, 6), chrome);
    bowStaff.position.set(0, deckY(0.035, 0) + 0.16, zAt(0.035));
    group.add(bowStaff);
  }

  // --- The transom's trim: a chrome strip along its top edge, a boarding ladder to starboard
  // and the twin exhausts near the waterline.
  {
    const s = 1;
    const z = zAt(s) + 0.01;
    const edge = range(20, (t) => t * 2 - 1).map((u) => {
      const x = u * (beam(s) - 0.01);
      return new Vector3(x, deckY(s, x) - 0.01, z);
    });
    add(new TubeGeometry(new CatmullRomCurve3(edge), 40, 0.013, 6, false), chrome);
    const xL = beam(s) * 0.55;
    for (const dx of [-0.085, 0.085]) {
      const rail = [new Vector3(xL + dx, deckY(s, xL) + 0.015, z - 0.05), new Vector3(xL + dx, deckY(s, xL) + 0.02, z + 0.04), new Vector3(xL + dx, 0.25, z + 0.055)];
      add(new TubeGeometry(new CatmullRomCurve3(rail), 12, 0.008, 6, false), chrome);
    }
    for (const y of [0.5, 0.32]) {
      const rung = new Mesh(new CylinderGeometry(0.008, 0.008, 0.17, 6), chrome);
      rung.rotation.z = Math.PI / 2;
      rung.position.set(xL, y, z + 0.055);
      group.add(rung);
    }
    for (const x of [-0.45, 0.45]) {
      const pipe = new Mesh(new CylinderGeometry(0.055, 0.055, 0.06, 16, 1, true), chrome);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(x, 0.2, z + 0.02);
      const hole = new Mesh(new CylinderGeometry(0.045, 0.045, 0.01, 16), dial);
      hole.rotation.x = Math.PI / 2;
      hole.position.set(x, 0.2, z + 0.035);
      group.add(pipe, hole);
    }
  }

  // --- Navigation lights: red to port and green to starboard on the side decks by the
  // windscreen, white at the top of the flagstaff.
  const lamps: MeshBasicMaterial[] = [];
  const lamp = (color: string, x: number, y: number, z: number, r = 0.022) => {
    const m = new MeshBasicMaterial({ color });
    m.userData.base = m.color.clone();
    lamps.push(m);
    const mesh = new Mesh(new SphereGeometry(r, 10, 8), m);
    mesh.position.set(x, y, z);
    group.add(mesh);
  };
  lamp("#ff3a2a", -(beam(S_SCREEN + 0.03) - 0.07), deckY(S_SCREEN + 0.03, beam(S_SCREEN + 0.03) - 0.07) + 0.03, zAt(S_SCREEN + 0.03));
  lamp("#3dff6a", beam(S_SCREEN + 0.03) - 0.07, deckY(S_SCREEN + 0.03, beam(S_SCREEN + 0.03) - 0.07) + 0.03, zAt(S_SCREEN + 0.03));
  lamp("#fff6e0", 0, deckY(0.035, 0) + 0.33, zAt(0.035), 0.02);

  // --- The flag: Hungary's tricolour on a staff raked over the transom, streaming aft.
  const FLAG = { w: 0.48, h: 0.32, nx: 16, ny: 6 };
  const flagGeo = new PlaneGeometry(FLAG.w, FLAG.h, FLAG.nx, FLAG.ny);
  flagGeo.rotateY(Math.PI / 2); // in the y-z plane, the free end toward +z
  const flagRest = Float32Array.from(flagGeo.attributes.position.array as Float32Array);
  const stripes = document.createElement("canvas");
  stripes.width = 8;
  stripes.height = 96;
  const sctx = stripes.getContext("2d")!;
  ["#ce2939", "#f4f1ea", "#477050"].forEach((c, i) => {
    sctx.fillStyle = c;
    sctx.fillRect(0, i * 32, 8, 32);
  });
  const flagTex = new CanvasTexture(stripes);
  flagTex.colorSpace = SRGBColorSpace;
  const flagMat = new MeshStandardMaterial({ map: flagTex, roughness: 0.8, side: DoubleSide });
  const flag = new Mesh(flagGeo, flagMat);
  flag.castShadow = true;
  const staff = new Group();
  const pole = new Mesh(new CylinderGeometry(0.009, 0.012, 0.85, 8), chrome);
  pole.position.y = 0.425;
  const finial = new Mesh(new SphereGeometry(0.018, 8, 6), chrome);
  finial.position.y = 0.85;
  flag.position.set(0, 0.85 - FLAG.h / 2 - 0.02, FLAG.w / 2 + 0.012);
  staff.add(pole, finial, flag);
  staff.position.set(0, deckY(1, 0), zAt(1) - 0.08);
  staff.rotation.x = 0.35; // raked aft
  group.add(staff);

  // The transom: raked forward at the top and curved in plan, blended in over the last metre.
  const z0 = zAt(0.86);
  const z1 = zAt(1);
  const yKeel = keel(1);
  const hb = beam(1);
  const warpZ = (x: number, y: number, z: number) => {
    const t = Math.min(1, Math.max(0, (z - z0) / (z1 - z0)));
    const w = t * t * (3 - 2 * t);
    return z + w * (-(y - yKeel) * TRANSOM.rake + TRANSOM.bulge * (1 - Math.min(1, (x / hb) ** 2)));
  };
  for (const o of group.children) {
    const mesh = o as Mesh;
    if (mesh.isMesh && mesh.position.lengthSq() === 0) {
      const p = mesh.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) p.setZ(i, warpZ(p.getX(i), p.getY(i), p.getZ(i)));
      mesh.geometry.computeVertexNormals();
    } else o.position.z = warpZ(o.position.x, o.position.y, o.position.z);
  }

  return {
    group,
    lamps,
    update(t: number, speed: number) {
      // The flag streams and ripples harder with speed (plus a breeze when idle).
      const p = flagGeo.attributes.position;
      const k = 0.35 + Math.min(1, speed / 10) * 0.65;
      for (let i = 0; i < p.count; i++) {
        const z0 = flagRest[i * 3 + 2] + FLAG.w / 2; // 0 at the staff
        const y0 = flagRest[i * 3 + 1];
        const a = z0 / FLAG.w;
        const wave = Math.sin(z0 * 11 - t * (6 + 8 * k) + y0 * 2) * 0.05 * a * (0.5 + k) + Math.sin(z0 * 23 - t * 13) * 0.012 * a;
        p.setX(i, wave);
        // A slack flag droops at its free end.
        p.setY(i, y0 - (1 - k) * a * a * 0.12);
      }
      p.needsUpdate = true;
      flagGeo.computeVertexNormals();
    },
  };
}
