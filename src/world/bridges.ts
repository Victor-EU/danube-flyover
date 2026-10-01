// Placeholder bridges: deck ribbons that ramp down to street level on land, towers, piers,
// chains and cables, plus the queries the vehicles need (deck under/over, solid obstacles).
// Deck lines are the road ways on each bridge in OpenStreetMap (© OpenStreetMap contributors, ODbL).

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Group,
  Mesh,
  MeshStandardMaterial,
  TubeGeometry,
  Vector3,
} from "three";
import { latLonToLocal, type XZ } from "../geo";
import type { LatLon } from "./osmPlaceholder";
import type { River } from "./river";

interface BridgeDef {
  name: string;
  /** Road centreline across the deck, Buda to Pest. */
  line: LatLon[];
  width: number;
  underside: number;
  top: number;
  color: string;
  deckColor: string;
  towers?: { at: number[] | "banks"; height: number; along: number; thick: number };
  piers?: { at?: number[]; every?: number };
  cables?: "chain" | "suspension" | "truss";
}

const BRIDGES: BridgeDef[] = [
  {
    name: "Árpád Bridge",
    line: [[47.53918, 19.04654], [47.5363, 19.05849]],
    width: 34, underside: 10, top: 12,
    color: "#8f918c", deckColor: "#7d7f7a",
    piers: { every: 70 },
  },
  {
    name: "Margaret Bridge",
    line: [[47.51471, 19.0386], [47.51478, 19.04352], [47.51329, 19.04779]],
    width: 26, underside: 9, top: 11,
    color: "#b9b07a", deckColor: "#a49c6c",
    piers: { at: [0.17, 0.3, 0.43, 0.56, 0.7, 0.83] },
  },
  {
    name: "Chain Bridge",
    line: [[47.49846, 19.04101], [47.49951, 19.04642]],
    width: 16, underside: 9.5, top: 11.5,
    color: "#cdbf9d", deckColor: "#5f5c55",
    towers: { at: [0.235, 0.705], height: 48, along: 12, thick: 7 },
    piers: { at: [0.235, 0.705] },
    cables: "chain",
  },
  {
    name: "Elisabeth Bridge",
    line: [[47.4901, 19.04694], [47.49085, 19.04904], [47.49182, 19.05185], [47.49214, 19.05285]],
    width: 27, underside: 10, top: 12.5,
    color: "#ecebe6", deckColor: "#d9d8d2",
    towers: { at: "banks", height: 38, along: 6, thick: 5 },
    cables: "suspension",
  },
  {
    name: "Liberty Bridge",
    line: [[47.48479, 19.05318], [47.48661, 19.05673]],
    width: 20, underside: 10, top: 12,
    color: "#4e7f5d", deckColor: "#45705a",
    towers: { at: [0.236, 0.758], height: 27, along: 3, thick: 3 },
    piers: { at: [0.236, 0.758] },
    cables: "truss",
  },
];

export interface DeckSeg {
  bridge: number;
  ax: number;
  az: number;
  ux: number;
  uz: number;
  len: number;
  halfWidth: number;
  underside: number;
  top: number;
}

/** A solid block in the water or on the deck (oriented box footprint). */
export interface Obstacle {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  halfAlong: number;
  halfAcross: number;
  top: number;
  /** Towers rise above the deck and go into the floor grid; piers stay under it. */
  tower: boolean;
}

export interface DeckHit {
  bridge: number;
  underside: number;
  top: number;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Sample {
  x: number;
  z: number;
  ux: number;
  uz: number;
  t: number; // fraction of the original line length
  wet: boolean;
  top: number;
}

export class Bridges {
  readonly group = new Group();
  readonly decks: DeckSeg[] = [];
  /** Every deck segment including the land approaches (for keeping buildings off the ramps). */
  readonly footprints: DeckSeg[] = [];
  readonly obstacles: Obstacle[] = [];
  readonly names = BRIDGES.map((b) => b.name);

