// Grows the trees: each species of TREE_SPECIES (src/config.ts) in TREE_VARIANTS shapes, each
// at three levels of detail, and paints the leaf clusters their crowns are made of.
//   public/data/trees/trees.glb    a mesh per species, variant and level: bark tubes (trunk
//                                  and limbs) and leaf cards, `_KIND` 0 for bark, 1 for leaves
//   public/data/trees/leaves.webp  one 512² layer per species, stacked: R the leaf's shading,
//                                  G a random value per leaf (the runtime turns some leaves
//                                  autumn-coloured by it), B the twigs, A coverage
// The crowns are ellipsoids roughened by noise; limbs grow from the trunk toward their edge,
// branches from the limbs, and leaf cards cluster around the branch ends and fill the crown's
// shell. Card normals lean out from the crown's centre, so the foliage shades as a volume.
// Usage: npm run build-trees

import { mkdirSync } from "node:fs";
import sharp from "sharp";
import { TREE_SPECIES, TREE_VARIANTS, type TreeSpecies } from "../src/config";
import { mulberry32 } from "./lib/geom";
import { writeGlb, type MeshDef } from "./lib/gltf";
import { DATA_DIR, kb } from "./lib/io";

type V3 = [number, number, number];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1));
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp3 = (a: V3, b: V3, t: number): V3 => add(a, mul(sub(b, a), t));

/** How each species grows. Lengths are fractions of the tree's height or crown radius. */
interface Habit {
  /** Height of the crown's base, as a share of the height. */
  crownBase: number;
  /** Limb count and elevation above horizontal (degrees). */
  limbs: [number, number];
  elevation: [number, number];
  /** How much limbs bend up (+) or down (-) as they grow. */
  tropism: number;
  /** Trunk carries on as a leader through the crown (poplar, pine). */
  leader: number;
  /** Leaf card size (m) at level 0, and how many cards. */
  card: number;
  cards: number;
  /** Crown roughness, and its flatness (vertical radius over horizontal). */
  rough: number;
  weeping?: boolean;
  conifer?: boolean;
  trunkRadius: number;
}

const HABITS: Record<TreeSpecies, Habit> = {
  plane: { crownBase: 0.28, limbs: [5, 7], elevation: [28, 48], tropism: 0.25, leader: 0.55, card: 1.5, cards: 420, rough: 0.22, trunkRadius: 0.024 },
  chestnut: { crownBase: 0.27, limbs: [5, 7], elevation: [32, 52], tropism: 0.2, leader: 0.4, card: 1.4, cards: 380, rough: 0.12, trunkRadius: 0.026 },
  linden: { crownBase: 0.3, limbs: [5, 8], elevation: [40, 62], tropism: 0.3, leader: 0.7, card: 1.25, cards: 380, rough: 0.12, trunkRadius: 0.022 },
  maple: { crownBase: 0.3, limbs: [5, 7], elevation: [35, 55], tropism: 0.25, leader: 0.5, card: 1.2, cards: 330, rough: 0.14, trunkRadius: 0.024 },
  poplar: { crownBase: 0.22, limbs: [6, 8], elevation: [52, 70], tropism: 0.45, leader: 0.85, card: 1.3, cards: 380, rough: 0.25, trunkRadius: 0.022 },
  willow: { crownBase: 0.25, limbs: [5, 7], elevation: [40, 60], tropism: -0.55, leader: 0.4, card: 1.5, cards: 340, rough: 0.15, weeping: true, trunkRadius: 0.03 },
  oak: { crownBase: 0.3, limbs: [5, 7], elevation: [18, 40], tropism: 0.15, leader: 0.45, card: 1.3, cards: 340, rough: 0.28, trunkRadius: 0.028 },
  robinia: { crownBase: 0.35, limbs: [4, 6], elevation: [35, 60], tropism: 0.3, leader: 0.5, card: 1.3, cards: 260, rough: 0.3, trunkRadius: 0.02 },
  pine: { crownBase: 0.55, limbs: [7, 10], elevation: [-5, 20], tropism: 0.35, leader: 0.95, card: 1.4, cards: 260, rough: 0.2, conifer: true, trunkRadius: 0.022 },
};

