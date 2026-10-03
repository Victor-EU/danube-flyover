// Danube Flyover: loads the world built by the tools/ pipeline and wires the modules into one
// frame loop.
// Order per frame: input → simulation (autopilot → controller → vehicle → camera → cards →
// tour) → lighting (sky, env map, shadows) → meshes, effects and night lights → water
// reflection → HUD → render (scene → bloom → tone mapping).

import "./style.css";
import {
  ACESFilmicToneMapping,
  type Mesh,
  type Object3D,
  PCFShadowMap,
  type PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  Vector2,
  WebGLRenderer,
  type WebGLRenderTarget,
} from "three";
import { type AudioJson, Sound } from "./audio";
import { LOOP } from "./config";
import { setPaused } from "./controller";
import { Effects, type LifeJson } from "./effects";
import { forwardOf } from "./geo";
import { Hud } from "./hud";
import { Input } from "./input";
import { Lighting } from "./lighting";
import { loadWorld } from "./load";
import { Post } from "./post";
import { isTouchDevice, Quality, type QualityJson } from "./quality";
import { Route, type RouteJson } from "./route";
import { createSim, stepSim } from "./sim";
import { SkyDome } from "./sky";
import { setAnisotropy, upgradeTextures } from "./textures";
import { VehicleMesh } from "./vehicleMesh";
import { SHARED } from "./world/night";
import { NightLights } from "./world/nightLights";
import { Far } from "./world/far";
import { Wake, type WakeBlock } from "./world/wake";
import { LAYER, Water } from "./world/water";
import { buildWorld } from "./world/world";

