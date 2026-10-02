// Dev only: records the autopilot run frame by frame through the dev server's /__capture
// endpoint (tools/capturePlugin.ts); `npm run record` then assembles the frames into an
// animated WebP. Open the app with
//   ?record=timelapse   the whole run and the loop in 30 s (one frame every ~1.9 s of tour)
//   ?record=beat<n>     30 s from the start of beat n in real time
// The simulation is stepped by hand, so the result doesn't depend on the frame rate.

interface Recorder {
  step: (seconds: number) => void;
  jump: (beat: number) => void;
  canvas: HTMLCanvasElement;
  /** Seconds the autopilot takes from the start of the route to the loop's cut. */
  runLength: number;
}

const FPS = 10;
const SECONDS = 30;
const WIDTH = 960;

export async function record(mode: string, r: Recorder): Promise<void> {
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
