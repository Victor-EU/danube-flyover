// Headless runs of the simulation (autopilot, controller, vehicle, camera, cards, loop) on the
// world's query layer from public/data/, at 60 Hz:
// 1. the whole tour with no input, through the end circle and the loop: beats, mode switches,
//    camera modes, cards, tracking error and floor contacts;
// 2. scripted checks of pause, hand-back (with the mode rule) and the beat jumps.
// Usage: npm run simulate

import { readFileSync } from "node:fs";
import { setPaused } from "../src/controller";
import { Route, type RouteJson } from "../src/route";
import { createSim, type Sim, stepSim } from "../src/sim";
import { buildWorld } from "../src/world/world";

const data = (name: string) => readFileSync(new URL(`../public/data/${name}`, import.meta.url));
const json = <T>(name: string) => JSON.parse(data(name).toString("utf8")) as T;
const route = new Route(json<RouteJson>("route.json"));
const world = buildWorld({
  river: json("river.json"),
  bridges: json("bridges.json"),
  landmarks: json("landmarks.json"),
  trees: json("trees.json"),
  terrain: new Uint8Array(data("terrain.bin")),
  floor: new Uint8Array(data("floor.bin")),
});
console.log("build ms:", world.timings);
console.log(`bridges ${world.bridges.names.length}, obstacles ${world.bridges.obstacles.length}, floor ${world.floor.nx} × ${world.floor.nz}`);

const dt = 1 / 60;
const mmss = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures++;
};

/** Steps `seconds`, calling `each` after every step; stops early if it returns true. */
function run(sim: Sim, seconds: number, each?: () => boolean | void): number {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    stepSim(sim, dt);
    if (each?.()) return (i + 1) * dt;
  }
  return seconds;
}

/** Holds the given input for `seconds`, then releases it. */
function hold(sim: Sim, seconds: number, inp: { steer?: number; throttle?: number; climb?: number }, each?: () => void): void {
  const i = sim.st.input;
  Object.assign(i, { steer: inp.steer ?? 0, throttle: inp.throttle ?? 0, climb: inp.climb ?? 0, active: true, everUsed: true });
  run(sim, seconds, each);
  Object.assign(i, { steer: 0, throttle: 0, climb: 0, active: false });
}

// 1. The tour, hands off, through the loop.
console.log("\n— Tour, no input —");
{
  const sim = createSim(route, world);
  const { st } = sim;
  let lastMode = st.vehicle.mode;
  let lastBeat = "";
  let lastCam = "";
  let lastCard: string | null = null;
  let maxLateral = 0;
  let maxLateralAt = "";
  let lifted = 0;
  const contacts = new Map<string, { frames: number; worst: number }>();
  let endAt = -1;
  let blackAt = -1;
  const cardsShown: string[] = [];
  let looped = false;
  let lastS = 0;
  run(sim, 60 * 15, () => {
    const v = st.vehicle;
    const ap = st.autopilot;
    if (st.ui.fade >= 1 && blackAt < 0) blackAt = st.t;
    if (ap.s < lastS - 100) {
      console.log(`${mmss(st.t)}  loop: back at the start (s ${ap.s.toFixed(0)}, mode ${v.mode}, clock ${st.timeOfDay.toFixed(2)} h, fade ${st.ui.fade.toFixed(2)})`);
      looped = true;
      return true;
    }
    lastS = ap.s;
    if (ap.beat !== lastBeat) {
      lastBeat = ap.beat;
      console.log(`${mmss(st.t)}  beat: ${lastBeat}  (clock ${st.timeOfDay.toFixed(2)} h)`);
    }
    if (v.mode !== lastMode) {
      console.log(`${mmss(st.t)}  mode ${lastMode} -> ${v.mode} at y=${v.y.toFixed(1)} speed=${v.speed.toFixed(1)}`);
      lastMode = v.mode;
    }
    const cam = `${st.camera.mode}${st.camera.target ? ` → ${st.camera.target}` : ""}`;
    if (cam !== lastCam) {
      console.log(`${mmss(st.t)}    camera ${cam}`);
      lastCam = cam;
    }
    if (st.cards.id !== lastCard) {
      if (st.cards.id) {
        console.log(`${mmss(st.t)}    card: ${st.cards.id}`);
        cardsShown.push(st.cards.id);
      }
      lastCard = st.cards.id;
    }
    if (ap.phase === "end" && endAt < 0) {
      endAt = st.t;
      console.log(`${mmss(st.t)}  end of the route: circling`);
    }
    if (v.mode === "BIRD" && v.vSpeed > st.control.command.climb + 3) {
      lifted++;
      const c = contacts.get(ap.beat) ?? { frames: 0, worst: 0 };
      c.frames++;
      c.worst = Math.max(c.worst, world.floor.birdMin(v.x, v.z) - v.y);
      contacts.set(ap.beat, c);
    }
    if (v.lateral > maxLateral && ap.holdLeft <= 0 && ap.phase === "tour") {
      maxLateral = v.lateral;
      maxLateralAt = `${mmss(st.t)} ${ap.beat}`;
    }
  });
  console.log(`\nmax distance from route ${maxLateral.toFixed(1)} m at ${maxLateralAt}`);
  console.log(`frames lifted by the floor: ${lifted}`);
  for (const [beat, c] of contacts) console.log(`  lifted in "${beat}": ${c.frames} frames, worst ${c.worst.toFixed(1)} m below the floor`);
  console.log(`cards: ${cardsShown.length} (${cardsShown.join(", ")})`);
  check(looped, "the tour loops back to the Japanese Garden");
  check(endAt > 0 && blackAt - endAt > 5.9 && blackAt - endAt < 6.2, `5 s end circle and 1 s fade (black ${(blackAt - endAt).toFixed(2)} s after the route ends)`);
  check(new Set(cardsShown).size === cardsShown.length, "each card shows once per pass");
  check(maxLateral < 25, "tracks the route within 25 m");
}

