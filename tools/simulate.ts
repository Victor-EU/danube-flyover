// Headless runs of the simulation (autopilot, controller, vehicle, camera, cards, loop) on the
// world's query layer from public/data/, at 60 Hz:
// 1. the whole tour with no input, through the end circle and the loop: beats, mode switches,
//    camera modes, cards, tracking error and floor contacts;
// 2. scripted checks of pause, hand-back (with the mode rule), the user's boat, boost and the
//    beat jumps;
// 3. the lighting the tour sees: the night ramp at the two money shots, the sky's blend;
// 4. the heroes in the floor grid, every card's text and picture, the quality tiers and the
//    tram lines;
// 5. the music: licences and credits, the levelling, and which tracks a hands-off pass hears;
// 6. the download budgets: the first-frame set, and all that loads without the music.
// Usage: npm run simulate

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { Color, Vector4 } from "three";
import { BOAT, GLIDER, LOOP } from "../src/config";
import { setPaused } from "../src/controller";
import { Route, type RouteJson } from "../src/route";
import { createSim, type Sim, stepSim } from "../src/sim";
import { type SkyBlend, skyBlend } from "../src/sky";
import { sunPosition } from "../src/sun";
import { nightRamp } from "../src/world/night";
import { type AudioJson, nextTrack } from "../src/audio";
import type { LifeJson } from "../src/effects";
import type { QualityJson } from "../src/quality";
import type { LandmarksJson } from "../src/world/landmarks";
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
const lighting: { parliament: number[]; chainBridge: number[] } = { parliament: [], chainBridge: [] };
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