/** Cards and bark sides per level of detail. */
const LODS = [
  { cards: 1, cardSize: 1, sides: [8, 6, 4], limbs: true, branches: true, trunkStep: 1 },
  { cards: 0.3, cardSize: 2.3, sides: [6, 0, 0], limbs: false, branches: false, trunkStep: 2 },
  { cards: 0.075, cardSize: 4.4, sides: [4, 0, 0], limbs: false, branches: false, trunkStep: 3 },
];

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  kind: number[] = [];
  idx: number[] = [];
  private v(p: V3, n: V3, u: number, w: number, k: number): number {
    this.pos.push(...p);
    this.nor.push(...n);
    this.uv.push(u, w);
    this.kind.push(k);
    return this.kind.length - 1;
  }
  /** A tapering tube through `pts` with radii `r`, `sides` around; UVs in metres. */
  tube(pts0: V3[], r0: number[], sides: number): void {
    // Drop points that don't move on (a zero-length segment has no direction).
    const pts: V3[] = [];
    const r: number[] = [];
    pts0.forEach((p, i) => {
      if (pts.length && len(sub(p, pts[pts.length - 1])) < 0.02) return;
      pts.push(p);
      r.push(r0[i]);
    });
    if (sides < 3 || pts.length < 2) return;
    const rings: number[][] = [];
    let along = 0;
    let ref: V3 = [1, 0, 0];
    for (let i = 0; i < pts.length; i++) {
      const t = norm(sub(pts[Math.min(i + 1, pts.length - 1)], pts[Math.max(i - 1, 0)]));
      if (Math.abs(t[1]) < 0.95) ref = [0, 1, 0];
      const a = norm(cross(t, ref));
      const b = cross(t, a);
      if (i > 0) along += len(sub(pts[i], pts[i - 1]));
      const ring: number[] = [];
      for (let s = 0; s <= sides; s++) {
        const th = (s / sides) * Math.PI * 2;
        const n = add(mul(a, Math.cos(th)), mul(b, Math.sin(th)));
        ring.push(this.v(add(pts[i], mul(n, r[i])), n, (s / sides) * Math.max(0.5, Math.PI * 2 * r[0]), along, 0));
      }
      rings.push(ring);
    }
    for (let i = 0; i + 1 < rings.length; i++)
      for (let s = 0; s < sides; s++) {
        const a = rings[i][s], b = rings[i][s + 1], c = rings[i + 1][s], d = rings[i + 1][s + 1];
        this.idx.push(a, c, b, b, c, d);
      }
  }
  /** A leaf card centred at `p`, facing `n`, `size` across, its shading normal leaning out from `centre`. */
  card(p: V3, n: V3, up: V3, size: number, centre: V3, rand: () => number): void {
    const right = norm(cross(up, n));
    const top = norm(cross(n, right));
    const radial = norm(sub(p, centre));
    const shade = norm(add(mul(radial, 0.75), mul(n, 0.25)));
    const h = size / 2;
    // Random quarter turns and mirroring, so neighbouring cards don't repeat.
    const turn = Math.floor(rand() * 4);
    const flip = rand() < 0.5;
    const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const uvs: [number, number][] = [[0, 1], [1, 1], [1, 0], [0, 0]];
    const ids = corners.map(([cx, cy], k) => {
      const uv = uvs[(k + turn) % 4];
      return this.v(add(p, add(mul(right, cx * h), mul(top, cy * h))), shade, flip ? 1 - uv[0] : uv[0], uv[1], 1);
    });
    this.idx.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
  }
}

