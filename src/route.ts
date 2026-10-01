// Loads route.json and exposes the autopilot spline as an arc-length table:
// position, heading, speed, mode, route time and the sunset-run clock at any `s`.
// No DOM here, so tools/timetable.ts can use it from Node.

import { CatmullRomCurve3, Vector3 } from "three";
import { headingOf, lonLatToLocal, wrapAngle } from "./geo";

export type RouteMode = "bird" | "boat";

export interface RoutePointJson {
  lat: number;
  lon: number;
  /** Metres above the river. */
  alt: number;
  /** m/s at this point; interpolated linearly in arc length to the next point. */
  speed: number;
  /** Applies from this point to the next one. */
  mode: RouteMode;
  /** Seconds the autopilot waits at this point. */
  hold?: number;
  /** A beat starts at this point. */
  beat?: { id: number; name: string };
  /** Sunset-run clock (hours) when the autopilot reaches this point. */
  timeOfDay?: number;
}

export interface RouteJson {
  version: number;
  notes?: string;
  points: RoutePointJson[];
}

export interface Beat {
  id: number;
  name: string;
  s: number;
  /** Seconds from the start of the run, holds included. */
  time: number;
}

export interface RouteSample {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  mode: RouteMode;
}

const STEP = 2;
const SUBDIVISIONS = 48;

export class Route {
  readonly length: number;
  readonly beats: Beat[];
  readonly startHold: number;
  readonly totalTime: number;
  readonly points: readonly RoutePointJson[];
  readonly pointS: readonly number[];

  private readonly count: number;
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;
  private readonly heading: Float64Array;
  private readonly speed: Float64Array;
  private readonly time: Float64Array;
  private readonly boat: Uint8Array;
  private readonly clockKeys: { time: number; tod: number }[];

  constructor(json: RouteJson) {
    const pts = json.points;
    if (pts.length < 2) throw new Error("route.json needs at least two points");
    this.points = pts;

    const ctrl = pts.map((p) => {
      const l = lonLatToLocal(p.lon, p.lat);
      return new Vector3(l.x, p.alt, l.z);
    });
    const curve = new CatmullRomCurve3(ctrl, false, "centripetal");

    // Fine pass: arc length, and the `s` of every control point.
    const segs = pts.length - 1;
    const fine: Vector3[] = [curve.getPoint(0)];
    const fineS: number[] = [0];
    const pointS: number[] = [0];
    let acc = 0;
    for (let i = 0; i < segs; i++) {
      for (let k = 1; k <= SUBDIVISIONS; k++) {
        const p = curve.getPoint((i + k / SUBDIVISIONS) / segs);
        acc += p.distanceTo(fine[fine.length - 1]);
        fine.push(p);
        fineS.push(acc);
      }
      pointS.push(acc);
    }
    this.length = acc;
    this.pointS = pointS;

    // Uniform resample every STEP metres.
    const n = Math.floor(acc / STEP) + 2;
    this.count = n;
    this.px = new Float64Array(n);
    this.py = new Float64Array(n);
    this.pz = new Float64Array(n);
    this.heading = new Float64Array(n);
    this.speed = new Float64Array(n);
    this.time = new Float64Array(n);
    this.boat = new Uint8Array(n);

    let f = 0;
    let seg = 0;
    for (let i = 0; i < n; i++) {
      const s = Math.min(i * STEP, acc);
      while (f < fineS.length - 2 && fineS[f + 1] < s) f++;
      const span = fineS[f + 1] - fineS[f] || 1;
      const u = Math.min(1, Math.max(0, (s - fineS[f]) / span));
      while (seg < segs - 1 && pointS[seg + 1] <= s) seg++;
      const segU = (s - pointS[seg]) / (pointS[seg + 1] - pointS[seg] || 1);
      const isBoat = pts[seg].mode === "boat";
      this.px[i] = fine[f].x + (fine[f + 1].x - fine[f].x) * u;
      this.pz[i] = fine[f].z + (fine[f + 1].z - fine[f].z) * u;
      this.py[i] = isBoat ? 0 : Math.max(0, fine[f].y + (fine[f + 1].y - fine[f].y) * u);
      this.speed[i] = pts[seg].speed + (pts[seg + 1].speed - pts[seg].speed) * Math.min(1, segU);
      this.boat[i] = isBoat ? 1 : 0;
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      this.heading[i] = headingOf(this.px[b] - this.px[a], this.pz[b] - this.pz[a]);
    }

    // Route time: ds / v, plus holds.
    this.startHold = pts[0].hold ?? 0;
    let holdIdx = 1;
    this.time[0] = this.startHold;
    for (let i = 1; i < n; i++) {
      const ds = Math.min(i * STEP, acc) - Math.min((i - 1) * STEP, acc);
      const v = Math.max(1, (this.speed[i] + this.speed[i - 1]) / 2);
      let t = this.time[i - 1] + ds / v;
      while (holdIdx < pts.length && pointS[holdIdx] <= i * STEP) {
        t += pts[holdIdx].hold ?? 0;
        holdIdx++;
      }
      this.time[i] = t;
    }
    this.totalTime = this.time[n - 1];

    this.beats = [];
    this.clockKeys = [];
    pts.forEach((p, j) => {
      if (p.beat) this.beats.push({ ...p.beat, s: pointS[j], time: this.timeAt(pointS[j]) });
      if (p.timeOfDay !== undefined) this.clockKeys.push({ time: this.timeAt(pointS[j]), tod: p.timeOfDay });
    });
  }