/** Holds the given input for `seconds` (or until `each` returns true), then releases it. */
function hold(sim: Sim, seconds: number, inp: { steer?: number; throttle?: number; climb?: number; boost?: boolean }, each?: () => boolean | void): number {
  const i = sim.st.input;
  Object.assign(i, { steer: inp.steer ?? 0, throttle: inp.throttle ?? 0, climb: inp.climb ?? 0, boost: inp.boost ?? false, active: true, everUsed: true });
  const t = run(sim, seconds, each);
  Object.assign(i, { steer: 0, throttle: 0, climb: 0, boost: false, active: false });
  return t;
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
  let tookOff = false;
  let lastS = 0;
  // The clock at the two money shots: golden hour over Parliament, night under the Chain Bridge.
  const parliamentClock: number[] = [];
  const chainBridgeClock: number[] = [];
  const chain = world.bridges.names.indexOf("Chain Bridge");
  run(sim, 60 * 15, () => {
    const v = st.vehicle;
    const ap = st.autopilot;
    if (st.camera.target === "parliament" && ap.beat.startsWith("Parliament")) parliamentClock.push(st.timeOfDay);
    const deck = world.bridges.deckAt(v.x, v.z, 0);
    if (deck && deck.bridge === chain && v.y < deck.underside) chainBridgeClock.push(st.timeOfDay);
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
      if (v.mode === "TAKEOFF") tookOff = true;
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
    if (v.mode === "GLIDER" && v.vSpeed > st.control.command.climb + 3) {
      lifted++;
      const c = contacts.get(ap.beat) ?? { frames: 0, worst: 0 };
      c.frames++;
      c.worst = Math.max(c.worst, world.floor.gliderMin(v.x, v.z) - v.y);
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
  check(tookOff, "hands off, the boat takes off where the route does");
  check(endAt > 0 && blackAt - endAt > 5.9 && blackAt - endAt < 6.2, `5 s end circle and 1 s fade (black ${(blackAt - endAt).toFixed(2)} s after the route ends)`);
  check(new Set(cardsShown).size === cardsShown.length, "each card shows once per pass");
  check(maxLateral < 25, "tracks the route within 25 m");
  lighting.parliament = parliamentClock;
  lighting.chainBridge = chainBridgeClock;
}

// 2a. Pause as the glider: it circles at minimum speed; the clock stops; resuming hands back at once.
console.log("\n— Pause, glider (beat 3) —");
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
  check(st.control.w === 1 && st.vehicle.mode === "GLIDER", `user in control after 40 s paused (w ${st.control.w})`);
  check(Math.abs(st.vehicle.speed - 8) < 0.2, `glider at minimum speed (${st.vehicle.speed.toFixed(1)} m/s)`);
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

// 2c. Hand-back on a boat stretch: the user flies the glider off the route before the landing;
//     the autopilot flies back and lands, and the camera keys wait for the next key.
console.log("\n— Hand-back, glider over a boat stretch (beat 6) —");
{
  const sim = createSim(route, world);
  const { st } = sim;
  sim.tour.jumpNow(st, 6);
  // Take over just before the landing point: bank left, then fly straight on along the river.
  const landingS = route.pointS[route.points.findIndex((p, i) => i > 0 && p.mode === "boat" && route.points[i - 1].mode === "glider")];
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

// 2d. Hand-back on a glider stretch: the user holds the boat back past the take-off point.
//     It's their boat now: on hand-back the autopilot keeps it on the river and never takes
//     off; holding E does.
console.log("\n— Hand-back, the user's boat over a glider stretch (beat 9) —");
{
  const sim = createSim(route, world);
  const { st } = sim;
  sim.tour.jumpNow(st, 9);
  // Hold the throttle slightly back (no take-off), past the take-off point.
  const takeoffS = route.pointS[route.points.findIndex((p, i) => i > 0 && p.mode === "glider" && route.points[i - 1].mode === "boat")];
  hold(sim, 120, { throttle: -0.01 }, () => {
    if (st.autopilot.s > takeoffS + 40) st.input.throttle = 0.001;
  });
  check(st.vehicle.mode === "BOAT" && st.autopilot.routeMode === "glider" && st.vehicle.userBoat, `held as the boat past the take-off point (route mode ${st.autopilot.routeMode})`);
  let left = false;
  let dry = 0;
  let path = 0;
  let px = st.vehicle.x;
  let pz = st.vehicle.z;
  run(sim, 90, () => {
    const v = st.vehicle;
    if (v.mode !== "BOAT") left = true;
    if (!world.river.isWater(v.x, v.z)) dry++;
    path += Math.hypot(v.x - px, v.z - pz);
    px = v.x;
    pz = v.z;
  });
  check(!left && st.control.w === 0, `stays the boat for 90 s under the autopilot (${st.vehicle.mode}, w ${st.control.w})`);
  check(dry === 0 && path > 90 * BOAT.cruise * 0.8, `cruising the river: ${path.toFixed(0)} m, ${dry} frames off the water`);
  check(st.autopilot.phase === "tour", "no end circle for the user's boat");
  const up = hold(sim, 3, { climb: 1 }, () => st.vehicle.mode === "TAKEOFF");
  check(st.vehicle.mode === "TAKEOFF" && Math.abs(up - 1) < 0.05, `holding E takes off after ${up.toFixed(2)} s`);
  run(sim, 4);
  check(st.vehicle.mode === "GLIDER" && !st.vehicle.userBoat, `and flies on as the glider (${st.vehicle.mode})`);
}

// 2f. A manual landing on a glider stretch: the boat is the user's from touchdown, and stays a
//     boat for good under the autopilot, going down the river, back at the world's edge, and
//     past the bridge piers without sticking.
console.log("\n— Manual landing on a glider stretch (beat 3), then hands off —");
{
  const sim = createSim(route, world);
  const { st } = sim;
  sim.tour.jumpNow(st, 3);
  run(sim, 2);
  const landed = hold(sim, 40, { climb: -1 }, () => st.vehicle.mode === "LANDING");
  check(st.vehicle.mode === "LANDING" && st.vehicle.userBoat, `Q held lands on the water after ${landed.toFixed(1)} s (route mode ${st.autopilot.routeMode})`);
  let left = false;
  let dry = 0;
  let turns = 0;
  let worst = Infinity;
  let dir = 0;
  let px = st.vehicle.x;
  let pz = st.vehicle.z;
  let path = 0;
  for (let minute = 0; minute < 15; minute++) {
    let step = 0;
    run(sim, 60, () => {
      const v = st.vehicle;
      if (v.mode !== "BOAT" && v.mode !== "LANDING") left = true;
      if (!world.river.isWater(v.x, v.z)) dry++;
      step += Math.hypot(v.x - px, v.z - pz);
      px = v.x;
      pz = v.z;
      if (st.autopilot.riverDir !== 0 && st.autopilot.riverDir !== dir) {
        if (dir !== 0) turns++;
        dir = st.autopilot.riverDir;
      }
    });
    worst = Math.min(worst, step);
    path += step;
  }
  check(!left, `stays the boat for 15 minutes hands off (${st.vehicle.mode})`);
  check(dry === 0, `on the water throughout (${dry} frames off it)`);
  check(worst > 60 * BOAT.cruise * 0.6, `never stuck: at least ${worst.toFixed(0)} m every minute, ${(path / 1000).toFixed(1)} km in all`);
  check(turns >= 1, `turns back at the world's edge (${turns} times)`);
}

// 2g. Boost: the glider and the boat run on to their boost speeds and ease back after; boosting
//     the boat (even with W) never takes it up.
console.log("\n— Boost —");
{
  const sim = createSim(route, world);
  const { st } = sim;
  sim.tour.jumpNow(st, 3);
  run(sim, 2);
  let top = 0;
  hold(sim, 6, { boost: true }, () => {
    top = Math.max(top, st.vehicle.speed);
  });
  check(top > GLIDER.boostSpeed - 1 && st.vehicle.speed <= GLIDER.boostSpeed, `glider boosts to ${top.toFixed(1)} m/s`);
  run(sim, 8);
  check(st.vehicle.speed <= GLIDER.maxSpeed + 0.01, `and eases back to ${st.vehicle.speed.toFixed(1)} m/s within 8 s`);

  sim.tour.jumpNow(st, 7);
  run(sim, 1);
  top = 0;
  hold(sim, 8, { boost: true, throttle: 1 }, () => {
    top = Math.max(top, st.vehicle.speed);
  });
  check(top > BOAT.boostSpeed - 1 && st.vehicle.mode === "BOAT", `boat boosts to ${top.toFixed(1)} m/s with W held, still the boat`);
  // The bar's toggle, as Input.update reads it.
  st.ui.boost = true;
  Object.assign(st.input, { boost: true, active: true });
  run(sim, 10);
  check(st.control.w === 1 && st.vehicle.speed > BOAT.boostSpeed - 1 && world.river.isWater(st.vehicle.x, st.vehicle.z), `boost toggled on: the user's, at ${st.vehicle.speed.toFixed(1)} m/s, on the water`);
  sim.tour.jumpNow(st, 5);
  check(!st.ui.boost, "a jump turns the boost toggle off");
  Object.assign(st.input, { boost: false, active: false });
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
    const want = route.modeAt(beat.s + 1) === "boat" ? "BOAT" : "GLIDER";
    check(peak === 1 && st.ui.fade === 0 && Math.abs(st.autopilot.s - beat.s) < 60 && st.vehicle.mode === want, `jump to ${n}: faded, at s ${st.autopilot.s.toFixed(0)} (beat at ${beat.s.toFixed(0)}), ${st.vehicle.mode}`);
  }
}

// 3. Lighting along the tour.
console.log("\n— Lighting —");
{
  const clock = (h: number) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
  const span = (list: number[]) => (list.length ? `${clock(Math.min(...list))}–${clock(Math.max(...list))}` : "never");
  const elev = (h: number) => sunPosition(h).elevation;
  const p = lighting.parliament;
  const c = lighting.chainBridge;
  console.log(`  Parliament orbit ${span(p)}, sun ${p.length ? `${elev(Math.max(...p)).toFixed(1)}° to ${elev(Math.min(...p)).toFixed(1)}°` : "-"}`);
  console.log(`  under the Chain Bridge ${span(c)}, sun ${c.length ? `${elev(Math.min(...c)).toFixed(1)}°` : "-"}`);
  check(nightRamp(3) === 0 && nightRamp(-12) === 1 && Math.abs(nightRamp(-4.5) - 0.5) < 1e-9, "night ramp: 0 at +3°, 1 at -12°");
  check(p.length > 0 && p.every((h) => elev(h) > 0 && nightRamp(elev(h)) < 0.25), "golden hour over Parliament: sun up, city lights barely on");
  check(c.length > 0 && c.every((h) => nightRamp(elev(h)) > 0.95), "full night under the Chain Bridge");
  // The painted skies always add up to one sky, morning and evening.
  const b: SkyBlend = { weights: new Vector4(), painted: 0, gain: 1, tint: new Color(), night: 0, stars: 0, moon: 0 };
  let sums = true;
  let night = true;
  for (let e = -30; e <= 60; e += 0.5)
    for (const morning of [true, false]) {
      skyBlend(e, morning, b);
      const w = b.weights;
      if (Math.abs(w.x + w.y + w.z - 1) > 1e-9 || (morning ? w.z : w.x) !== 0) sums = false;
      if ((e >= -6 && b.night !== 0) || (e <= -12 && b.night !== 1)) night = false;
    }
  check(sums, "sky: dawn (mornings) or golden hour (evenings) plus day add up to one");
  check(night, "sky: the night panorama fades in between -6° and -12°");
}

// 4. The heroes, quality tiers and ambient life (M4).
console.log("\n— Heroes, quality and life —");
{
  const lm = json<LandmarksJson>("landmarks.json").landmarks;
  const missing = lm.filter((l) => l.model && !existsSync(new URL(`../public/data/${l.model}`, import.meta.url)));
  check(missing.length === 0, `every landmark's model is built (${lm.filter((l) => l.model).length} models${missing.length ? `; missing ${missing.map((l) => l.id).join(", ")}` : ""})`);
  check(lm.every((l) => !l.placeholder), "no placeholder blocks left");
  check(lm.every((l) => l.text && l.illustration && existsSync(new URL(`../public/data/${l.illustration}`, import.meta.url))), "every card has its paragraph and illustration");
  // The floor grid rises over the heroes, so the glider can't fly through them (15 m clearance).
  const top = (id: string) => {
    const sgt = world.sights.find((x) => x.id === id)!;
    let h = 0;
    for (let dz = -6; dz <= 6; dz += 2) for (let dx = -6; dx <= 6; dx += 2) h = Math.max(h, world.floor.surface(sgt.x + dx, sgt.z + dz, false));
    return h;
  };
  const tops = { parliament: top("parliament"), matthias: top("matthias"), libertyStatue: top("libertyStatue"), palace: top("palace") };
  console.log(`  floor over the heroes: ${Object.entries(tops).map(([k, v]) => `${k} ${v.toFixed(0)} m`).join(", ")}`);
  check(tops.parliament > 95 && tops.libertyStatue > 155, "the glider's floor includes the dome and the statue");
  const q = json<QualityJson>("quality.json");
  const keys = Object.keys(q.tiers.high).sort().join();
  check(["high", "medium", "low"].every((t) => Object.keys(q.tiers[t as "high"]).sort().join() === keys) && q.tiers.low.shadowMapSize === 0 && !q.tiers.low.reflections, "quality.json: three tiers with the same settings; low has no shadows or reflections");
  const life = json<LifeJson>("life.json");
  const lens = life.trams.map((t) => {
    let l = 0;
    let wet = 0;
    for (let i = 3; i < t.path.length; i += 3) {
      l += Math.hypot(t.path[i] - t.path[i - 3], t.path[i + 2] - t.path[i - 1]);
      if (world.river.isWater(t.path[i], t.path[i + 2])) wet++;
    }
    return { l, wet };
  });
  check(lens.length === 2 && lens.every((t) => t.l > 1500 && t.wet === 0), `two tram lines on land along the banks (${lens.map((t) => `${(t.l / 1000).toFixed(1)} km`).join(", ")})`);
}

// 5. The music (after M4).
console.log("\n— Music —");
{
  const { tracks } = json<AudioJson>("audio.json");
  const file = (t: { file: string }) => new URL(`../public/data/audio/${t.file}`, import.meta.url);
  check(tracks.length > 0 && tracks.every((t) => existsSync(file(t))), `every track is encoded (${tracks.length})`);
  // Only licences that allow hosting the file in a public build: CC0 or CC BY, never NC or ND.
  check(tracks.every((t) => /^(CC0 1\.0|CC BY \d\.\d)$/.test(t.licence) && t.licenceUrl && t.source && t.title && t.artist), "every track is CC0 or CC BY, with its credit");
  check(tracks.every((t) => t.gain > 0 && t.gain < 4 && t.seconds > 60), "every track is levelled and trimmed (npm run audio)");
  const mb = tracks.reduce((a, t) => a + statSync(file(t)).size, 0) / 1e6;
  check(mb <= 20, `${mb.toFixed(1)} MB of music, within its 20 MB (streamed once the music is turned on)`);
  // Two passes hands-off from 17:30, with the playlist's rule: each next track, 6 s before
  // the end of the last, is the next one for the light.
  const sim = createSim(route, world);
  const { st } = sim;
  const nightAt: number[] = [];
  run(sim, route.totalTime, () => {
    if (Math.round(st.t / dt) % 60 === 0) nightAt.push(nightRamp(sunPosition(st.timeOfDay).elevation));
  });
  // The second pass starts after the end circle and the fade through black.
  const pass = route.totalTime + LOOP.circle + LOOP.fadeOut;
  const night = (t: number) => nightAt[Math.min(nightAt.length - 1, Math.floor(t % pass))];
  const played: { track: number; at: number }[] = [];
  const last = { day: -1, night: -1 };
  for (let t = 0; t < 2 * pass; t += tracks[played[played.length - 1].track].seconds - 6) {
    played.push({ track: nextTrack(tracks, night(t) > 0.5 ? "night" : "day", last), at: t });
  }
  console.log(`  two passes hear: ${played.map((p) => `${tracks[p.track].title} at ${mmss(p.at)}`).join(", ")}`);
  const lights = played.map((p) => tracks[p.track].light);
  check(lights[0] === "day" && lights.slice(1).includes("night"), "a day track at golden hour, then night tracks after dusk");
  check(new Set(played.map((p) => p.track)).size === tracks.length, "every track plays within two passes");
}

// 6. The download budgets: the first-frame set, and all that loads without the music. Since
// the realism pass size is no longer the design's constraint (the roofed city, the ground's
// mask, the trees and the traffic outweigh the old 25 MB); these catch an accidental blow-up.
// The total rose to 100 MB with the far field's roofed buildings (13.6 MB of the 17.6), which
// stream in after the first frame.
const BUDGET = { first: 70, total: 100 };
console.log("\n— Downloads —");
{
  const root = new URL("../public/data/", import.meta.url);
  const sizeOf = (dir: URL): number =>
    readdirSync(dir, { withFileTypes: true }).reduce((a, e) => a + (e.isDirectory() ? sizeOf(new URL(`${e.name}/`, dir)) : statSync(new URL(e.name, dir)).size), 0);
  const all = sizeOf(root) / 1e6;
  const audio = sizeOf(new URL("audio/", root)) / 1e6;
  const cards = sizeOf(new URL("cards/", root)) / 1e6;
  const full = sizeOf(new URL("tex/full/", root)) / 1e6;
  const far = sizeOf(new URL("far/", root)) / 1e6;
  const first = all - audio - cards - full - far;
  check(first <= BUDGET.first, `${first.toFixed(1)} MB in the first-frame set, within its ${BUDGET.first} MB`);
  check(
    first + full + far + cards <= BUDGET.total,
    `${(first + full + far + cards).toFixed(1)} MB with what streams in after the first frame (the full-size textures ${full.toFixed(1)} MB, the far field ${far.toFixed(1)} MB) and the cards (${cards.toFixed(1)} MB), within the ${BUDGET.total} MB initial download`,
  );
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
