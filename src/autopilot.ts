// Autopilot: follows the route spline with pure pursuit and produces a Command (yaw rate,
// acceleration, climb rate) for the controller to blend. It also tracks `s`, the route
// mode, the current beat, and drives the sunset-run clock. Past the last point it keeps
// circling the Market Hall; tour.ts fades and loops after LOOP.circle seconds of that.

import { GLIDER, BOAT, CLOCK_EASE, CONTROL } from "./config";
import { headingOf, wrapAngle } from "./geo";
import type { Route, RouteSample } from "./route";
import { ZERO_COMMAND, type State, type VehicleState } from "./state";

const here: RouteSample = { x: 0, y: 0, z: 0, heading: 0, speed: 0, mode: "glider" };
const target: RouteSample = { ...here };
const lead: RouteSample = { ...here };
const ahead: RouteSample = { ...here };
const behind: RouteSample = { ...here };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function updateAutopilot(st: State, route: Route, dt: number): void {
  const ap = st.autopilot;
  const v = st.vehicle;

  // The end circle belongs to the autopilot: any manual control (or pause) ends it.
  const manual = st.control.w > 0;
  if (ap.phase === "end" && (manual || st.paused)) {
    ap.phase = "tour";
    ap.endT = 0;
  }

  // Keep `s` on the vehicle. While the user has any control, search a wider window
  // so the autopilot re-joins from wherever they actually are.
  if (ap.phase === "tour")
    ap.s = route.nearest(v.x, v.z, ap.s, manual ? CONTROL.manualWindow : 40, manual ? CONTROL.manualWindow : 120);
  route.sample(ap.s, here);
  ap.routeMode = here.mode;
  ap.beat = route.beatAt(ap.s)?.name ?? "";
  ap.routeTime = route.timeAt(ap.s);
  // Pause stops the clock too; otherwise it eases toward the route's, so a hand-back far from
  // where the user took over doesn't snap the lighting.
  if (st.sunsetRun.enabled && !st.paused && st.t >= st.sunsetRun.pausedUntil) {
    const tod = route.clockAt(ap.routeTime);
    if (tod !== undefined) st.timeOfDay += (tod - st.timeOfDay) * (1 - Math.exp(-dt / CLOCK_EASE));
  }

  if (ap.holdLeft > 0) {
    ap.holdLeft -= dt;
    Object.assign(ap.command, ZERO_COMMAND);
    return;
  }

  if (ap.phase === "tour" && !manual && !st.paused && ap.s >= route.length - 3) {
    ap.phase = "end";
    ap.endT = 0;
  }
  if (ap.phase === "end") {
    ap.endT += dt;
    circle(st, route);
    return;
  }

  // Heading: pure pursuit toward a point a little ahead on the spline.
  const L = Math.max(14, v.speed * 1.3);
  route.sample(ap.s + L, target);
  const yaw = pursue(v, target.x, target.z);

  // Speed toward the keyframed value.
  const accel = clamp(1.2 * (here.speed - v.speed), -4, 3);

  // Altitude: feed-forward from the spline's slope plus a correction toward a point slightly ahead.
  route.sample(ap.s + v.speed * 0.6, lead);
  route.sample(ap.s + 6, ahead);
  route.sample(ap.s - 6, behind);
  const slope = (ahead.y - behind.y) / 12;
  const climb = clamp(slope * v.speed + 1.4 * (lead.y - v.y), -GLIDER.maxDive, GLIDER.maxClimb);

  ap.command.yawRate = yaw;
  ap.command.accel = accel;
  ap.command.climb = climb;
}

/** Pure-pursuit yaw rate toward (tx, tz), within the vehicle's turn limit. */
function pursue(v: VehicleState, tx: number, tz: number): number {
  const maxYaw = v.mode === "BOAT" ? BOAT.maxYawRate : GLIDER.maxYawRate;
  const dx = tx - v.x;
  const dz = tz - v.z;
  const dist = Math.max(1, Math.hypot(dx, dz));
  const alpha = wrapAngle(headingOf(dx, dz) - v.heading);
  const yaw = Math.abs(alpha) > Math.PI / 2 ? Math.sign(alpha) * maxYaw : (2 * v.speed * Math.sin(alpha)) / dist;
  return clamp(yaw, -maxYaw, maxYaw);
}

/** After the last point: keep flying the route's final circle at its last altitude and speed. */
function circle(st: State, route: Route): void {
  const v = st.vehicle;
  const c = route.end;
  const cmd = st.autopilot.command;
  if (!c) {
    // The route ends straight: hold the heading until the loop.
    Object.assign(cmd, ZERO_COMMAND);
    return;
  }
  const ang = Math.atan2(v.z - c.z, v.x - c.x);
  const a2 = ang + (c.dir * Math.max(14, v.speed * 1.3)) / c.r;
  cmd.yawRate = pursue(v, c.x + Math.cos(a2) * c.r, c.z + Math.sin(a2) * c.r);
  cmd.accel = clamp(1.2 * (c.speed - v.speed), -4, 3);
  cmd.climb = clamp(1.4 * (c.y - v.y), -GLIDER.maxDive, GLIDER.maxClimb);
}

/**
 * Puts the vehicle on the route at `s`, in the route's mode there, under the autopilot (or
 * still paused), with the sunset-run clock at the route's time. Used by the loop and jumps.
 */
export function placeAt(st: State, route: Route, s: number, hold = 0): void {
  const p = route.sample(s);
  const v = st.vehicle;
  const boat = p.mode === "boat";
  v.x = p.x;
  v.y = boat ? 0 : p.y;
  v.z = p.z;
  v.heading = p.heading;
  v.speed = boat ? clamp(p.speed, BOAT.minSpeed, BOAT.maxSpeed) : clamp(p.speed, GLIDER.minSpeed, GLIDER.maxSpeed);
  v.vSpeed = 0;
  v.yawRate = 0;
  v.roll = 0;
  v.pitch = 0;
  v.mode = boat ? "BOAT" : "GLIDER";
  v.transitionT = 0;
  v.boatness = boat ? 1 : 0;
  v.throttleHeld = 0;
  v.deckSide.clear();
  const ap = st.autopilot;
  ap.s = s;
  ap.holdLeft = st.paused ? 0 : hold;
  ap.phase = "tour";
  ap.endT = 0;
  ap.routeMode = p.mode;
  ap.routeTime = route.timeAt(s);
  Object.assign(ap.command, ZERO_COMMAND);
  st.control.w = st.paused ? 1 : 0;
  st.control.idleFor = 0;
  if (st.sunsetRun.enabled) st.timeOfDay = route.clockAt(ap.routeTime) ?? st.timeOfDay;
}

/** Put the vehicle back at the Japanese Garden, gliding straight, ready to start. */
export function resetToStart(st: State, route: Route): void {
  placeAt(st, route, 0, route.startHold);
}