  private index(s: number): [number, number] {
    const f = Math.min(Math.max(s, 0), this.length) / STEP;
    const i = Math.min(Math.floor(f), this.count - 2);
    return [i, f - i];
  }

  sample(s: number, out: RouteSample = { x: 0, y: 0, z: 0, heading: 0, speed: 0, mode: "bird" }): RouteSample {
    const [i, u] = this.index(s);
    out.x = this.px[i] + (this.px[i + 1] - this.px[i]) * u;
    out.y = this.py[i] + (this.py[i + 1] - this.py[i]) * u;
    out.z = this.pz[i] + (this.pz[i + 1] - this.pz[i]) * u;
    out.heading = this.heading[i] + wrapAngle(this.heading[i + 1] - this.heading[i]) * u;
    out.speed = this.speed[i] + (this.speed[i + 1] - this.speed[i]) * u;
    out.mode = this.boat[u < 0.5 ? i : i + 1] ? "boat" : "bird";
    return out;
  }

  modeAt(s: number): RouteMode {
    const [i, u] = this.index(s);
    return this.boat[u < 0.5 ? i : i + 1] ? "boat" : "bird";
  }

  /**
   * Arc length of the route point nearest to (x, z), searched only within
   * [sHint - back, sHint + ahead]: the route passes close to itself over Buda and at
   * the Market Hall, and a global search would snap backwards.
   */
  nearest(x: number, z: number, sHint: number, back: number, ahead: number): number {
    const lo = Math.max(0, Math.floor((sHint - back) / STEP));
    const hi = Math.min(this.count - 1, Math.ceil((sHint + ahead) / STEP));
    let best = lo;
    let bestD = Infinity;
    for (let i = lo; i <= hi; i++) {
      const dx = this.px[i] - x;
      const dz = this.pz[i] - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    // Refine on the two segments around the best sample.
    let bestS = best * STEP;
    bestD = Infinity;
    for (let i = Math.max(0, best - 1); i <= Math.min(this.count - 2, best); i++) {
      const ax = this.px[i];
      const az = this.pz[i];
      const ex = this.px[i + 1] - ax;
      const ez = this.pz[i + 1] - az;
      const len2 = ex * ex + ez * ez || 1;
      const u = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / len2));
      const dx = ax + ex * u - x;
      const dz = az + ez * u - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        bestS = (i + u) * STEP;
      }
    }
    return Math.min(bestS, this.length);
  }

  timeAt(s: number): number {
    const [i, u] = this.index(s);
    return this.time[i] + (this.time[i + 1] - this.time[i]) * u;
  }

  /** Sunset-run clock in hours at a route time; linear between keyed points. */
  clockAt(time: number): number | undefined {
    const k = this.clockKeys;
    if (k.length === 0) return undefined;
    if (time <= k[0].time) return k[0].tod;
    for (let i = 0; i < k.length - 1; i++) {
      if (time <= k[i + 1].time) {
        const u = (time - k[i].time) / (k[i + 1].time - k[i].time || 1);
        return k[i].tod + (k[i + 1].tod - k[i].tod) * u;
      }
    }
    return k[k.length - 1].tod;
  }

  beatAt(s: number): Beat | undefined {
    let found: Beat | undefined;
    for (const b of this.beats) if (b.s <= s + 1e-6) found = b;
    return found;
  }
}