  constructor(river: River) {
    BRIDGES.forEach((def, id) => this.build(def, id, river));
  }

  private build(def: BridgeDef, id: number, river: River): void {
    const pts = def.line.map(latLonToLocal);
    const samples = sampleLine(pts, 6, 50);
    for (const s of samples) s.wet = river.isWater(s.x, s.z);
    // Deck height: full over water, ramping to street level within 60 m on land.
    let dist = Infinity;
    const dry = samples.map(() => Infinity);
    for (let i = 0; i < samples.length; i++) {
      dist = samples[i].wet ? 0 : dist + 6;
      dry[i] = dist;
    }
    dist = Infinity;
    for (let i = samples.length - 1; i >= 0; i--) {
      dist = samples[i].wet ? 0 : dist + 6;
      dry[i] = Math.min(dry[i], dist);
    }
    samples.forEach((s, i) => (s.top = def.top + (4.7 - def.top) * smoothstep(0, 60, dry[i])));
    const thickness = def.top - def.underside;

    const deckMat = new MeshStandardMaterial({ color: def.deckColor, roughness: 0.8, flatShading: true });
    const mat = new MeshStandardMaterial({ color: def.color, roughness: 0.7, flatShading: true });
    const deck = new Mesh(deckRibbon(samples, def.width, thickness), deckMat);
    deck.castShadow = deck.receiveShadow = true;
    this.group.add(deck);

    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i];
      const b = samples[i + 1];
      const seg: DeckSeg = {
        bridge: id,
        ax: a.x,
        az: a.z,
        ux: a.ux,
        uz: a.uz,
        len: Math.hypot(b.x - a.x, b.z - a.z),
        halfWidth: def.width / 2,
        underside: Math.min(a.top, b.top) - thickness,
        top: Math.max(a.top, b.top),
      };
      this.footprints.push(seg);
      if (a.wet || b.wet) this.decks.push(seg);
    }

    const at =(t: number): Sample => {
      let best = samples[0];
      for (const s of samples) if (Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
      return best;
    };

    // Piers under the deck.
    const pierAt: Sample[] = [];
    if (def.piers?.at) for (const t of def.piers.at) pierAt.push(at(t));
    if (def.piers?.every) {
      const step = Math.round(def.piers.every / 6);
      for (let i = step; i < samples.length; i += step) pierAt.push(samples[i]);
    }
    for (const s of pierAt) {
      if (!s.wet) continue;
      this.addBlock(mat, s, 9, def.width + 4, -2, s.top - thickness, false);
    }

    // Towers: a pillar each side of the deck and a lintel on top.
    const towerAt: Sample[] = [];
    if (def.towers) {
      if (def.towers.at === "banks") {
        const first = samples.findIndex((s) => s.wet);
        let last = -1;
        samples.forEach((s, i) => s.wet && (last = i));
        if (first > 0) towerAt.push(samples[first - 1]);
        if (last >= 0 && last < samples.length - 1) towerAt.push(samples[last + 1]);
      } else {
        for (const t of def.towers.at) towerAt.push(at(t));
      }
      const tw = def.towers;
      for (const s of towerAt) {
        const off = def.width / 2 + tw.thick / 2;
        for (const side of [-1, 1]) {
          const p = { ...s, x: s.x - s.uz * off * side, z: s.z + s.ux * off * side };
          this.addBlock(mat, p, tw.along, tw.thick, -2, tw.height, true);
        }
        const lintel = new Mesh(new BoxGeometry(def.width + tw.thick * 2, 4, tw.along), mat);
        lintel.position.set(s.x, tw.height - 2, s.z);
        lintel.rotation.y = Math.atan2(s.ux, s.uz);
        lintel.castShadow = true;
        this.group.add(lintel);
      }
    }

    if (def.cables && towerAt.length === 2) this.addCables(def, samples, towerAt);
  }

