// Third-person follow rig: 12 m behind and 4 m above the bird, 6 m behind and 1.5 m above the
// boat, smoothed with a critically damped spring (0.4 s). Landing and take-off blend the
// offsets and the field of view (70° bird, 60° boat). Camera beats arrive in M2.

import { PerspectiveCamera, Vector3 } from "three";
import { CAMERA, TRANSITION } from "./config";
import { forwardOf, wrapAngle } from "./geo";
import type { State } from "./state";
import type { World } from "./world/world";

const smoothstep = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
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

export class CameraRig {
  readonly camera = new PerspectiveCamera(CAMERA.bird.fov, 1, 0.5, 20000);
  /** The point the camera looks at, also the centre of the shadow box. */
  readonly focus = new Vector3();
  private yaw = 0;
  private readonly yawVel = { v: 0 };
  private height = 0;
  private readonly heightVel = { v: 0 };
  private readonly pos = new Vector3();
  private readonly posVel = [{ v: 0 }, { v: 0 }];
  private snapped = false;

  snap(): void {
    this.snapped = false;
  }

  update(st: State, world: World, dt: number): void {
    const v = st.vehicle;
    let b: number; // 0 bird framing, 1 boat framing
    if (v.mode === "BIRD") b = 0;
    else if (v.mode === "BOAT") b = 1;
    else if (v.mode === "LANDING") b = smoothstep(v.transitionT / TRANSITION.landing);
    else b = 1 - smoothstep(v.transitionT / TRANSITION.takeoff);
    const back = CAMERA.bird.back + (CAMERA.boat.back - CAMERA.bird.back) * b;
    const up = CAMERA.bird.up + (CAMERA.boat.up - CAMERA.bird.up) * b;
    const fov = CAMERA.bird.fov + (CAMERA.boat.fov - CAMERA.bird.fov) * b;

    if (!this.snapped || Math.hypot(this.pos.x - v.x, this.pos.z - v.z) > 300) {
      this.yaw = v.heading;
      this.height = v.y;
      this.pos.set(v.x, 0, v.z);
      this.yawVel.v = this.heightVel.v = this.posVel[0].v = this.posVel[1].v = 0;
      this.snapped = true;
    }
    // Smooth the heading and altitude the camera follows, and lightly the position.
    this.yaw = v.heading + wrapAngle(damp(wrapAngle(this.yaw - v.heading), 0, this.yawVel, CAMERA.smoothTime, dt));
    this.height = damp(this.height, v.y, this.heightVel, CAMERA.smoothTime, dt);
    this.pos.x = damp(this.pos.x, v.x, this.posVel[0], 0.08, dt);
    this.pos.z = damp(this.pos.z, v.z, this.posVel[1], 0.08, dt);

    const f = forwardOf(this.yaw);
    const cam = this.camera;
    cam.position.set(this.pos.x - f.x * back, this.height + up, this.pos.z - f.z * back);
    const floor = world.floor.isWater(cam.position.x, cam.position.z) ? 0.6 : world.floor.surface(cam.position.x, cam.position.z) + 2;
    cam.position.y = Math.max(cam.position.y, floor);

    const ahead = 16 - 6 * b;
    this.focus.set(this.pos.x + f.x * ahead, this.height + 0.6 + 0.4 * b, this.pos.z + f.z * ahead);
    cam.lookAt(this.focus);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }
}
