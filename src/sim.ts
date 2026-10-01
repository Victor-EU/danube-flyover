// One simulation step, shared by the browser's frame loop and tools/simulate.ts: everything
// except input, lighting, meshes and the DOM.
// Order: autopilot → controller → vehicle → camera → cards → tour (loop and jumps).

import { resetToStart, updateAutopilot } from "./autopilot";
import { CameraRig } from "./camera";
import { Cards } from "./cards";
import { updateController } from "./controller";
import type { Route } from "./route";
import { createState, type State } from "./state";
import { Tour } from "./tour";
import { updateVehicle } from "./vehicle";
import type { World } from "./world/world";

export interface Sim {
  st: State;
  route: Route;
  world: World;
  rig: CameraRig;
  cards: Cards;
  tour: Tour;
}

export function createSim(route: Route, world: World): Sim {
  const st = createState();
  const rig = new CameraRig(route, world);
  const cards = new Cards(world.sights);
  const tour = new Tour(route, (s) => {
    rig.snap();
    cards.reset(s);
  });
  resetToStart(st, route);
  return { st, route, world, rig, cards, tour };
}

export function stepSim(sim: Sim, dt: number): void {
  const { st, route, world } = sim;
  st.dt = dt;
  st.t += dt;
  updateAutopilot(st, route, dt);
  updateController(st, world, dt);
  updateVehicle(st, world, route, dt);
  sim.rig.update(st, dt);
  sim.cards.update(st, sim.rig.camera, dt);
  sim.tour.update(st, dt);
}
