// Autopilot: follows the route spline with pure pursuit and produces a Command (yaw rate,
// acceleration, climb rate) for the controller to blend. It also tracks `s`, the route
// mode, the current beat, and drives the sunset-run clock. Past the last point it keeps
// circling the Market Hall; tour.ts fades and loops after LOOP.circle seconds of that.
// The user's boat (see VehicleState.userBoat) follows the route only along its boat legs;
// elsewhere it cruises the river the way it's heading, turning back at the world's edge.

import { GLIDER, BOAT, CLOCK_EASE, CONTROL } from "./config";
import { forwardOf, headingOf, wrapAngle } from "./geo";
import type { Route, RouteSample } from "./route";
import { ZERO_COMMAND, type State, type VehicleState } from "./state";
import type { World } from "./world/world";

const here: RouteSample = { x: 0, y: 0, z: 0, heading: 0, speed: 0, mode: "glider" };
const target: RouteSample = { ...here };
const lead: RouteSample = { ...here };
const ahead: RouteSample = { ...here };
const behind: RouteSample = { ...here };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function updateAutopilot(st: State, route: Route, world: World, dt: number): void {
  const ap = st.autopilot;
  const v = st.vehicle;
  const userBoat = v.userBoat && v.mode === "BOAT";

  // The end circle belongs to the autopilot: any manual control (or pause) ends it.
  const manual = st.control.w > 0;
  if (ap.phase === "end" && (manual || st.paused)) {
    ap.phase = "tour";
    ap.endT = 0;
  }

  // Keep `s` on the vehicle. While the user has any control (or their boat is off the route),
  // search a wider window so the autopilot re-joins from wherever they actually are.
  const wide = manual || userBoat;
  if (ap.phase === "tour")
    ap.s = route.nearest(v.x, v.z, ap.s, wide ? CONTROL.manualWindow : 40, wide ? CONTROL.manualWindow : 120);
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

  if (ap.phase === "tour" && !manual && !st.paused && !userBoat && ap.s >= route.length - 3) {
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
  if (userBoat && (here.mode !== "boat" || target.mode !== "boat")) {
    cruiseRiver(st, world);
    return;
  }
  ap.riverDir = 0;
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

/**
 * The user's boat away from the route's boat legs: along the river the way it's heading (or
 * the way the user last pointed it), keeping clear of the banks, at cruise speed, and back
 * the other way near the world's edge.
 */
function cruiseRiver(st: State, world: World): void {
  const v = st.vehicle;
  const ap = st.autopilot;
  const river = world.river;
  const b = world.bounds;
  const flow = river.flowAt(v.x, v.z);
  if (ap.riverDir === 0 || st.control.w > 0.5) {
    const f = forwardOf(v.heading);
    ap.riverDir = f.x * flow.x + f.z * flow.z >= 0 ? 1 : -1;
  }
  const L = Math.max(40, v.speed * 4);
  // Distance inside the world's edge; turn back where the aim gets within `riverTurn` of it,
  // heading outward (nearer the edge than the boat), so it doesn't flip back the next frame.
  const inside = (x: number, z: number) => Math.min(x - b.x0, b.x1 - x, z - b.z0, b.z1 - z);
  let tx = v.x + flow.x * ap.riverDir * L;
  let tz = v.z + flow.z * ap.riverDir * L;
  const e = inside(tx, tz);
  if (e < CONTROL.riverTurn && e < inside(v.x, v.z)) {
    ap.riverDir = ap.riverDir > 0 ? -1 : 1;
    tx = v.x + flow.x * ap.riverDir * L;
    tz = v.z + flow.z * ap.riverDir * L;
  }
  // Off the banks: move the aim point back onto the water, at least the clearance from the bank.
  const keep = CONTROL.riverClearance;
  const hit = river.nearestBank(tx, tz, keep + L);
  if (hit) {
    const wet = river.isWater(tx, tz);
    const side = wet ? 1 : -1;
    const d = hit.d * side;
    if (d < keep) {
      const nx = ((tx - hit.x) / (hit.d || 1)) * side;
      const nz = ((tz - hit.z) / (hit.d || 1)) * side;
      tx = hit.x + nx * keep;
      tz = hit.z + nz * keep;
    }
  }
  const cmd = ap.command;
  cmd.yawRate = pursue(v, tx, tz);
  cmd.accel = clamp(1.2 * (BOAT.cruise - v.speed), -4, 3);
  cmd.climb = 0;
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
  v.takeoffHeld = 0;
  v.userBoat = false;
  v.deckSide.clear();
  const ap = st.autopilot;
  ap.s = s;
  ap.holdLeft = st.paused ? 0 : hold;
  ap.phase = "tour";
  ap.endT = 0;
  ap.riverDir = 0;
  ap.routeMode = p.mode;
  ap.routeTime = route.timeAt(s);
  Object.assign(ap.command, ZERO_COMMAND);
  st.control.w = st.paused ? 1 : 0;
  st.control.idleFor = 0;
  // A jump (or the loop) is the autopilot's: boost goes off with it.
  st.ui.boost = false;
  if (st.sunsetRun.enabled) st.timeOfDay = route.clockAt(ap.routeTime) ?? st.timeOfDay;
}

/** Put the vehicle back at the Japanese Garden, gliding straight, ready to start. */
export function resetToStart(st: State, route: Route): void {
  placeAt(st, route, 0, route.startHold);
}