/** One tree: its crown envelope, limbs and branches (as polylines), and leaf positions. */
function grow(species: TreeSpecies, seed: number) {
  const sp = TREE_SPECIES.find((s) => s.name === species)!;
  const h = HABITS[species];
  const rand = mulberry32(seed);
  const H = sp.height;
  const R = sp.radius;
  const base = H * h.crownBase;
  const conifer = !!h.conifer;
  // The crown: an ellipsoid (a cone-topped one for the pine) around (0, cy, 0).
  const cy = conifer ? H * 0.78 : base + (H - base) * 0.52;
  const ry = conifer ? H * 0.22 : (H - base) * 0.5;
  const ph = [rand() * 6.28, rand() * 6.28, rand() * 6.28];
  const radiusAt = (az: number, y: number) => {
    const n = 1 + h.rough * (0.6 * Math.sin(3 * az + ph[0]) + 0.4 * Math.sin(5 * az + ph[1]) + 0.3 * Math.sin(2 * az + y * 0.3 + ph[2]));
    return R * n;
  };
  const inside = (p: V3) => {
    const az = Math.atan2(p[2], p[0]);
    const rr = radiusAt(az, p[1]);
    return (p[0] * p[0] + p[2] * p[2]) / (rr * rr) + ((p[1] - cy) / ry) ** 2 <= 1;
  };
  const centre: V3 = [0, cy, 0];
  // The trunk, leaning a little, as a leader through part of the crown.
  const lean: V3 = [(rand() - 0.5) * 0.06 * H, 0, (rand() - 0.5) * 0.06 * H];
  const top = base + (H - base) * h.leader;
  const trunk: V3[] = [];
  for (let k = 0; k <= 6; k++) {
    const t = k / 6;
    const y = top * t;
    trunk.push([lean[0] * t * t + (rand() - 0.5) * 0.15, y, lean[2] * t * t + (rand() - 0.5) * 0.15]);
  }
  const r0 = H * h.trunkRadius;
  const trunkR = trunk.map((_, k) => r0 * (1 - 0.75 * (k / 6)) * (k === 0 ? 1.25 : 1));
  const trunkAt = (y: number): V3 => {
    const t = Math.min(1, Math.max(0, y / top)) * 6;
    const k = Math.min(5, Math.floor(t));
    return lerp3(trunk[k], trunk[k + 1], t - k);
  };
  /** Grows a polyline from p along d, bending by tropism, until it leaves the crown (or maxLen). */
  const reach = (p: V3, d: V3, maxLen: number, tropism: number, steps = 5): V3[] => {
    const pts: V3[] = [p];
    let dir = norm(d);
    let cur = p;
    const seg = maxLen / steps;
    for (let s = 0; s < steps; s++) {
      dir = norm(add(dir, [(rand() - 0.5) * 0.25, tropism * 0.35, (rand() - 0.5) * 0.25]));
      const next = add(cur, mul(dir, seg));
      if (s > 0 && !inside(mul(add(next, [0, 0, 0]), 1))) {
        // Stop at the crown's edge (a little inside).
        let lo = 0, hi = 1;
        for (let k = 0; k < 8; k++) {
          const m = (lo + hi) / 2;
          if (inside(lerp3(cur, next, m))) lo = m;
          else hi = m;
        }
        const end = lerp3(cur, next, lo * 0.95);
        if (len(sub(end, cur)) > 0.05) pts.push(end);
        break;
      }
      pts.push(next);
      cur = next;
    }
    return pts;
  };
  const limbs: { pts: V3[]; r: number[] }[] = [];
  const branches: { pts: V3[]; r: number[] }[] = [];
  const nLimbs = h.limbs[0] + Math.floor(rand() * (h.limbs[1] - h.limbs[0] + 1));
  for (let i = 0; i < nLimbs; i++) {
    const at = conifer ? base + (top - base) * (0.05 + 0.9 * (i / nLimbs)) : base + (top - base) * (0.05 + 0.75 * rand());
    const az = i * 2.39996 + rand() * 0.6;
    const el = ((h.elevation[0] + rand() * (h.elevation[1] - h.elevation[0])) * Math.PI) / 180;
    const d: V3 = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
    const start = trunkAt(at);
    const pts = reach(start, d, (conifer ? R * 1.1 : R * 1.5) * (0.85 + rand() * 0.3), h.tropism * (h.weeping ? 1 : 1));
    const rs = r0 * (conifer ? 0.22 : 0.5) * (1 - (at / H) * 0.6);
    limbs.push({ pts, r: pts.map((_, k) => rs * (1 - 0.8 * (k / Math.max(1, pts.length - 1)))) });
    // Branches off the limb.
    const nb = conifer ? 2 : 4 + Math.floor(rand() * 3);
    for (let j = 0; j < nb; j++) {
      const t = 0.3 + 0.65 * rand();
      const k = Math.min(pts.length - 2, Math.floor(t * (pts.length - 1)));
      const p = lerp3(pts[k], pts[k + 1], t * (pts.length - 1) - k);
      const ld = norm(sub(pts[k + 1], pts[k]));
      const side = norm(cross(ld, [rand() - 0.5, rand() - 0.5, rand() - 0.5]));
      const bd = norm(add(ld, mul(side, 0.9)));
      const bp = reach(p, bd, R * (0.4 + 0.3 * rand()), h.tropism * 0.8, 3);
      const br = rs * 0.45 * (1 - t * 0.5);
      branches.push({ pts: bp, r: bp.map((_, q) => br * (1 - 0.8 * (q / Math.max(1, bp.length - 1)))) });
    }
  }
  return { H, R, base, cy, ry, inside, radiusAt, centre, trunk, trunkR, limbs, branches, rand, habit: h, conifer, top };
}

