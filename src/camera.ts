// Third-person rig. `follow` (the default) sits 12 m behind and 4 m above the bird, 6 m behind
// and 1.5 m above the boat, smoothed with a critically damped spring (0.4 s); landing and
// take-off blend the offsets and the field of view (70° bird, 60° boat). The route's camera
// keys switch to `orbit` (the rig swings round the vehicle to hold a landmark in frame beside
// it) or `reveal` (far behind and high, catching up by the next key); `low` (just above the
// vehicle) takes over by itself under bridge decks. Every change blends over 1.5 s. Keys are
// ignored while the user has control, until the next key is reached.

import { PerspectiveCamera, Vector3 } from "three";
import { CAMERA, TRANSITION } from "./config";
import { forwardOf, headingOf, wrapAngle } from "./geo";
import type { Route } from "./route";
import type { CameraMode, State } from "./state";
import type { Sight } from "./world/landmarks";
import type { World } from "./world/world";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

/** Unity-style SmoothDamp: a critically damped spring toward `target`. */
function damp(current: number, target: number, vel: { v: number }, smoothTime: number, dt: number): number {
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (vel.v + omega * change) * dt;
  vel.v = (vel.v - omega * temp) * exp;
  return target + (change + temp) * exp;
}

/** A camera placement in the smoothed vehicle frame, so two modes can be blended. */
interface Pose {
  /** Direction of the camera's line to the vehicle, relative to the vehicle's heading. */
  rel: number;
  back: number;
  up: number;
  /** Look point: x right, y up, z forward of the vehicle. */
  lx: number;
  ly: number;
  lz: number;
  fov: number;
}

const newPose = (): Pose => ({ rel: 0, back: 0, up: 0, lx: 0, ly: 0, lz: 0, fov: CAMERA.bird.fov });

function mix(a: Pose, b: Pose, k: number, out: Pose): void {
  // `rel` stays within ±maxSwing, so a plain lerp swings the camera round behind the vehicle.
  out.rel = lerp(a.rel, b.rel, k);
  out.back = lerp(a.back, b.back, k);
  out.up = lerp(a.up, b.up, k);
  out.lx = lerp(a.lx, b.lx, k);
  out.ly = lerp(a.ly, b.ly, k);
  out.lz = lerp(a.lz, b.lz, k);
  out.fov = lerp(a.fov, b.fov, k);
}

/** `low` lingers this long after the last deck, so it doesn't flicker at the deck edges. */
const LOW_LINGER = 0.5;

const tmpC = new Vector3();
const tmpV = new Vector3();
const tmpT = new Vector3();
const tmpL = new Vector3();

export class CameraRig {
  readonly camera = new PerspectiveCamera(CAMERA.bird.fov, 1, 0.5, 20000);
  /** The point ahead of the vehicle the follow camera looks at; also the centre of the shadow box. */
  readonly focus = new Vector3();
  private yaw = 0;
  private readonly yawVel = { v: 0 };
  private height = 0;
  private readonly heightVel = { v: 0 };
  private readonly pos = new Vector3();
  private readonly posVel = [{ v: 0 }, { v: 0 }];
  private snapped = false;
  private readonly sights: Map<string, Sight>;
  private modeKey = "";
  private blendT = Infinity;
  private suspendedKey = -1;
  private sinceDeck = Infinity;
  private readonly from = newPose();
  private readonly to = newPose();
  private readonly out = newPose();

  constructor(
    private readonly route: Route,
    private readonly world: World,
  ) {
    this.sights = new Map(world.sights.map((s) => [s.id, s]));
  }

  /** Cut: next frame starts settled at the vehicle, in the route's mode, with no blend. */
  snap(): void {
    this.snapped = false;
  }