/** A message instead of the app; `still` shows a golden-hour render behind it (no WebGL2). */
function fatal(message: string, still = false): void {
  const el = document.getElementById("fatal")!;
  el.textContent = message;
  el.classList.toggle("still", still);
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
  const noWebGL2 = "Danube Flyover needs WebGL2, which this browser doesn't provide. This is the view it would open on: golden hour over Parliament.";
  if (!document.createElement("canvas").getContext("webgl2")) return fatal(noWebGL2, true);
  try {
    // No canvas MSAA: the scene renders into the composer's multisampled target instead.
    renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance" });
  } catch {
    return fatal(noWebGL2, true);
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  // The composer renders several passes a frame: count them all, reset once per frame.
  renderer.info.autoReset = false;

  const loading = document.getElementById("loading")!;
  const [res, qres, ares] = await Promise.all([fetch("data/route.json"), fetch("data/quality.json"), fetch("data/audio.json").catch(() => null)]);
  if (!res.ok) return fatal(`Couldn't load data/route.json (${res.status}).`);
  if (!qres.ok) return fatal(`Couldn't load data/quality.json (${qres.status}).`);
  const route = new Route((await res.json()) as RouteJson);
  const qualityJson = (await qres.json()) as QualityJson;
  // Without audio.json there's no music, and no music button.
  const audioJson = ((ares?.ok && (await ares.json().catch(() => null))) || { tracks: [] }) as AudioJson;
  const { files, models } = await loadWorld((f) => (loading.textContent = `Building Budapest… ${Math.round(f * 100)}%`));

  // Let the last progress paint before the synchronous world build (no rAF: it stalls in hidden tabs).
  await new Promise((r) => setTimeout(r, 30));
  const sky = new SkyDome(models.textures);
  const world = buildWorld(files, models, sky.envTexture);

  const scene = new Scene();
  scene.add(world.group);
  const lighting = new Lighting(scene, sky);
  const zones = MIRROR_ZONES.flatMap((z) => {
    const s = world.sights.find((x) => x.id === z.id);
    return s ? [{ x: s.x, z: s.z, inner: z.inner, outer: z.outer }] : [];
  });
  const effects = new Effects(world.river, files.life ?? { trams: [] }, sky.envTexture);
  scene.add(effects.group);
  // The wake's waves stay in the river's meshes, and break on the piers and the moored craft.
  const riverMeshes: Mesh[] = [];
  world.group.traverse((o) => (o as Mesh).isMesh && (o as Mesh).material === world.water && riverMeshes.push(o as Mesh));
  const wake = new Wake(renderer, world.river, riverMeshes, [...world.bridges.obstacles, ...mooredBlocks(files.life)]);
  const water = new Water(world.water, world.pond, models.textures.waterNormal, sky.envTexture, zones, wake.supported ? wake : null);
  if (water.patch) scene.add(water.patch);
  const night = new NightLights(world.river, world.bridges, world.landmarks!, world.sights, world.heroes!);
  scene.add(night.group);
  const vehicleMesh = new VehicleMesh(sky.envTexture);
  scene.add(vehicleMesh.group);

  const sim = createSim(route, world);
  const { st, rig, tour } = sim;
  for (const l of Object.values(LAYER)) rig.camera.layers.enable(l);
  const post = new Post(renderer, scene, rig.camera);

  // Music starts from a user gesture: the button or M, or (remembered as on) the first click or key.
  const sound = new Sound(audioJson.tracks);
  for (const type of ["pointerup", "keydown"]) window.addEventListener(type, () => sound.start(), { capture: true });

  // 1–9 and 0 jump to beats 1–10.
  const digits: Record<string, () => void> = {};
  for (let n = 1; n <= 10; n++) digits[`Digit${n % 10}`] = digits[`Numpad${n % 10}`] = () => tour.jump(n);
  const input = new Input(canvas, {
    ...digits,
    Space: () => setPaused(st, !st.paused),
    Escape: () => st.cards.id && sim.cards.dismiss(st),
    KeyT: () => (st.ui.sliderVisible = !st.ui.sliderVisible),
    Backquote: () => (st.ui.debug = !st.ui.debug),
    KeyM: () => sound.toggle(),
  });
  const hud = new Hud(sim, renderer.info.render, () => [
    `light      night ${SHARED.uNight.value.toFixed(2)}  exposure ${lighting.post.exposure.toFixed(2)}  bloom ${lighting.post.bloomStrength.toFixed(2)} > ${lighting.post.bloomThreshold.toFixed(2)}`,
    `water      mirror ${water.active ? water.mirrorWeight(rig.camera.position).toFixed(2) : "off"}  pool ${night.describePool()}`,
    `night      ${night.counts.lamps} lamps, ${night.counts.bulbs} bulbs, ${night.counts.streaks} streaks; floodlit ${night.floodlit.length}`,
    `effects    ${effects.describe()}`,
    `waves      ${wake.describe()}`,
    `far        ${far?.describe() ?? "loading"}`,
    `quality    ${quality.describe()}`,
    `textures   ${models.textures.status}`,
    `music      ${sound.describe()}`,
  ]);
  hud.bindSound(sound, audioJson.tracks);

  const resize = () => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    rig.resize(window.innerWidth, window.innerHeight);
    post.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", resize);

  const params = new URLSearchParams(location.search);
  // Quality: the tier from ?quality=, or the device's start tier and then the frame probe.
  const touch = isTouchDevice();
  document.documentElement.classList.toggle("touch", touch);
  const quality = new Quality(qualityJson, params.get("quality"), touch, (t) => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, t.pixelRatio));
    resize();
    post.setSamples(t.samples);
    lighting.setShadows(t.shadowMapSize);
    world.trees?.setShare(t.trees);
    world.traffic?.setShare(t.cars);
    setAnisotropy(models.textures, renderer, t.anisotropy);
    effects.setLife(t.life);
  });
  const qualitySelect = document.getElementById("quality") as HTMLSelectElement;
  qualitySelect.value = quality.mode;
  qualitySelect.addEventListener("change", () => quality.choose(qualitySelect.value as "auto", touch));
  compileAll(renderer, scene, rig.camera, post.target);
  wake.prime(renderer);

  // Debug hooks for the console. flyover.jump(n) cuts straight to the start of beat n.
  const jump = (n: number) => tour.jumpNow(st, n);
  // flyover.camera = someCamera renders from it instead of the rig (for overviews; enable the
  // LAYER layers on it to see the water, trees, labels and terrain); null restores.
  const debug: { camera: PerspectiveCamera | null } = { camera: null };
  // ?textures=webp keeps the half-size WebP set, to compare.
  let upgrade: Promise<boolean> | null = params.get("textures") === "webp" ? Promise.resolve(false) : null;
  // The far field streams in after the first frame too, then takes over from the apron and frame.
  let far: Far | null = null;
  let farLoad: Promise<void> | null = params.get("far") === "off" ? Promise.resolve() : null;
  const loadFar = () =>
    Far.load(renderer, world.bounds, world.water, async (file) => {
      const res = await fetch(`data/${file}`);
      if (!res.ok) throw new Error(`Couldn't load data/${file} (${res.status}).`);
      return res.arrayBuffer();
    })
      .then(async (f) => {
        await f.compile(renderer, rig.camera, scene);
        scene.add(f.group);
        for (const name of ["apron", "frame"]) world.group.getObjectByName(name)?.removeFromParent();
        far = f;
      })
      .catch((err) => console.warn("far field:", err));
  const frame = (dt: number, draw = true) => {
    input.update(st);
    stepSim(sim, dt);
    const camera = debug.camera ?? rig.camera;
    lighting.update(st, renderer, rig.focus, camera.position, dt);
    world.landmarks?.update(camera.position);
    world.update(camera, dt);
    far?.update(camera, renderer.getDrawingBufferSize(tmpSize).y);
    vehicleMesh.update(st, dt, wake.motion);
    effects.update(st, dt, Math.min(1, lighting.hemi.intensity * 1.3 + lighting.sun.intensity * 0.2), wake);
    for (const s of effects.takeSplashes()) wake.splash(s);
    const v = st.vehicle;
    wake.update(renderer, dt, camera.position, { x: v.x, z: v.z, heading: v.heading, onWater: v.boatness > 0.5 && v.y < 0.6 }, effects.hulls(st));
    const h = renderer.getDrawingBufferSize(tmpSize).y;
    night.update(st, camera, rig.focus, h, lighting.fog.density, water.mirrorWeight(camera.position), dt);
    hud.update(st, dt);
    sound.update(SHARED.uNight.value);
    if (!draw) return;
    // The HUD above showed the last frame's totals; count this one's from here.
    renderer.info.reset();
    camera.updateMatrixWorld();
    water.update(renderer, scene, camera, h * camera.aspect, h);
    post.setCamera(camera);
    post.setBloom(lighting.post.bloomStrength, lighting.post.bloomThreshold, lighting.post.bloomRadius);
    post.draw();
    // The full-size textures stream in once the first frame is drawn, with the WebP set.
    upgrade ??= upgradeTextures(models.textures, renderer);
    farLoad ??= loadFar();
  };
  // flyover.step(seconds) advances the simulation at 30 Hz and renders once (works in hidden tabs).
  const step = (seconds: number) => {
    const n = Math.max(1, Math.round(seconds * 30));
    for (let i = 0; i < n; i++) frame(1 / 30, i === n - 1);
  };
  Object.assign(window, { flyover: Object.assign(debug, { st, sim, route, world, textures: models.textures, rig, scene, renderer, lighting, sky, water, wake, night, post, effects, quality, sound, jump, step, far: () => far }) });

  // Dev only: ?record=timelapse (or beat<n>) records the run instead of playing it (src/record.ts).
  const recordMode = import.meta.env.DEV ? params.get("record") : null;
  if (recordMode) {
    const { record } = await import("./record");
    const view = (camera: PerspectiveCamera | null) => {
      debug.camera = camera;
      vehicleMesh.group.visible = !camera;
    };
    // Recordings use the full-size textures from the start.
    await (upgrade ??= upgradeTextures(models.textures, renderer));
    await (farLoad ??= loadFar());
    await record(recordMode, { step, jump, canvas, runLength: route.totalTime + LOOP.circle + LOOP.fadeOut, st, sights: world.sights, view });
    return;
  }

  loading.hidden = true;
  let last = performance.now();
  renderer.setAnimationLoop((now: number) => {
    quality.frame(now - last);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    frame(dt);
  });
}

const tmpSize = new Vector2();

/** The moored ships (11.4 m in the beam) and pontoons (6 m) as boxes the waves break on. */
function mooredBlocks(life: LifeJson | undefined): WakeBlock[] {
  const out: WakeBlock[] = [];
  const add = (list: number[] | undefined, beam: number) => {
    for (let k = 0; list && k + 3 < list.length; k += 4) {
      const f = forwardOf(list[k + 2]);
      out.push({ cx: list[k], cz: list[k + 1], ux: f.x, uz: f.z, halfAlong: list[k + 3] / 2, halfAcross: beam / 2 });
    }
  };
  add(life?.ships, 11.4);
  add(life?.pontoons, 6);
  return out;
}

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