function build(species: TreeSpecies, variant: number): Builder[] {
  const t = grow(species, 9173 * (TREE_SPECIES.findIndex((s) => s.name === species) + 1) + variant * 131);
  const out: Builder[] = [];
  LODS.forEach((lod, li) => {
    const b = new Builder();
    const rand = mulberry32(77 + variant * 13 + li);
    const keep = (_: unknown, k: number) => k % lod.trunkStep === 0 || k === t.trunk.length - 1;
    b.tube(t.trunk.filter(keep), t.trunkR.filter(keep), lod.sides[0]);
    if (lod.limbs) for (const l of t.limbs) b.tube(l.pts, l.r, lod.sides[1]);
    if (lod.branches) for (const br of t.branches) b.tube(br.pts, br.r, lod.sides[2]);
    // Leaf cards: around the ends of the branches and limbs, and filling the crown's shell.
    const n = Math.max(6, Math.round(t.habit.cards * lod.cards));
    const size = t.habit.card * lod.cardSize;
    const ends: V3[] = [];
    for (const br of t.branches) for (let k = 1; k < br.pts.length; k++) ends.push(br.pts[k]);
    for (const l of t.limbs) ends.push(l.pts[l.pts.length - 1], l.pts[Math.max(1, l.pts.length - 2)]);
    let placed = 0;
    for (let tries = 0; placed < n && tries < n * 30; tries++) {
      let p: V3;
      if (li === 0 && rand() < 0.45 && ends.length) {
        const e = ends[Math.floor(rand() * ends.length)];
        p = add(e, [(rand() - 0.5) * 1.6, (rand() - 0.5) * 1.2, (rand() - 0.5) * 1.6]);
      } else {
        // A point in the shell: radius 0.55..1 of the crown's (0.35..0.9 for the coarse levels).
        const az = rand() * Math.PI * 2;
        const u = rand() * 2 - 1;
        const s = (li === 0 ? 0.6 : 0.4) + rand() * (li === 0 ? 0.42 : 0.45);
        const rr = t.radiusAt(az, 0) * s;
        p = [Math.cos(az) * Math.sqrt(1 - u * u) * rr, t.cy + u * t.ry * s, Math.sin(az) * Math.sqrt(1 - u * u) * rr];
        if (t.conifer && p[1] < t.top - t.ry * 2.2) continue;
      }
      if (!t.inside(mul(sub(p, [0, 0, 0]), 1)) && li > 0) continue;
      if (p[1] < t.base * 0.9) continue;
      const radial = norm(sub(p, t.centre));
      let nrm: V3;
      let up: V3;
      if (t.habit.weeping) {
        // Hanging curtains: vertical cards facing out.
        nrm = norm([radial[0] + (rand() - 0.5) * 0.6, 0, radial[2] + (rand() - 0.5) * 0.6]);
        up = [0, 1, 0];
        p = add(p, [0, -size * 0.3, 0]);
      } else {
        nrm = norm(add(mul(radial, 0.55), [rand() - 0.5, rand() - 0.5 + 0.3, rand() - 0.5]));
        up = norm(cross(nrm, [rand() - 0.5, rand() - 0.5, rand() - 0.5]));
      }
      b.card(p, nrm, up, size * (0.8 + 0.4 * rand()), t.centre, rand);
      placed++;
    }
    out.push(b);
  });
  return out;
}

// --- Leaf clusters ----------------------------------------------------------------------------

