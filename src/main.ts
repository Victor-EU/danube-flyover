// Danube Flyover: loads the world built by the tools/ pipeline and wires the modules into one
// frame loop.
// Order per frame: input → simulation (autopilot → controller → vehicle → camera → cards →
// tour) → lighting → meshes → HUD → render.

import "./style.css";
import { ACESFilmicToneMapping, PCFShadowMap, type PerspectiveCamera, SRGBColorSpace, Scene, WebGLRenderer } from "three";
import { setPaused } from "./controller";
import { Hud } from "./hud";
import { Input } from "./input";
import { Lighting } from "./lighting";
import { loadWorld } from "./load";
import { Route, type RouteJson } from "./route";
import { createSim, stepSim } from "./sim";
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

  const loading = document.getElementById("loading")!;
  const res = await fetch("data/route.json");
  if (!res.ok) return fatal(`Couldn't load data/route.json (${res.status}).`);
  const route = new Route((await res.json()) as RouteJson);
  const { files, models } = await loadWorld((f) => (loading.textContent = `Building Budapest… ${Math.round(f * 100)}%`));

  // Let the last progress paint before the synchronous world build (no rAF: it stalls in hidden tabs).
  await new Promise((r) => setTimeout(r, 30));
  const world = buildWorld(files, models);

  const scene = new Scene();
  scene.add(world.group);
  const lighting = new Lighting(scene, world.water);
  const vehicleMesh = new VehicleMesh();
  scene.add(vehicleMesh.group);

  const sim = createSim(route, world);
  const { st, rig, tour } = sim;
  // 1–9 and 0 jump to beats 1–10.
  const digits: Record<string, () => void> = {};
  for (let n = 1; n <= 10; n++) digits[`Digit${n % 10}`] = digits[`Numpad${n % 10}`] = () => tour.jump(n);
  const input = new Input(canvas, {
    ...digits,
    Space: () => setPaused(st, !st.paused),
    Escape: () => st.cards.id && sim.cards.dismiss(st),
    KeyT: () => (st.ui.sliderVisible = !st.ui.sliderVisible),
    Backquote: () => (st.ui.debug = !st.ui.debug),
  });
  const hud = new Hud(sim, renderer.info.render);

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    rig.resize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", resize);
  resize();

  // Debug hooks for the console. flyover.jump(n) cuts straight to the start of beat n.
  const jump = (n: number) => tour.jumpNow(st, n);
  // flyover.camera = someCamera renders from it instead of the rig (for overviews); null restores.
  const debug: { camera: PerspectiveCamera | null } = { camera: null };
  const frame = (dt: number, draw = true) => {
    input.update(st);
    stepSim(sim, dt);
    lighting.update(st, renderer, rig.focus, rig.camera.position, dt);
    world.landmarks?.update(rig.camera.position);
    vehicleMesh.update(st, dt);
    hud.update(st, dt);
    if (draw) renderer.render(scene, debug.camera ?? rig.camera);
  };
  // flyover.step(seconds) advances the simulation at 30 Hz and renders once (works in hidden tabs).
  const step = (seconds: number) => {
    const n = Math.max(1, Math.round(seconds * 30));
    for (let i = 0; i < n; i++) frame(1 / 30, i === n - 1);
  };
  Object.assign(window, { flyover: Object.assign(debug, { st, sim, route, world, rig, scene, renderer, jump, step }) });

  loading.hidden = true;
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
