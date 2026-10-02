// The only module that knows about both the autopilot and the user. It blends their commands
// by the weight `w` and owns the mode state machine: GLIDER → LANDING → BOAT → TAKEOFF → GLIDER.
// Pause hands the vehicle to the user and keeps it there: the boat idles and the glider, which
// can't hover, circles at minimum speed until the user steers.

import { GLIDER, BOAT, CONTROL, PAUSE, TRANSITION } from "./config";
import { forwardOf } from "./geo";
import type { Mode, State } from "./state";
import type { World } from "./world/world";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function updateController(st: State, world: World, dt: number): void {
  const c = st.control;
  const inp = st.input;
  const v = st.vehicle;
  const ap = st.autopilot;

  // Blend weight: 0.5 s to the user on input; back to autopilot over 2 s after 3 s idle.
  // Never back while paused.
  if (inp.active || st.paused) {
    if (inp.active) c.idleFor = 0;
    c.w = Math.min(1, c.w + dt / CONTROL.blendIn);
    ap.holdLeft = 0; // steering (or pausing) cancels the opening glide
  } else {
    c.idleFor += dt;
    if (c.idleFor > CONTROL.idleBeforeReturn) c.w = Math.max(0, c.w - dt / CONTROL.blendOut);
  }

  const transitioning = v.mode === "LANDING" || v.mode === "TAKEOFF";
  const boat = v.mode === "BOAT";
  const maxYaw = boat ? BOAT.maxYawRate : GLIDER.maxYawRate;
  // Inputs are ignored during a transition.
  let mYaw = transitioning ? 0 : inp.steer * maxYaw;
  let mAccel = transitioning ? 0 : inp.throttle * (boat ? BOAT.accel : GLIDER.accel);
  const mClimb = transitioning || boat ? 0 : inp.climb * (inp.climb < 0 ? GLIDER.maxDive : GLIDER.maxClimb);
  if (st.paused && !transitioning) {
    // Idle without input: slow to the minimum (a stop, for the boat); the glider keeps
    // circling the way it was already turning.
    if (inp.throttle === 0) mAccel = -(boat ? BOAT.accel : GLIDER.accel);
    if (inp.steer === 0 && !boat) mYaw = (Math.sign(v.yawRate) || 1) * Math.min(maxYaw, v.speed / PAUSE.gliderRadius);
  }
  const a = ap.command;
  c.command.yawRate = lerp(a.yawRate, mYaw, c.w);
  c.command.accel = lerp(a.accel, mAccel, c.w);
  c.command.climb = lerp(a.climb, mClimb, c.w);

  const autopilotDriving = c.w < 0.5 && ap.holdLeft <= 0 && !st.paused;
  switch (v.mode) {
    case "GLIDER": {
      const overWater = world.river.isWater(v.x, v.z);
      // The 2 m rule is for manual flight; the autopilot lands on its route keyframe.
      const manualLanding = c.w >= 0.5 && overWater && v.y < TRANSITION.landingAltitude && v.vSpeed < 0;
      // Autopilot lands when the route turns to boat; on hand-back this also lands a glider
      // that has flown back onto a boat stretch.
      const autoLanding = autopilotDriving && ap.routeMode === "boat" && overWater && v.lateral < 40;
      if (manualLanding || autoLanding) start(st, "LANDING");
      break;
    }
    case "BOAT": {
      const atMax = inp.throttle > 0.5 && v.speed >= BOAT.maxSpeed - 0.05;
      v.throttleHeld = atMax ? v.throttleHeld + dt : 0;
      const manualTakeoff = v.throttleHeld >= TRANSITION.takeoffHold;
      const autoTakeoff = autopilotDriving && ap.routeMode === "glider";
      if ((manualTakeoff || autoTakeoff) && takeoffAllowed(st, world)) start(st, "TAKEOFF");
      break;
    }
    case "LANDING":
      v.transitionT += dt;
      if (v.transitionT >= TRANSITION.landing) setMode(st, "BOAT");
      break;
    case "TAKEOFF":
      v.transitionT += dt;
      if (v.transitionT >= TRANSITION.takeoff) setMode(st, "GLIDER");
      break;
  }
}

/** Space and the bar button. Resuming hands control back at once (no 3 s wait). */
export function setPaused(st: State, paused: boolean): void {
  if (st.paused === paused) return;
  st.paused = paused;
  if (!paused) st.control.idleFor = CONTROL.idleBeforeReturn;
}

function start(st: State, mode: Mode): void {
  const v = st.vehicle;
  v.mode = mode;
  v.transitionT = 0;
  v.transitionFrom.speed = v.speed;
  v.transitionFrom.y = v.y;
  v.throttleHeld = 0;
}

function setMode(st: State, mode: Mode): void {
  const v = st.vehicle;
  v.mode = mode;
  v.transitionT = 0;
  if (mode === "BOAT") v.y = 0;
}

/** Take-off never starts under a bridge deck or within 30 m before one. */
function takeoffAllowed(st: State, world: World): boolean {
  const v = st.vehicle;
  if (world.bridges.deckAt(v.x, v.z, 2)) return false;
  const f = forwardOf(v.heading);
  return world.bridges.deckAhead(v.x, v.z, f.x, f.z, TRANSITION.takeoffDeckGap) === null;
}
