// Danube Flyover: loads the world built by the tools/ pipeline and wires the modules into one
// frame loop.
// Order per frame: input → simulation (autopilot → controller → vehicle → camera → cards →
// tour) → lighting (sky, env map, shadows) → meshes and night lights → water reflection →
// HUD → render (scene → bloom → tone mapping).

import "./style.css";
import {
  ACESFilmicToneMapping,
  type Object3D,
  PCFShadowMap,
  type PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  Vector2,
  WebGLRenderer,
  type WebGLRenderTarget,
} from "three";
import { LOOP } from "./config";
import { setPaused } from "./controller";
import { Hud } from "./hud";
import { Input } from "./input";
import { Lighting } from "./lighting";
import { loadWorld } from "./load";
import { Post } from "./post";
import { Route, type RouteJson } from "./route";
import { createSim, stepSim } from "./sim";
import { SkyDome } from "./sky";
import { setAnisotropy } from "./textures";
import { VehicleMesh } from "./vehicleMesh";
import { SHARED } from "./world/night";
import { NightLights } from "./world/nightLights";
import { LAYER, Water } from "./world/water";
import { buildWorld } from "./world/world";

function fatal(message: string): void {
  const el = document.getElementById("fatal")!;
  el.textContent = message;
  el.hidden = false;
  document.getElementById("loading")!.hidden = true;
}

/** Planar reflections near the two money shots: full within `inner` m of the camera. */
const MIRROR_ZONES = [
  { id: "parliament", inner: 420, outer: 650 },
  { id: "chainBridge", inner: 380, outer: 600 },
];

async function main(): Promise<void> {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  let renderer: WebGLRenderer;
  try {
    // No canvas MSAA: the scene renders into the composer's multisampled target instead.
    renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  } catch {
    fatal("Danube Flyover needs WebGL2, which this browser doesn't provide.");
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  // The composer renders several passes a frame: count them all, reset once per frame.
  renderer.info.autoReset = false;

  const loading = document.getElementById("loading")!;
  const res = await fetch("data/route.json");
  if (!res.ok) return fatal(`Couldn't load data/route.json (${res.status}).`);
  const route = new Route((await res.json()) as RouteJson);
  const { files, models } = await loadWorld((f) => (loading.textContent = `Building Budapest… ${Math.round(f * 100)}%`));

  // Let the last progress paint before the synchronous world build (no rAF: it stalls in hidden tabs).
  await new Promise((r) => setTimeout(r, 30));
  const world = buildWorld(files, models);
  setAnisotropy(models.textures, renderer);

  const scene = new Scene();
  scene.add(world.group);
  const sky = new SkyDome(models.textures);
  const lighting = new Lighting(scene, sky);
  const zones = MIRROR_ZONES.flatMap((z) => {
    const s = world.sights.find((x) => x.id === z.id);
    return s ? [{ x: s.x, z: s.z, inner: z.inner, outer: z.outer }] : [];
  });
  const water = new Water(world.water, world.pond, models.textures.waterNormal, sky.envTexture, zones);
  const night = new NightLights(world.river, world.bridges, world.landmarks!, world.sights);
  scene.add(night.group);
  const vehicleMesh = new VehicleMesh();
  scene.add(vehicleMesh.group);

  const sim = createSim(route, world);
  const { st, rig, tour } = sim;
  for (const l of Object.values(LAYER)) rig.camera.layers.enable(l);
  const post = new Post(renderer, scene, rig.camera);

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
  const hud = new Hud(sim, renderer.info.render, () => [
    `light      night ${SHARED.uNight.value.toFixed(2)}  exposure ${lighting.post.exposure.toFixed(2)}  bloom ${lighting.post.bloomStrength.toFixed(2)} > ${lighting.post.bloomThreshold.toFixed(2)}`,
    `water      mirror ${water.active ? water.mirrorWeight(rig.camera.position).toFixed(2) : "off"}  pool ${night.describePool()}`,
    `night      ${night.counts.lamps} lamps, ${night.counts.bulbs} bulbs, ${night.counts.streaks} streaks; floodlit ${night.floodlit.length}`,
  ]);

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    rig.resize(window.innerWidth, window.innerHeight);
    post.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", resize);
  resize();
  compileAll(renderer, scene, rig.camera, post.target);

  // Debug hooks for the console. flyover.jump(n) cuts straight to the start of beat n.
  const jump = (n: number) => tour.jumpNow(st, n);
  // flyover.camera = someCamera renders from it instead of the rig (for overviews; enable the
  // LAYER layers on it to see the water, trees and labels); null restores.
  const debug: { camera: PerspectiveCamera | null } = { camera: null };
  const frame = (dt: number, draw = true) => {
    input.update(st);
    stepSim(sim, dt);
    const camera = debug.camera ?? rig.camera;
    lighting.update(st, renderer, rig.focus, camera.position, dt);
    world.landmarks?.update(camera.position);
    vehicleMesh.update(st, dt);
    const h = renderer.getDrawingBufferSize(tmpSize).y;
    night.update(st, camera, rig.focus, h, lighting.fog.density, water.mirrorWeight(camera.position), dt);
    hud.update(st, dt);
    if (!draw) return;
    // The HUD above showed the last frame's totals; count this one's from here.
    renderer.info.reset();
    camera.updateMatrixWorld();
    water.update(renderer, scene, camera, h * camera.aspect, h);
    post.setCamera(camera);
    post.setBloom(lighting.post.bloomStrength, lighting.post.bloomThreshold, lighting.post.bloomRadius);
    post.draw();
  };
  // flyover.step(seconds) advances the simulation at 30 Hz and renders once (works in hidden tabs).
  const step = (seconds: number) => {
    const n = Math.max(1, Math.round(seconds * 30));
    for (let i = 0; i < n; i++) frame(1 / 30, i === n - 1);
  };
  Object.assign(window, { flyover: Object.assign(debug, { st, sim, route, world, rig, scene, renderer, lighting, sky, water, night, post, jump, step }) });

  // Dev only: ?record=timelapse (or beat<n>) records the run instead of playing it (src/record.ts).
  const recordMode = import.meta.env.DEV ? new URLSearchParams(location.search).get("record") : null;
  if (recordMode) {
    const { record } = await import("./record");
    await record(recordMode, { step, jump, canvas, runLength: route.totalTime + LOOP.circle + LOOP.fadeOut });
    return;
  }

  loading.hidden = true;
  let last = performance.now();
  renderer.setAnimationLoop((now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    frame(dt);
  });
}

const tmpSize = new Vector2();

/**
 * Compile every program before the first frame, hidden objects included (the boat in flight,
 * the night lights by day), for the HDR target the scene renders into: a program first needed
 * at the first landing or at dusk would otherwise stall that frame.
 */
function compileAll(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, target: WebGLRenderTarget): void {
  const hidden: Object3D[] = [];
  scene.traverse((o) => {
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
  });
  renderer.setRenderTarget(target);
  renderer.compile(scene, camera);
  renderer.setRenderTarget(null);
  for (const o of hidden) o.visible = false;
}

main().catch((err) => {
  console.error(err);
  fatal(`Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
});
