// Autopilot: follows the route spline with pure pursuit and produces a Command (yaw rate,
// acceleration, climb rate) for the controller to blend. It also tracks `s`, the route
// mode, the current beat, and drives the sunset-run clock.

import { BIRD, BOAT, CONTROL } from "./config";
import { headingOf, wrapAngle } from "./geo";
import type { Route, RouteSample } from "./route";
import { ZERO_COMMAND, type State } from "./state";

const here: RouteSample = { x: 0, y: 0, z: 0, heading: 0, speed: 0, mode: "bird" };
const target: RouteSample = { ...here };
const lead: RouteSample = { ...here };
const ahead: RouteSample = { ...here };
const behind: RouteSample = { ...here };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function updateAutopilot(st: State, route: Route, dt: number): void {
  const ap = st.autopilot;
  const v = st.vehicle;

  // Keep `s` on the vehicle. While the user has any control, search a wider window
  // so the autopilot re-joins from wherever they actually are.
  const manual = st.control.w > 0;
  ap.s = route.nearest(
    v.x,
    v.z,
    ap.s,
    manual ? CONTROL.manualWindow : 40,
    manual ? CONTROL.manualWindow : 120,
  );
  route.sample(ap.s, here);
  ap.routeMode = here.mode;
  ap.beat = route.beatAt(ap.s)?.name ?? "";
  ap.routeTime = route.timeAt(ap.s);
  if (st.sunsetRun.enabled && st.t >= st.sunsetRun.pausedUntil) {
    const tod = route.clockAt(ap.routeTime);
    if (tod !== undefined) st.timeOfDay = tod;
  }

  if (ap.holdLeft > 0) {
    ap.holdLeft -= dt;
    Object.assign(ap.command, ZERO_COMMAND);
    return;
  }

  // End of the route: start again (M2 adds the hold and fade).
  if (!manual && ap.s >= route.length - 3) {
    resetToStart(st, route);
    return;
  }

  // Heading: pure pursuit toward a point a little ahead on the spline.
  const boat = v.mode === "BOAT";
  const maxYaw = boat ? BOAT.maxYawRate : BIRD.maxYawRate;
  const L = Math.max(14, v.speed * 1.3);
  route.sample(ap.s + L, target);
  const dx = target.x - v.x;
  const dz = target.z - v.z;
  const dist = Math.max(1, Math.hypot(dx, dz));
  const alpha = wrapAngle(headingOf(dx, dz) - v.heading);
  const yaw = Math.abs(alpha) > Math.PI / 2 ? Math.sign(alpha) * maxYaw : (2 * v.speed * Math.sin(alpha)) / dist;

  // Speed toward the keyframed value.
  const accel = clamp(1.2 * (here.speed - v.speed), -4, 3);

  // Altitude: feed-forward from the spline's slope plus a correction toward a point slightly ahead.
  route.sample(ap.s + v.speed * 0.6, lead);
  route.sample(ap.s + 6, ahead);
  route.sample(ap.s - 6, behind);
  const slope = (ahead.y - behind.y) / 12;
  const climb = clamp(slope * v.speed + 1.4 * (lead.y - v.y), -BIRD.maxDive, BIRD.maxClimb);

  ap.command.yawRate = clamp(yaw, -maxYaw, maxYaw);
  ap.command.accel = accel;
  ap.command.climb = climb;
}

/** Put the vehicle back at the Japanese Garden, hovering, ready to start. */
export function resetToStart(st: State, route: Route): void {
  const p = route.sample(0);
  const v = st.vehicle;
  v.x = p.x;
  v.y = p.y;
  v.z = p.z;
  v.heading = p.heading;
  v.speed = BIRD.minSpeed;
  v.vSpeed = 0;
  v.yawRate = 0;
  v.mode = "BIRD";
  v.transitionT = 0;
  v.boatness = 0;
  v.throttleHeld = 0;
  v.deckSide.clear();
  st.autopilot.s = 0;
  st.autopilot.holdLeft = route.startHold;
  Object.assign(st.autopilot.command, ZERO_COMMAND);
}