  private addBlock(mat: MeshStandardMaterial, s: XZ & { ux: number; uz: number }, along: number, across: number, y0: number, y1: number, tower: boolean): void {
    const m = new Mesh(new BoxGeometry(across, y1 - y0, along), mat);
    m.position.set(s.x, (y0 + y1) / 2, s.z);
    // Box depth (local z) runs along the deck.
    m.rotation.y = Math.atan2(s.ux, s.uz);
    m.castShadow = m.receiveShadow = true;
    this.group.add(m);
    this.obstacles.push({ cx: s.x, cz: s.z, ux: s.ux, uz: s.uz, halfAlong: along / 2, halfAcross: across / 2, top: y1, tower });
  }

  private addCables(def: BridgeDef, samples: Sample[], towers: Sample[]): void {
    const tw = def.towers!;
    const ends = [samples.find((s) => s.top > def.top - 0.5) ?? samples[0], [...samples].reverse().find((s) => s.top > def.top - 0.5) ?? samples[samples.length - 1]];
    const anchors = [ends[0], towers[0], towers[1], ends[1]];
    const deckY = def.top + 1;
    const peakY = def.cables === "truss" ? def.top + 14 : tw.height - 3;
    const lowY = def.cables === "truss" ? def.top + 2.5 : deckY + 2;
    const mat = new MeshStandardMaterial({
      color: def.cables === "chain" ? "#3b3a37" : def.color,
      roughness: 0.6,
      flatShading: true,
    });
    for (const side of [-1, 1]) {
      const off = def.width / 2 + 0.6;
      const pts: Vector3[] = [];
      for (let k = 0; k < 3; k++) {
        const a = anchors[k];
        const b = anchors[k + 1];
        const ya = k === 0 ? deckY : peakY;
        const yb = k === 2 ? deckY : peakY;
        for (let i = k === 0 ? 0 : 1; i <= 12; i++) {
          const u = i / 12;
          const sag = (k === 1 ? peakY - lowY : (peakY - deckY) * 0.35) * 4 * u * (1 - u);
          pts.push(
            new Vector3(
              a.x + (b.x - a.x) * u - a.uz * off * side,
              ya + (yb - ya) * u - sag,
              a.z + (b.z - a.z) * u + a.ux * off * side,
            ),
          );
        }
      }
      const tube = new Mesh(new TubeGeometry(new CatmullRomCurve3(pts), 120, def.cables === "chain" ? 0.7 : 0.5, 5), mat);
      tube.castShadow = true;
      this.group.add(tube);
    }
  }

  /** True if (x, z) is within `margin` of any deck or approach ramp. */
  onFootprint(x: number, z: number, margin: number): boolean {
    return hitSeg(this.footprints, x, z, margin) !== null;
  }

  /** The deck over (x, z), widened across by `margin`, if any. */
  deckAt(x: number, z: number, margin: number): DeckHit | null {
    const d = hitSeg(this.decks, x, z, margin);
    return d ? { bridge: d.bridge, underside: d.underside, top: d.top } : null;
  }

  /** Distance ahead (along fx, fz) to the nearest deck edge within `range`, or null. */
  deckAhead(x: number, z: number, fx: number, fz: number, range: number): (DeckHit & { dist: number }) | null {
    for (let d = 0; d <= range; d += 4) {
      const hit = this.deckAt(x + fx * d, z + fz * d, 0);
      if (hit) return { ...hit, dist: d };
    }
    return null;
  }

