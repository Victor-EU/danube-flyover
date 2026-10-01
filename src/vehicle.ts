// Integrates the bird or boat from the blended command, plays the scripted landing and
// take-off curves, and applies the constraints: corridor, world edge, ceiling, altitude
// floor and bridge decks for the bird; river polygon and piers for the boat.

import { BIRD, BOAT, TRANSITION, WORLD } from "./config";
import { forwardOf, headingOf, wrapAngle, type XZ } from "./geo";
import type { Route, RouteSample } from "./route";
import type { State, VehicleState } from "./state";
import type { World } from "./world/world";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);
const routePt: RouteSample = { x: 0, y: 0, z: 0, heading: 0, speed: 0, mode: "bird" };

export function updateVehicle(st: State, world: World, route: Route, dt: number): void {
  const v = st.vehicle;
  const cmd = st.control.command;

  if (st.autopilot.holdLeft > 0) {
    // Hovering over the Japanese Garden before the tour starts.
    v.vSpeed = 0;
    v.yawRate = 0;
    updateVisuals(st, dt);
    return;
  }

  const prev = { x: v.x, z: v.z };
  const y0 = v.y;
  switch (v.mode) {
    case "BIRD":
      v.yawRate = cmd.yawRate;
      v.speed = clamp(v.speed + cmd.accel * dt, BIRD.minSpeed, BIRD.maxSpeed);
      v.y += cmd.climb * dt;
      break;
    case "BOAT":
      v.yawRate = cmd.yawRate;
      v.speed = clamp(v.speed + cmd.accel * dt, BOAT.minSpeed, BOAT.maxSpeed);
      v.y = 0;
      break;
    case "LANDING": {
      // 2.0 s: speed eases to boat cruise, altitude to the water, pitch to level.
      const e = smoothstep(0, 1, v.transitionT / TRANSITION.landing);
      v.yawRate = cmd.yawRate;
      v.speed = v.transitionFrom.speed + (BOAT.cruise - v.transitionFrom.speed) * e;
      v.y = v.transitionFrom.y * (1 - e);
      break;
    }
    case "TAKEOFF": {
      // 2.5 s: speed rises to bird cruise, altitude to 25 m on an ease-out.
      const u = clamp(v.transitionT / TRANSITION.takeoff, 0, 1);
      v.yawRate = cmd.yawRate;
      v.speed = v.transitionFrom.speed + (BIRD.cruise - v.transitionFrom.speed) * smoothstep(0, 1, u);
      v.y = TRANSITION.takeoffAltitude * easeOut(u);
      break;
    }
  }
  v.heading = wrapAngle(v.heading + v.yawRate * dt);
  const f = forwardOf(v.heading);
  v.x += f.x * v.speed * dt;
  v.z += f.z * v.speed * dt;

  route.sample(st.autopilot.s, routePt);
  v.lateral = Math.hypot(v.x - routePt.x, v.z - routePt.z);

  const birdLike = v.mode === "BIRD" || (v.mode === "TAKEOFF" && v.transitionT > 1.0);
  const boatLike = v.mode === "BOAT" || (v.mode === "LANDING" && v.transitionT > 1.0);
  if (birdLike) constrainBird(v, world, dt);
  if (boatLike) constrainBoat(v, world, prev);
  v.vSpeed = (v.y - y0) / Math.max(dt, 1e-4);
  updateVisuals(st, dt);
}

function constrainBird(v: VehicleState, world: World, dt: number): void {
  const b = world.bounds;
  const m = WORLD.edgeMargin;

  // World edge: turn back toward the middle, and never leave.
  if (v.x < b.x0 + m || v.x > b.x1 - m || v.z < b.z0 + m || v.z > b.z1 - m) {
    turnToward(v, headingOf((b.x0 + b.x1) / 2 - v.x, (b.z0 + b.z1) / 2 - v.z), dt, 1);
  }
  v.x = clamp(v.x, b.x0 + 10, b.x1 - 10);
  v.z = clamp(v.z, b.z0 + 10, b.z1 - 10);

  // Corridor: pushing past 300 m from the route slows and turns the bird back.
  const over = v.lateral - BIRD.corridor;
  if (over > 0) {
    turnToward(v, headingOf(routePt.x - v.x, routePt.z - v.z), dt, Math.min(1, over / 40));
    v.speed = Math.max(BIRD.minSpeed, v.speed - 3 * dt * Math.min(1, over / 40));
    if (over > 40) {
      const k = (BIRD.corridor + 40) / v.lateral;
      v.x = routePt.x + (v.x - routePt.x) * k;
      v.z = routePt.z + (v.z - routePt.z) * k;
    }
  }

  // Ceiling.
  v.y = Math.min(v.y, BIRD.ceiling);

  // Bridge decks: decide under or over on approach, then hold to it.
  const f = forwardOf(v.heading);
  const onDeck = world.bridges.deckAt(v.x, v.z, 10);
  const deck = onDeck ?? world.bridges.deckAhead(v.x, v.z, f.x, f.z, v.speed * 1.5);
  let under = false;
  let maxY = Infinity;
  let deckMin = 0;
  if (deck) {
    let side = v.deckSide.get(deck.bridge);
    if (!side) {
      side = v.y < (deck.underside + deck.top) / 2 ? "under" : "over";
      v.deckSide.set(deck.bridge, side);
    }
    if (side === "under") {
      under = true;
      maxY = deck.underside - 1.5;
    } else deckMin = deck.top + BIRD.deckClearance;
  } else if (v.deckSide.size) v.deckSide.clear();

  // Floor, with lookahead so the bird climbs before a building rather than at it.
  let need = 0;
  for (const t of [0, 0.5, 1, 2]) {
    const px = v.x + f.x * v.speed * t;
    const pz = v.z + f.z * v.speed * t;
    const min = Math.max(world.floor.birdMin(px, pz, under), t === 0 ? deckMin : 0);
    need = Math.max(need, (min - v.y) / Math.max(t, 0.3));
  }
  if (need > 0) {
    v.y += Math.min(need, 25) * dt;
    v.speed = Math.max(BIRD.minSpeed, v.speed - 4 * dt);
  }
  v.y = Math.max(v.y, world.floor.hardMin(v.x, v.z, under));
  if (onDeck && !under) v.y = Math.max(v.y, onDeck.top + 2);

  if (under) {
    if (v.y > maxY) v.y += (maxY - v.y) * Math.min(1, dt * 6);
    if (onDeck) v.y = Math.min(v.y, maxY + 1);
    const push = world.bridges.pushOut(v.x, v.z, v.y, 2);
    if (push) applyPush(v, push);
  }
}

