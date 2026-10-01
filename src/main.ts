// Danube Flyover, M0 grey box: wires the modules into one frame loop.
// Order per frame: input → autopilot → controller → vehicle → lighting → camera → HUD → render.

import "./style.css";
import { ACESFilmicToneMapping, PCFShadowMap, SRGBColorSpace, Scene, WebGLRenderer } from "three";
import { resetToStart, updateAutopilot } from "./autopilot";
import { CameraRig } from "./camera";
import { updateController } from "./controller";
import { Hud } from "./hud";
import { Input } from "./input";
import { Lighting } from "./lighting";
import { Route, type RouteJson } from "./route";
import { createState } from "./state";
import { updateVehicle } from "./vehicle";
import { VehicleMesh } from "./vehicleMesh";
import { buildWorld } from "./world/world";

function fatal(message: string): void {
  const el = document.getElementById("fatal")!;
  el.textContent = message;
  el.hidden = false;
  document.getElementById("loading")!.hidden = true;
}

async function main(): Promise<void> {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  } catch {
    fatal("Danube Flyover needs WebGL2, which this browser doesn't provide.");
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  const res = await fetch("data/route.json");
  if (!res.ok) return fatal(`Couldn't load data/route.json (${res.status}).`);
  const route = new Route((await res.json()) as RouteJson);

  // Let "Building Budapest…" paint before the synchronous world build (no rAF: it stalls in hidden tabs).
  await new Promise((r) => setTimeout(r, 30));
  const world = buildWorld();

  const scene = new Scene();
  scene.add(world.group);
  const lighting = new Lighting(scene, world.water);
  const vehicleMesh = new VehicleMesh();
  scene.add(vehicleMesh.group);
  const rig = new CameraRig();

  const st = createState();
  resetToStart(st, route);
  const input = new Input(canvas, {
    KeyT: () => (st.ui.sliderVisible = !st.ui.sliderVisible),
    Backquote: () => (st.ui.debug = !st.ui.debug),
  });
  const hud = new Hud(st, route, world);

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    rig.resize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", resize);
  resize();

  // Debug hooks for the console. flyover.jump(n) puts the vehicle at the start of beat n.
  const jump = (n: number) => {
    const beat = route.beats.find((b) => b.id === n);
    if (!beat) return;
    const p = route.sample(beat.s);
    const v = st.vehicle;
    Object.assign(v, { x: p.x, y: p.y, z: p.z, heading: p.heading, speed: p.speed, vSpeed: 0, transitionT: 0 });
    v.mode = p.mode === "boat" ? "BOAT" : "BIRD";
    v.boatness = p.mode === "boat" ? 1 : 0;
    st.autopilot.s = beat.s;
    st.autopilot.holdLeft = 0;
    rig.snap();
  };
  const frame = (dt: number, draw = true) => {
    st.dt = dt;
    st.t += dt;
    input.update(st);
    updateAutopilot(st, route, dt);
    updateController(st, world, dt);
    updateVehicle(st, world, route, dt);
    lighting.update(st, renderer, rig.focus, rig.camera.position, dt);
    rig.update(st, world, dt);
    vehicleMesh.update(st, dt);
    hud.update(st, dt);
    if (draw) renderer.render(scene, rig.camera);
  };
  // flyover.step(seconds) advances the simulation at 30 Hz and renders once (works in hidden tabs).
  const step = (seconds: number) => {
    const n = Math.max(1, Math.round(seconds * 30));
    for (let i = 0; i < n; i++) frame(1 / 30, i === n - 1);
  };
  Object.assign(window, { flyover: { st, route, world, rig, scene, renderer, jump, step } });

  document.getElementById("loading")!.hidden = true;
  let last = performance.now();
  renderer.setAnimationLoop((now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    frame(dt);
  });
}

main().catch((err) => {
  console.error(err);
  fatal(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
});
