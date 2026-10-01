// The only module that knows about both the autopilot and the user. It blends their commands
// by the weight `w` and owns the mode state machine: BIRD → LANDING → BOAT → TAKEOFF → BIRD.

import { BIRD, BOAT, CONTROL, TRANSITION } from "./config";
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
  if (inp.active) {
    c.idleFor = 0;
    c.w = Math.min(1, c.w + dt / CONTROL.blendIn);
    ap.holdLeft = 0; // steering cancels the opening hover
  } else {
    c.idleFor += dt;
    if (c.idleFor > CONTROL.idleBeforeReturn) c.w = Math.max(0, c.w - dt / CONTROL.blendOut);
  }

  const transitioning = v.mode === "LANDING" || v.mode === "TAKEOFF";
  const boat = v.mode === "BOAT";
  const maxYaw = boat ? BOAT.maxYawRate : BIRD.maxYawRate;
  // Inputs are ignored during a transition.
  const mYaw = transitioning ? 0 : inp.steer * maxYaw;
  const mAccel = transitioning ? 0 : inp.throttle * (boat ? BOAT.accel : BIRD.accel);
  const mClimb = transitioning || boat ? 0 : inp.climb * (inp.climb < 0 ? BIRD.maxDive : BIRD.maxClimb);
  const a = ap.command;
  c.command.yawRate = lerp(a.yawRate, mYaw, c.w);
  c.command.accel = lerp(a.accel, mAccel, c.w);
  c.command.climb = lerp(a.climb, mClimb, c.w);

  const autopilotDriving = c.w < 0.5 && ap.holdLeft <= 0;
  switch (v.mode) {
    case "BIRD": {
      const overWater = world.river.isWater(v.x, v.z);
      // The 2 m rule is for manual flight; the autopilot lands on its route keyframe.
      const manualLanding = c.w >= 0.5 && overWater && v.y < TRANSITION.landingAltitude && v.vSpeed < 0;
      // Autopilot lands when the route turns to boat; on hand-back this also lands a bird
      // that has flown back onto a boat stretch.
      const autoLanding = autopilotDriving && ap.routeMode === "boat" && overWater && v.lateral < 40;
      if (manualLanding || autoLanding) start(st, "LANDING");
      break;
    }
    case "BOAT": {
      const atMax = inp.throttle > 0.5 && v.speed >= BOAT.maxSpeed - 0.05;
      v.throttleHeld = atMax ? v.throttleHeld + dt : 0;
      const manualTakeoff = v.throttleHeld >= TRANSITION.takeoffHold;
      const autoTakeoff = autopilotDriving && ap.routeMode === "bird";
      if ((manualTakeoff || autoTakeoff) && takeoffAllowed(st, world)) start(st, "TAKEOFF");
      break;
    }
    case "LANDING":
      v.transitionT += dt;
      if (v.transitionT >= TRANSITION.landing) setMode(st, "BOAT");
      break;
    case "TAKEOFF":
      v.transitionT += dt;
      if (v.transitionT >= TRANSITION.takeoff) setMode(st, "BIRD");
      break;
  }
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