function constrainBoat(v: VehicleState, world: World, prev: XZ): void {
  const margin = BOAT.bankMargin;
  const river = world.river;
  const hit = river.nearestBank(v.x, v.z, 40);
  if (!river.isWater(v.x, v.z)) {
    // Crossed the bank: back onto the water side, `margin` from the bank.
    if (hit) {
      let nx = prev.x - hit.x;
      let nz = prev.z - hit.z;
      const l = Math.hypot(nx, nz) || 1;
      nx /= l;
      nz /= l;
      applyPush(v, { x: hit.x + nx * margin - v.x, z: hit.z + nz * margin - v.z });
    } else {
      v.x = prev.x;
      v.z = prev.z;
    }
  } else if (hit && hit.d < margin) {
    const nx = (v.x - hit.x) / (hit.d || 1);
    const nz = (v.z - hit.z) / (hit.d || 1);
    applyPush(v, { x: nx * (margin - hit.d), z: nz * (margin - hit.d) });
  }
  const push = world.bridges.pushOut(v.x, v.z, 0, 3);
  if (push) applyPush(v, push);
  const b = world.bounds;
  v.x = clamp(v.x, b.x0 + 20, b.x1 - 20);
  v.z = clamp(v.z, b.z0 + 20, b.z1 - 20);
}

/** Move by `push` and slide along the surface: remove the velocity component into it. */
function applyPush(v: VehicleState, push: XZ): void {
  v.x += push.x;
  v.z += push.z;
  const l = Math.hypot(push.x, push.z);
  if (l < 1e-6) return;
  const nx = push.x / l;
  const nz = push.z / l;
  const f = forwardOf(v.heading);
  const into = f.x * nx + f.z * nz;
  if (into < 0) {
    v.heading = headingOf(f.x - into * nx, f.z - into * nz);
    v.speed *= 1 + 0.5 * into;
  }
}

function turnToward(v: VehicleState, heading: number, dt: number, strength: number): void {
  const maxYaw = v.mode === "BOAT" ? BOAT.maxYawRate : BIRD.maxYawRate;
  const err = wrapAngle(heading - v.heading);
  v.heading = wrapAngle(v.heading + clamp(err, -1, 1) * maxYaw * strength * dt);
}

function updateVisuals(st: State, dt: number): void {
  const v = st.vehicle;
  const k = Math.min(1, dt * 4);
  if (v.mode === "BOAT" || v.mode === "LANDING") {
    const lean = clamp(-v.yawRate * 0.5, -0.12, 0.12);
    v.roll += (lean + Math.sin(st.t * 1.7) * 0.025 - v.roll) * k;
    v.pitch += (Math.sin(st.t * 1.1) * 0.02 - v.pitch) * k;
  } else {
    const bank = clamp(Math.atan((v.speed * v.yawRate) / 9.81), -0.9, 0.9);
    v.roll += (bank - v.roll) * k;
    v.pitch += (clamp(Math.atan2(v.vSpeed, Math.max(v.speed, 1)), -0.6, 0.6) - v.pitch) * k;
  }
  // Bird and boat meshes swap behind the splash: landing at about 1.0 s, take-off at about 0.5 s.
  if (v.mode === "BIRD") v.boatness = 0;
  else if (v.mode === "BOAT") v.boatness = 1;
  else if (v.mode === "LANDING") v.boatness = smoothstep(0.8, 1.2, v.transitionT);
  else v.boatness = 1 - smoothstep(0.3, 0.7, v.transitionT);
}