  /** Push (x, z) out of any obstacle whose top is above `y`. Returns the push or null. */
  pushOut(x: number, z: number, y: number, margin: number): XZ | null {
    for (const o of this.obstacles) {
      if (y > o.top) continue;
      const rx = x - o.cx;
      const rz = z - o.cz;
      const a = rx * o.ux + rz * o.uz;
      const b = -rx * o.uz + rz * o.ux;
      const pa = o.halfAlong + margin - Math.abs(a);
      const pb = o.halfAcross + margin - Math.abs(b);
      if (pa <= 0 || pb <= 0) continue;
      if (pa < pb) return { x: o.ux * pa * Math.sign(a || 1), z: o.uz * pa * Math.sign(a || 1) };
      return { x: -o.uz * pb * Math.sign(b || 1), z: o.ux * pb * Math.sign(b || 1) };
    }
    return null;
  }
}

function hitSeg(segs: DeckSeg[], x: number, z: number, margin: number): DeckSeg | null {
  for (const d of segs) {
    const rx = x - d.ax;
    const rz = z - d.az;
    const along = rx * d.ux + rz * d.uz;
    if (along < -margin || along > d.len + margin) continue;
    if (Math.abs(-rx * d.uz + rz * d.ux) <= d.halfWidth + margin) return d;
  }
  return null;
}

/** Points every `step` m along a polyline, extended straight by `extend` m at both ends for approach ramps. */
function sampleLine(pts: XZ[], step: number, extend: number): Sample[] {
  const n = pts.length;
  const segLen = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.z - pts[i].z));
  const total = segLen.reduce((a, b) => a + b, 0);
  const dir = (i: number) => ({ ux: (pts[i + 1].x - pts[i].x) / segLen[i], uz: (pts[i + 1].z - pts[i].z) / segLen[i] });
  const out: Sample[] = [];
  for (let s = -extend; s <= total + extend + 1e-6; s += step) {
    let x: number;
    let z: number;
    let u: { ux: number; uz: number };
    if (s <= 0) {
      u = dir(0);
      x = pts[0].x + u.ux * s;
      z = pts[0].z + u.uz * s;
    } else if (s >= total) {
      u = dir(n - 2);
      x = pts[n - 1].x + u.ux * (s - total);
      z = pts[n - 1].z + u.uz * (s - total);
    } else {
      let rem = s;
      let i = 0;
      while (i < segLen.length - 1 && rem > segLen[i]) rem -= segLen[i++];
      u = dir(i);
      x = pts[i].x + u.ux * rem;
      z = pts[i].z + u.uz * rem;
    }
    out.push({ x, z, ux: u.ux, uz: u.uz, t: Math.min(Math.max(s / total, 0), 1), wet: false, top: 0 });
  }
  return out;
}

/** A box-section ribbon along the samples: top, bottom and both sides. */
function deckRibbon(samples: Sample[], width: number, thickness: number): BufferGeometry {
  const hw = width / 2;
  const pos: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i < samples.length - 1; i++) {
    const s0 = samples[i];
    const s1 = samples[i + 1];
    const L0 = [s0.x - s0.uz * hw, s0.z + s0.ux * hw];
    const R0 = [s0.x + s0.uz * hw, s0.z - s0.ux * hw];
    const L1 = [s1.x - s1.uz * hw, s1.z + s1.ux * hw];
    const R1 = [s1.x + s1.uz * hw, s1.z - s1.ux * hw];
    const t0 = s0.top;
    const t1 = s1.top;
    const b0 = t0 - thickness;
    const b1 = t1 - thickness;
    quad([L0[0], t0, L0[1]], [L1[0], t1, L1[1]], [R1[0], t1, R1[1]], [R0[0], t0, R0[1]]); // top
    quad([R0[0], b0, R0[1]], [R1[0], b1, R1[1]], [L1[0], b1, L1[1]], [L0[0], b0, L0[1]]); // bottom
    quad([L0[0], b0, L0[1]], [L1[0], b1, L1[1]], [L1[0], t1, L1[1]], [L0[0], t0, L0[1]]); // left
    quad([R0[0], t0, R0[1]], [R1[0], t1, R1[1]], [R1[0], b1, R1[1]], [R0[0], b0, R0[1]]); // right
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  return geo;
}