const LEAF = 512;
type Shape = (rand: () => number) => string;
const pathOf = (pts: [number, number][]) => `M${pts.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join("L")}Z`;
/** Leaf outlines in a unit frame: base at (0, 0), tip toward -y (SVG's up). */
const SHAPES: Record<TreeSpecies, Shape> = {
  plane: () => palmate(5, 0.42),
  maple: () => palmate(5, 0.55),
  chestnut: (rand) => compound(7, 0.55, 0.16, rand),
  linden: () => heart(0.95),
  poplar: () => pathOf(polar((a) => 0.5 * (1 - 0.15 * Math.cos(2 * a)) * (1 + 0.25 * Math.cos(a - Math.PI / 2)), 0.5)),
  willow: () => pathOf(polar((a) => 0.5 / Math.sqrt(Math.cos(a) ** 2 / 0.01 + Math.sin(a) ** 2), 0.5)),
  oak: () => pathOf(oak()),
  robinia: (rand) => pinnate(9, rand),
  pine: (rand) => needles(rand),
};
function polar(r: (a: number) => number, cy: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let k = 0; k < 64; k++) {
    const a = (k / 64) * Math.PI * 2;
    const rr = r(a);
    pts.push([Math.sin(a) * rr, -cy - Math.cos(a) * rr]);
  }
  return pts;
}
function palmate(lobes: number, depth: number): string {
  return pathOf(polar((a) => 0.5 * (1 - depth + depth * Math.pow(Math.abs(Math.cos((a * lobes) / 2)), 0.7)) * (a > 2.6 && a < 3.7 ? 0.6 : 1), 0.5));
}
function heart(w: number): string {
  const pts: [number, number][] = [];
  for (let k = 0; k < 48; k++) {
    const t = (k / 48) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push([(x / 34) * w, -0.5 + y / 34]);
  }
  return pathOf(pts.map(([x, y]) => [x, -1 - y] as [number, number]).map(([x, y]) => [x, y + 0.5] as [number, number]));
}
function oak(): [number, number][] {
  const side: [number, number][] = [];
  for (let k = 0; k <= 40; k++) {
    const t = k / 40;
    side.push([0.2 * Math.sin(Math.PI * t) * (0.75 + 0.35 * Math.abs(Math.sin(t * Math.PI * 4.5))), -t]);
  }
  return [...side, ...side.slice(1, -1).reverse().map(([x, y]) => [-x, y] as [number, number])];
}
function compound(n: number, l: number, w: number, rand: () => number): string {
  let d = "";
  for (let k = 0; k < n; k++) {
    const a = ((k - (n - 1) / 2) / n) * Math.PI * 1.3 + (rand() - 0.5) * 0.1;
    const s = 1 - Math.abs(k - (n - 1) / 2) / n;
    const pts = polar((t) => (l / 2) * s / Math.sqrt(Math.cos(t) ** 2 + (Math.sin(t) / (w / l * 2)) ** 2), (l / 2) * s);
    d += pathOf(pts.map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)] as [number, number]));
  }
  return d;
}
function pinnate(n: number, rand: () => number): string {
  let d = "";
  for (let k = 0; k < n; k++) {
    const y = -0.15 - (k / n) * 0.8;
    const side = k === n - 1 ? 0 : k % 2 === 0 ? 1 : -1;
    const cx = side * 0.12;
    const pts = polar((t) => 0.09 / Math.sqrt(Math.cos(t) ** 2 + (Math.sin(t) / 0.6) ** 2), 0);
    const a = side * 1.2 + (rand() - 0.5) * 0.2;
    d += pathOf(pts.map(([x, yy]) => [cx + x * Math.cos(a) - yy * Math.sin(a), y + x * Math.sin(a) + yy * Math.cos(a)] as [number, number]));
  }
  return d;
}
function needles(rand: () => number): string {
  let d = "";
  for (let k = 0; k < 2; k++) {
    const a = (k ? 1 : -1) * (0.12 + rand() * 0.15);
    const tip: [number, number] = [Math.sin(a), -Math.cos(a)];
    d += `M0 0L${(tip[0] + 0.012).toFixed(3)} ${tip[1].toFixed(3)}L${(tip[0] - 0.012).toFixed(3)} ${tip[1].toFixed(3)}Z`;
  }
  return d;
}
/** Leaf size in px and count per cluster. */
const CLUSTER: Record<TreeSpecies, [number, number]> = {
  plane: [112, 46], maple: [96, 52], chestnut: [140, 26], linden: [80, 72], poplar: [72, 80],
  willow: [104, 95], oak: [98, 56], robinia: [126, 36], pine: [126, 170],
};

