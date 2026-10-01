// Headless autopilot run: builds the world, flies the whole route at 60 Hz with no input and
// reports beats, mode switches, tracking error and constraint contacts.
// Usage: npm run simulate

import { readFileSync } from "node:fs";
import { resetToStart, updateAutopilot } from "../src/autopilot";
import { updateController } from "../src/controller";
import { Route, type RouteJson } from "../src/route";
import { createState } from "../src/state";
import { updateVehicle } from "../src/vehicle";
import { buildWorld } from "../src/world/world";

const route = new Route(
  JSON.parse(readFileSync(new URL("../public/data/route.json", import.meta.url), "utf8")) as RouteJson,
);
const world = buildWorld();
console.log("build ms:", world.timings);
console.log(
  `solids ${world.city.solids.length}, decks ${world.bridges.decks.length}, obstacles ${world.bridges.obstacles.length}`,
);

const st = createState();
resetToStart(st, route);
const dt = 1 / 60;
const mmss = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
let lastMode = st.vehicle.mode;
let lastBeat = "";
let maxLateral = 0;
let maxLateralAt = "";
let lifted = 0;
let wet = 0;
const contacts = new Map<string, { frames: number; worst: number }>();
let lastS = 0;
for (let i = 0; i < 60 * 60 * 15; i++) {
  st.t += dt;
  st.dt = dt;
  updateAutopilot(st, route, dt);
  updateController(st, world, dt);
  const yBefore = st.vehicle.y;
  updateVehicle(st, world, route, dt);
  const v = st.vehicle;
  if (st.autopilot.s < lastS - 100) {
    console.log(`${mmss(st.t)}  route restarted`);
    break;
  }
  lastS = st.autopilot.s;
  if (st.autopilot.beat !== lastBeat) {
    lastBeat = st.autopilot.beat;
    console.log(`${mmss(st.t)}  beat: ${lastBeat}  (clock ${st.timeOfDay.toFixed(2)} h)`);
  }
  if (v.mode !== lastMode) {
    console.log(`${mmss(st.t)}  mode ${lastMode} -> ${v.mode} at y=${v.y.toFixed(1)} speed=${v.speed.toFixed(1)}`);
    lastMode = v.mode;
  }
  if (v.mode === "BIRD" && v.y - yBefore > st.control.command.climb * dt + 0.05) {
    lifted++;
    const c = contacts.get(st.autopilot.beat) ?? { frames: 0, worst: 0 };
    c.frames++;
    c.worst = Math.max(c.worst, world.floor.birdMin(v.x, v.z) - v.y);
    contacts.set(st.autopilot.beat, c);
  }
  if (v.mode === "BIRD" && world.river.isWater(v.x, v.z) === false && v.y < world.floor.birdMin(v.x, v.z) - 1) wet++;
  if (v.lateral > maxLateral && st.autopilot.holdLeft <= 0) {
    maxLateral = v.lateral;
    maxLateralAt = `${mmss(st.t)} ${st.autopilot.beat}`;
  }
}
console.log(`\nmax distance from route ${maxLateral.toFixed(1)} m at ${maxLateralAt}`);
console.log(`frames lifted by the floor: ${lifted}; frames more than 1 m below the land floor: ${wet}`);
for (const [beat, c] of contacts) console.log(`  lifted in "${beat}": ${c.frames} frames, worst ${c.worst.toFixed(1)} m below the floor`);
