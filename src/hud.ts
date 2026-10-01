// The thin bottom bar (time slider, mode and pilot badges, sunset-run toggle, the OSM credit
// that opens the About overlay), the fading "take control" hint, and a debug panel toggled
// with the ` key.

import type { Route } from "./route";
import type { State } from "./state";
import type { World } from "./world/world";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function formatClock(h: number): string {
  const m = Math.round(h * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const MODE_LABEL = { BIRD: "Bird", LANDING: "Bird", BOAT: "Boat", TAKEOFF: "Boat" } as const;

export class Hud {
  private readonly slider = $<HTMLInputElement>("slider");
  private readonly clock = $<HTMLSpanElement>("clock");
  private readonly sunset = $<HTMLInputElement>("sunset");
  private readonly mode = $<HTMLSpanElement>("mode");
  private readonly pilot = $<HTMLSpanElement>("pilot");
  private readonly hint = $<HTMLDivElement>("hint");
  private readonly debug = $<HTMLPreElement>("debug");
  private readonly time = $<HTMLLabelElement>("time");
  private frames = 0;
  private fpsT = 0;
  private fps = 0;

  constructor(
    st: State,
    private readonly route: Route,
    private readonly world: World,
    /** The renderer's per-frame counters (renderer.info.render). */
    private readonly renderInfo: { calls: number; triangles: number },
  ) {
    this.slider.value = String(st.timeOfDay);
    this.sunset.checked = st.sunsetRun.enabled;
    this.slider.addEventListener("input", () => {
      st.timeOfDay = Number(this.slider.value);
      // Dragging the slider pauses the sunset run's clock for 10 s.
      st.sunsetRun.pausedUntil = st.t + 10;
    });
    this.sunset.addEventListener("change", () => (st.sunsetRun.enabled = this.sunset.checked));
    const about = $<HTMLDialogElement>("about");
    $<HTMLButtonElement>("credit").addEventListener("click", () => about.showModal());
  }

  update(st: State, dt: number): void {
    if (document.activeElement !== this.slider) this.slider.value = String(st.timeOfDay);
    this.clock.textContent = formatClock(st.timeOfDay);
    this.time.hidden = !st.ui.sliderVisible;

    const v = st.vehicle;
    // The badge switches halfway through a transition (1.0 s into landing, 1.25 s into take-off).
    let label: string = MODE_LABEL[v.mode];
    if (v.mode === "LANDING" && v.transitionT >= 1.0) label = "Boat";
    if (v.mode === "TAKEOFF" && v.transitionT >= 1.25) label = "Bird";
    this.mode.textContent = label;
    this.mode.dataset.mode = label.toLowerCase();
    const w = st.control.w;
    this.pilot.textContent = w >= 0.99 ? "You" : w <= 0.01 ? "Autopilot" : w > 0.5 ? "You…" : "Autopilot…";
    this.pilot.dataset.manual = String(w > 0.5);
    this.hint.classList.toggle("gone", st.input.everUsed);

    this.frames++;
    this.fpsT += dt;
    if (this.fpsT >= 0.5) {
      this.fps = Math.round(this.frames / this.fpsT);
      this.frames = 0;
      this.fpsT = 0;
    }
    this.debug.hidden = !st.ui.debug;
    if (st.ui.debug) {
      const ap = st.autopilot;
      const r = this.route;
      this.debug.textContent = [
        `fps        ${this.fps}`,
        `mode       ${v.mode}${v.mode === "LANDING" || v.mode === "TAKEOFF" ? ` ${v.transitionT.toFixed(2)} s` : ""}`,
        `control w  ${w.toFixed(2)}  (idle ${st.control.idleFor.toFixed(1)} s)`,
        `speed      ${v.speed.toFixed(1)} m/s`,
        `altitude   ${v.y.toFixed(1)} m   floor ${this.world.floor.birdMin(v.x, v.z).toFixed(1)} m`,
        `lateral    ${v.lateral.toFixed(0)} m from route`,
        `route      ${(ap.s / 1000).toFixed(2)} / ${(r.length / 1000).toFixed(2)} km  (${ap.routeMode})`,
        `beat       ${ap.beat}`,
        `route time ${formatMinutes(ap.routeTime)} / ${formatMinutes(r.totalTime)}`,
        `sun        ${st.sun.elevation.toFixed(1)}°  az ${st.sun.azimuth.toFixed(0)}°`,
        `draw       ${this.renderInfo.calls} calls, ${(this.renderInfo.triangles / 1e6).toFixed(2)} M triangles (all passes)`,
        `build ms   ${Object.entries(this.world.timings).map(([k, ms]) => `${k} ${ms}`).join(", ")}`,
      ].join("\n");
    }
  }
}

function formatMinutes(t: number): string {
  const r = Math.round(t);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
}