  update(st: State, dt: number): void {
    const v = st.vehicle;
    const cam = st.camera;
    let b: number; // 0 bird framing, 1 boat framing
    if (v.mode === "BIRD") b = 0;
    else if (v.mode === "BOAT") b = 1;
    else if (v.mode === "LANDING") b = smoothstep(v.transitionT / TRANSITION.landing);
    else b = 1 - smoothstep(v.transitionT / TRANSITION.takeoff);

    if (!this.snapped || Math.hypot(this.pos.x - v.x, this.pos.z - v.z) > 300) {
      this.yaw = v.heading;
      this.height = v.y;
      this.pos.set(v.x, 0, v.z);
      this.yawVel.v = this.heightVel.v = this.posVel[0].v = this.posVel[1].v = 0;
      this.modeKey = "";
      cam.suspended = false;
      this.snapped = true;
    }
    // Smooth the heading and altitude the camera follows, and lightly the position.
    this.yaw = v.heading + wrapAngle(damp(wrapAngle(this.yaw - v.heading), 0, this.yawVel, CAMERA.smoothTime, dt));
    this.height = damp(this.height, v.y, this.heightVel, CAMERA.smoothTime, dt);
    this.pos.x = damp(this.pos.x, v.x, this.posVel[0], 0.08, dt);
    this.pos.z = damp(this.pos.z, v.z, this.posVel[1], 0.08, dt);

    // Which mode: the route's key at `s`, unless the user has (or had) control.
    const key = this.route.shotIndexAt(st.autopilot.s);
    if (st.control.w > 0.5) {
      cam.suspended = true;
      this.suspendedKey = key;
    } else if (cam.suspended && key !== this.suspendedKey) cam.suspended = false;
    let mode: CameraMode = "follow";
    let target: Sight | undefined;
    let u = 1;
    const shot = key >= 0 && !cam.suspended ? this.route.shots[key] : undefined;
    if (shot) {
      mode = shot.mode;
      target = shot.target ? this.sights.get(shot.target) : undefined;
      u = clamp((st.autopilot.routeTime - shot.time) / Math.max(1, shot.endTime - shot.time), 0, 1);
      if (mode === "orbit" && !target) mode = "follow";
    }
    this.sinceDeck = this.underDeck(st) ? 0 : this.sinceDeck + dt;
    if (this.sinceDeck < LOW_LINGER) mode = "low";

    const modeKey = mode === "reveal" ? `reveal:${key}` : `${mode}:${target?.id ?? ""}`;
    if (modeKey !== this.modeKey) {
      // Blend from wherever the camera is now (even mid-blend) to the new mode.
      this.blendT = this.modeKey ? 0 : Infinity;
      Object.assign(this.from, this.out);
      this.modeKey = modeKey;
    }
    this.blendT += dt;
    this.pose(mode, target, u, b, this.to);
    const k = smoothstep(this.blendT / CAMERA.blend);
    mix(this.from, this.to, k, this.out);
    cam.mode = mode;
    cam.key = key;
    cam.target = target?.id ?? "";
    cam.blend = k;

    // Place the camera from the blended pose.
    const p = this.out;
    const f = forwardOf(this.yaw + p.rel);
    const hf = forwardOf(this.yaw);
    const camera = this.camera;
    camera.position.set(this.pos.x - f.x * p.back, this.height + p.up, this.pos.z - f.z * p.back);
    tmpL.set(this.pos.x + -hf.z * p.lx + hf.x * p.lz, this.height + p.ly, this.pos.z + hf.x * p.lx + hf.z * p.lz);

    // Stay above the ground and roofs, and under a deck the vehicle is passing beneath
    // (towers in the river are left to the deck test there, so they don't lift the camera).
    const fl = this.world.floor;
    const nearDeck = this.sinceDeck < 1;
    const c = camera.position;
    c.y = Math.max(c.y, fl.isWater(c.x, c.z, nearDeck) ? 0.6 : fl.surface(c.x, c.z, nearDeck) + 2);
    if (nearDeck) {
      const deck = this.world.bridges.deckAt(c.x, c.z, 1.5);
      if (deck && v.y < deck.underside) c.y = Math.min(c.y, deck.underside - 0.6);
    }
    camera.lookAt(tmpL);
    if (Math.abs(camera.fov - p.fov) > 0.01) {
      camera.fov = p.fov;
      camera.updateProjectionMatrix();
    }
    const ahead = 16 - 6 * b;
    this.focus.set(this.pos.x + hf.x * ahead, this.height, this.pos.z + hf.z * ahead);
  }

  /** The pose a mode asks for this frame. */
  private pose(mode: CameraMode, target: Sight | undefined, u: number, b: number, out: Pose): void {
    const back = lerp(CAMERA.bird.back, CAMERA.boat.back, b);
    const up = lerp(CAMERA.bird.up, CAMERA.boat.up, b);
    const ahead = 16 - 6 * b;
    const lookUp = 0.6 + 0.4 * b;
    out.fov = lerp(CAMERA.bird.fov, CAMERA.boat.fov, b);
    out.rel = 0;
    out.lx = 0;
    out.ly = lookUp;
    out.lz = ahead;
    switch (mode) {
      case "follow":
        out.back = back;
        out.up = up;
        break;
      case "low": {
        const L = CAMERA.low;
        out.back = lerp(L.bird.back, L.boat.back, b);
        out.up = lerp(L.bird.up, L.boat.up, b);
        // Look further ahead and a little up, so the deck passes overhead.
        out.ly = lookUp + 1;
        out.lz = 40;
        break;
      }
      case "reveal": {
        const e = smoothstep(u);
        out.back = lerp(CAMERA.reveal.back, back, e);
        out.up = lerp(CAMERA.reveal.up, up, e);
        break;
      }
      case "orbit": {
        const O = CAMERA.orbit;
        const T = target!;
        // Swing the rig only as far as it takes to keep the target within `frame` of the vehicle.
        const off = wrapAngle(headingOf(T.x - this.pos.x, T.z - this.pos.z) - this.yaw);
        out.rel = clamp(off - clamp(off, -O.frame, O.frame), -O.maxSwing, O.maxSwing);
        out.back = lerp(O.bird.back, O.boat.back, b);
        out.up = lerp(O.bird.up, O.boat.up, b);
        // Aim half way between the vehicle and the target, so both are in frame.
        const f = forwardOf(this.yaw + out.rel);
        tmpC.set(this.pos.x - f.x * out.back, this.height + out.up, this.pos.z - f.z * out.back);
        tmpV.set(this.pos.x, this.height + lookUp, this.pos.z).sub(tmpC).normalize();
        tmpT.set(T.x, T.y, T.z).sub(tmpC).normalize();
        tmpV.add(tmpT);
        if (tmpV.lengthSq() < 1e-6) break;
        tmpL.copy(tmpC).addScaledVector(tmpV.normalize(), 40);
        // Into the vehicle frame.
        const hf = forwardOf(this.yaw);
        const dx = tmpL.x - this.pos.x;
        const dz = tmpL.z - this.pos.z;
        out.lx = dx * -hf.z + dz * hf.x;
        out.lz = dx * hf.x + dz * hf.z;
        out.ly = tmpL.y - this.height;
        break;
      }
    }
  }

  /** Under a bridge deck, or about to pass under one. */
  private underDeck(st: State): boolean {
    const v = st.vehicle;
    if (v.y > 16) return false; // above every deck's underside
    const bridges = this.world.bridges;
    const f = forwardOf(v.heading);
    const deck = bridges.deckAt(v.x, v.z, 14) ?? bridges.deckAhead(v.x, v.z, f.x, f.z, v.speed * 2 + 12);
    return deck !== null && v.y < deck.underside;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
