// Dev only: records frames through the dev server's /__capture endpoint
// (tools/capturePlugin.ts). Open the app with
//   ?record=timelapse   the whole run and the loop in 30 s (one frame every ~1.9 s of tour);
//                       `npm run record` then assembles an animated WebP
//   ?record=beat<n>     30 s from the start of beat n in real time
//   ?record=cards       one still per landmark for its card (`npm run cards` finishes them)
// The simulation is stepped by hand, so the result doesn't depend on the frame rate.

import { PerspectiveCamera } from "three";
import { CARD_VIEWS as VIEWS } from "./cardViews";
import type { State } from "./state";
import type { Sight } from "./world/landmarks";
import { LAYER } from "./world/water";

interface Recorder {
  step: (seconds: number) => void;
  jump: (beat: number) => void;
  canvas: HTMLCanvasElement;
  /** Seconds the autopilot takes from the start of the route to the loop's cut. */
  runLength: number;
  st: State;
  sights: Sight[];
  /** Render from this camera instead of the rig (null restores), with the vehicle hidden. */
  view: (camera: PerspectiveCamera | null) => void;
}

const FPS = 10;
const SECONDS = 30;
const WIDTH = 960;

export async function record(mode: string, r: Recorder): Promise<void> {
  if (mode === "cards") return cards(r);
  const frames = FPS * SECONDS;
  const beat = /^beat(\d+)$/.exec(mode);
  const perFrame = beat ? 1 / FPS : r.runLength / frames;
  r.jump(beat ? Number(beat[1]) : 1);
  const status = document.getElementById("loading")!;
  status.hidden = false;
  const small = document.createElement("canvas");
  small.width = WIDTH;
  small.height = Math.round((WIDTH * r.canvas.height) / r.canvas.width);
  const ctx = small.getContext("2d")!;
  for (let i = 0; i < frames; i++) {
    r.step(perFrame);
    // Read the canvas in the same task as the render, before the browser clears it.
    ctx.drawImage(r.canvas, 0, 0, small.width, small.height);
    const blob = await new Promise<Blob>((res) => small.toBlob((b) => res(b!), "image/jpeg", 0.86));
    await fetch(`/__capture?name=${mode}_${String(i).padStart(4, "0")}.jpg`, { method: "POST", body: blob });
    status.textContent = `Recording ${mode}: frame ${i + 1} of ${frames}`;
  }
  status.textContent = `Recorded ${frames} frames: npm run record -- ${mode}`;
}

async function cards(r: Recorder): Promise<void> {
  const status = document.getElementById("loading")!;
  status.hidden = false;
  const cam = new PerspectiveCamera(50, 16 / 10, 0.5, 20000);
  cam.layers.enable(LAYER.water);
  cam.layers.enable(LAYER.trees);
  const out = document.createElement("canvas");
  out.width = 960;
  out.height = 600;
  const ctx = out.getContext("2d")!;
  r.st.sunsetRun.enabled = false;
  r.st.paused = true;
  for (const s of r.sights) {
    const v = VIEWS[s.id];
    if (!v) continue;
    const [az, dist, h, time, fov] = v;
    const a = (az * Math.PI) / 180;
    cam.position.set(s.x + Math.sin(a) * dist, Math.max(2, s.y + h), s.z - Math.cos(a) * dist);
    cam.fov = fov;
    cam.aspect = r.canvas.width / r.canvas.height;
    cam.updateProjectionMatrix();
    cam.lookAt(s.x, s.y, s.z);
    r.view(cam);
    r.st.timeOfDay = time;
    // A few steps, so the sky, the shadows and the night ramp settle.
    for (let k = 0; k < 4; k++) r.step(0.5);
    // Crop the middle 16:10 of the canvas.
    const sw = Math.min(r.canvas.width, (r.canvas.height * 16) / 10);
    const sh = (sw * 10) / 16;
    ctx.drawImage(r.canvas, (r.canvas.width - sw) / 2, (r.canvas.height - sh) / 2, sw, sh, 0, 0, out.width, out.height);
    const blob = await new Promise<Blob>((res) => out.toBlob((b) => res(b!), "image/png"));
    await fetch(`/__capture?name=card_${s.id}.png`, { method: "POST", body: blob });
    status.textContent = `Card ${s.id}`;
  }
  r.view(null);
  status.textContent = `Recorded ${Object.keys(VIEWS).length} card stills: npm run cards`;
}