async function leafLayer(species: TreeSpecies, seed: number): Promise<Buffer> {
  const rand = mulberry32(seed);
  const [size, count] = CLUSTER[species];
  const body: string[] = [];
  const C = LEAF / 2;
  // Twigs: a curving main stem and side shoots, drawn into B (and R for their shading).
  const twigs: [number, number, number][] = [];
  const stem = (x: number, y: number, a: number, l: number, w: number, depth: number) => {
    let d = `M${x.toFixed(1)} ${y.toFixed(1)}`;
    for (let k = 1; k <= 8; k++) {
      a += (rand() - 0.5) * 0.25;
      x += Math.sin(a) * (l / 8);
      y -= Math.cos(a) * (l / 8);
      d += `L${x.toFixed(1)} ${y.toFixed(1)}`;
      twigs.push([x, y, a]);
      if (depth > 0 && k % 3 === 0) stem(x, y, a + (rand() < 0.5 ? 1 : -1) * (0.6 + rand() * 0.4), l * 0.5, w * 0.6, depth - 1);
    }
    body.push(`<path d="${d}" fill="none" stroke="rgb(70,0,255)" stroke-width="${w.toFixed(1)}" stroke-linecap="round"/>`);
  };
  // A spray of twigs fanning out from below the middle.
  const fan = 4 + Math.floor(rand() * 2);
  for (let k = 0; k < fan; k++) stem(C + (rand() - 0.5) * 30, C + 150, ((k - (fan - 1) / 2) / fan) * 2.2 + (rand() - 0.5) * 0.3, LEAF * 0.42, species === "pine" ? 6 : 4.5, 1);
  // Leaves along the twigs, alternating, each its own shade and random value; kept in a disc so
  // none is cut off at the card's edge.
  const inDisc = twigs.filter(([x, y]) => Math.hypot(x - C, y - C) < LEAF * 0.4);
  for (let k = 0; k < count; k++) {
    const [x, y, a] = inDisc[Math.floor(rand() * inDisc.length)];
    const side = rand() < 0.5 ? 1 : -1;
    const ang = a + side * (0.5 + rand() * 0.9);
    const s = size * (0.75 + rand() * 0.45);
    const l = Math.round(150 + rand() * 80);
    const g = Math.round(rand() * 255);
    const deg = (ang * 180) / Math.PI;
    const shape = SHAPES[species](rand);
    const vein = species === "pine" ? "" : `<path d="M0 0L0 -0.92" stroke="rgb(${l - 55},${g},0)" stroke-width="${(1.6 / s).toFixed(4)}"/>`;
    body.push(
      `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${deg.toFixed(1)}) scale(${s.toFixed(1)})"><path d="${shape}" fill="rgb(${l},${g},0)"/>${vein}</g>`,
    );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${LEAF}" height="${LEAF}" viewBox="0 0 ${LEAF} ${LEAF}">${body.join("")}</svg>`;
  return sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
}

// --- Write ---------------------------------------------------------------------------------------

mkdirSync(new URL("trees/", DATA_DIR), { recursive: true });
const meshes: MeshDef[] = [];
const stats: string[] = [];
for (const sp of TREE_SPECIES) {
  const tris = [0, 0, 0];
  for (let v = 0; v < TREE_VARIANTS; v++) {
    build(sp.name, v).forEach((b, lod) => {
      tris[lod] += b.idx.length / 3 / TREE_VARIANTS;
      meshes.push({
        name: `tree ${sp.name} ${v} ${lod}`,
        material: { name: "tree", roughness: 0.85 },
        position: new Float32Array(b.pos),
        normal: new Float32Array(b.nor),
        uv: new Float32Array(b.uv),
        index: new Uint32Array(b.idx),
        extra: { _KIND: { array: new Float32Array(b.kind), size: 1 } },
      });
    });
  }
  stats.push(`${sp.name} ${tris.map((t) => Math.round(t)).join("/")}`);
}
const glbSize = await writeGlb("trees/trees.glb", meshes, { note: "Grown by tools/build-trees.ts: `tree <species> <variant> <level>`; _KIND 0 bark, 1 leaves." });
const layers = await Promise.all(TREE_SPECIES.map((sp, i) => leafLayer(sp.name, 501 + i * 17)));
const strip = Buffer.concat(layers);
const webp = await sharp(strip, { raw: { width: LEAF, height: LEAF * layers.length, channels: 4 } }).webp({ lossless: true, alphaQuality: 100 }).toBuffer();
await sharp(webp).toFile(new URL("trees/leaves.webp", DATA_DIR).pathname);
console.log(`trees/trees.glb ${kb(glbSize)}: triangles per level ${stats.join(", ")}`);
console.log(`trees/leaves.webp ${kb(webp.length)}: ${layers.length} layers of ${LEAF}²`);