// 2a. Pause as the bird: it circles at minimum speed; the clock stops; resuming hands back at once.
console.log("\n— Pause, bird (beat 3) —");
{
  const sim = createSim(route, world);
  const { st } = sim;
  sim.tour.jumpNow(st, 3);
  run(sim, 2);
  setPaused(st, true);
  const x0 = st.vehicle.x;
  const z0 = st.vehicle.z;
  const clock = st.timeOfDay;
  let far = 0;
  let minClear = Infinity;
  run(sim, 40, () => {
    const v = st.vehicle;
    far = Math.max(far, Math.hypot(v.x - x0, v.z - z0));
    minClear = Math.min(minClear, v.y - world.floor.surface(v.x, v.z));
  });
  check(st.control.w === 1 && st.vehicle.mode === "BIRD", `user in control after 40 s paused (w ${st.control.w})`);
  check(Math.abs(st.vehicle.speed - 8) < 0.2, `bird at minimum speed (${st.vehicle.speed.toFixed(1)} m/s)`);
  check(far < 200, `circles near where it paused (furthest ${far.toFixed(0)} m)`);
  check(st.timeOfDay === clock, "the sunset-run clock stops");
  console.log(`  lowest clearance above the floor surface: ${minClear.toFixed(1)} m`);
  setPaused(st, false);
  const back = run(sim, 6, () => st.control.w === 0);
  check(back < 2.2, `resume blends back to the autopilot in ${back.toFixed(2)} s`);
}

// 2b. Pause as the boat: it idles to a stop.
console.log("\n— Pause, boat (beat 7) —");
{
  const sim = createSim(route, world);
  const { st } = sim;
  sim.tour.jumpNow(st, 7);
  run(sim, 1);
  setPaused(st, true);
  const x0 = st.vehicle.x;
  const z0 = st.vehicle.z;
  run(sim, 30);
  const drift = Math.hypot(st.vehicle.x - x0, st.vehicle.z - z0);
  check(st.vehicle.speed === 0 && st.vehicle.mode === "BOAT", `boat stopped (${st.vehicle.speed.toFixed(2)} m/s)`);
  check(drift < 40, `drifted ${drift.toFixed(1)} m while stopping`);
  check(world.river.isWater(st.vehicle.x, st.vehicle.z), "still on the water");
}

// 2c. Hand-back on a boat stretch: the user flies the bird off the route before the landing;
//     the autopilot flies back and lands, and the camera keys wait for the next key.
console.log("\n— Hand-back, bird over a boat stretch (beat 6) —");
{
  const sim = createSim(route, world);
  const { st } = sim;
  sim.tour.jumpNow(st, 6);
  // Take over just before the landing point: bank left, then fly straight on along the river.
  const landingS = route.pointS[route.points.findIndex((p, i) => i > 0 && p.mode === "boat" && route.points[i - 1].mode === "bird")];
  run(sim, 60, () => st.autopilot.s > landingS - 60);
  hold(sim, 1.5, { steer: -1 });
  hold(sim, 5, { climb: 0.01 });
  const lateral = st.vehicle.lateral;
  const routeMode = st.autopilot.routeMode;
  check(st.camera.suspended, "camera keys suspended while the user has control");
  let landedAt = -1;
  let wZero = -1;
  const released = st.t;
  run(sim, 60, () => {
    if (wZero < 0 && st.control.w === 0) wZero = st.t - released;
    if (st.vehicle.mode === "LANDING") landedAt = st.t - released;
    return landedAt > 0;
  });
  console.log(`  released ${lateral.toFixed(0)} m from the route (route mode there: ${routeMode}); w back to 0 after ${wZero.toFixed(1)} s, landing after ${landedAt.toFixed(1)} s`);
  check(landedAt > 0, `the autopilot lands on its own (lateral ${st.vehicle.lateral.toFixed(1)} m at landing)`);
  run(sim, 3);
  check(st.vehicle.mode === "BOAT" && world.river.isWater(st.vehicle.x, st.vehicle.z), "and carries on as the boat");
  const key = st.camera.key;
  check(st.camera.suspended && st.camera.mode !== "orbit", `camera keys stay suspended until the next key (key ${key}, ${st.camera.mode})`);
  run(sim, 400, () => st.camera.key !== key);
  run(sim, 0.1);
  check(!st.camera.suspended, `camera keys resume at the next key (key ${st.camera.key}, ${st.camera.mode})`);
}

// 2d. Hand-back on a bird stretch: the user holds the boat back past the take-off point;
//     on hand-back the autopilot takes off at once (clear of bridge decks).
console.log("\n— Hand-back, boat over a bird stretch (beat 9) —");
{
  const sim = createSim(route, world);
  const { st } = sim;
  sim.tour.jumpNow(st, 9);
  // Hold the throttle slightly back (no take-off), past the take-off point.
  const takeoffS = route.pointS[route.points.findIndex((p, i) => i > 0 && p.mode === "bird" && route.points[i - 1].mode === "boat")];
  hold(sim, 120, { throttle: -0.01 }, () => {
    if (st.autopilot.s > takeoffS + 40) st.input.throttle = 0.001;
  });
  check(st.vehicle.mode === "BOAT" && st.autopilot.routeMode === "bird", `held as the boat past the take-off point (route mode ${st.autopilot.routeMode})`);
  let tookOff = -1;
  const t0 = st.t;
  run(sim, 30, () => {
    if (st.vehicle.mode === "TAKEOFF") tookOff = st.t - t0;
    return tookOff > 0;
  });
  check(tookOff > 0 && tookOff < 5.5, `takes off ${tookOff.toFixed(1)} s after release (3 s idle, then as soon as w < 0.5)`);
}

// 2e. Beat jumps fade through black and land on the beat start in the route's mode.
console.log("\n— Jumps —");
{
  const sim = createSim(route, world);
  const { st } = sim;
  for (const n of [5, 8, 10, 1]) {
    sim.tour.jump(n);
    let peak = 0;
    run(sim, 2, () => {
      peak = Math.max(peak, st.ui.fade);
    });
    const beat = route.beats.find((b) => b.id === n)!;
    const want = route.modeAt(beat.s + 1) === "boat" ? "BOAT" : "BIRD";
    check(peak === 1 && st.ui.fade === 0 && Math.abs(st.autopilot.s - beat.s) < 60 && st.vehicle.mode === want, `jump to ${n}: faded, at s ${st.autopilot.s.toFixed(0)} (beat at ${beat.s.toFixed(0)}), ${st.vehicle.mode}`);
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
