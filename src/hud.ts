// The thin bottom bar (play/pause, music, mode and pilot badges, time slider, sunset-run toggle,
// the OSM credit that opens the About overlay), the landmark card, the fade to black, the
// fading "take control" hint, and a debug panel toggled with the ` key.

import type { Sound, TrackJson } from "./audio";
import { CARDS } from "./config";
import { setPaused } from "./controller";
import type { Sim } from "./sim";
import type { State } from "./state";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function formatClock(h: number): string {
  const m = Math.round(h * 60) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const MODE_LABEL = { GLIDER: "Glider", LANDING: "Glider", BOAT: "Boat", TAKEOFF: "Boat" } as const;

export class Hud {
  private readonly slider = $<HTMLInputElement>("slider");
  private readonly clock = $<HTMLSpanElement>("clock");
  private readonly sunset = $<HTMLInputElement>("sunset");
  private readonly play = $<HTMLButtonElement>("play");
  private readonly mode = $<HTMLSpanElement>("mode");
  private readonly pilot = $<HTMLSpanElement>("pilot");
  private readonly hint = $<HTMLDivElement>("hint");
  private readonly debug = $<HTMLPreElement>("debug");
  private readonly time = $<HTMLLabelElement>("time");
  private readonly fade = $<HTMLDivElement>("fade");
  private readonly card = $<HTMLElement>("card");
  private readonly cardOpen = $<HTMLButtonElement>("card-open");
  private readonly cardMore = $<HTMLDivElement>("card-more");
  private readonly cardTimer = $<HTMLDivElement>("card-timer");
  private cardId: string | null = null;
  private cardExpanded = false;
  private paused: boolean | null = null;
  private frames = 0;
  private fpsT = 0;
  private fps = 0;

  constructor(
    private readonly sim: Sim,
    /** The renderer's per-frame counters (renderer.info.render). */
    private readonly renderInfo: { calls: number; triangles: number },
    /** More debug lines from the render side (lighting, water, night lights). */
    private readonly extra: () => string[] = () => [],
  ) {
    const st = sim.st;
    this.slider.value = String(st.timeOfDay);
    this.sunset.checked = st.sunsetRun.enabled;
    this.slider.addEventListener("input", () => {
      st.timeOfDay = Number(this.slider.value);
      // Dragging the slider pauses the sunset run's clock for 10 s.
      st.sunsetRun.pausedUntil = st.t + 10;
    });
    this.sunset.addEventListener("change", () => (st.sunsetRun.enabled = this.sunset.checked));
    this.play.addEventListener("click", () => setPaused(st, !st.paused));
    const about = $<HTMLDialogElement>("about");
    $<HTMLButtonElement>("credit").addEventListener("click", () => about.showModal());
    // Clicking the card opens it to the illustration and paragraph; an open card stays until closed.
    this.cardOpen.addEventListener("click", () => {
      if (st.cards.id) st.cards.expanded = !st.cards.expanded;
    });
    $<HTMLButtonElement>("card-close").addEventListener("click", () => sim.cards.dismiss(st));
    // The hint sits just above the bar, however many lines the bar wraps to.
    const bar = $<HTMLDivElement>("bar");
    new ResizeObserver(() => document.documentElement.style.setProperty("--bar-h", `${bar.offsetHeight}px`)).observe(bar);
  }

  /** The music button, the About overlay's volume slider, and its music credits. */
  bindSound(sound: Sound, tracks: TrackJson[]): void {
    const button = $<HTMLButtonElement>("sound");
    // Without tracks (no audio.json) there's nothing to turn on.
    button.hidden = !tracks.length;
    const show = (on: boolean) => {
      button.setAttribute("aria-pressed", String(on));
      button.title = on ? "Music off (M)" : "Music on (M)";
    };
    show(sound.on);
    sound.onChange = show;
    button.addEventListener("click", () => sound.toggle());
    const range = $<HTMLInputElement>("volume");
    range.value = String(sound.prefs.volume);
    range.addEventListener("input", () => sound.setVolume(Number(range.value)));
    const credits = $<HTMLUListElement>("music-credits");
    for (const t of tracks) {
      const li = document.createElement("li");
      const link = (text: string, href: string) => {
        const a = document.createElement("a");
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = text;
        return a;
      };
      li.append("“", link(t.title, t.source), `” by ${t.artist}, licensed under `, link(t.licence, t.licenceUrl), ".");
      credits.append(li);
    }
    // CC BY asks for changes to be indicated.
    const note = document.createElement("li");
    note.textContent = tracks.length ? "The tracks are trimmed, levelled and re-encoded for the web." : "No music in this build.";
    credits.append(note);
  }

  update(st: State, dt: number): void {
    if (document.activeElement !== this.slider) this.slider.value = String(st.timeOfDay);
    this.clock.textContent = formatClock(st.timeOfDay);
    this.time.hidden = !st.ui.sliderVisible;
    this.fade.style.opacity = String(st.ui.fade);

    const v = st.vehicle;
    // The badge switches halfway through a transition (1.0 s into landing, 1.25 s into take-off).
    let label: string = MODE_LABEL[v.mode];
    if (v.mode === "LANDING" && v.transitionT >= 1.0) label = "Boat";
    if (v.mode === "TAKEOFF" && v.transitionT >= 1.25) label = "Glider";
    this.mode.textContent = label;
    this.mode.dataset.mode = label.toLowerCase();
    const w = st.control.w;
    this.pilot.textContent = st.paused ? "Paused" : w >= 0.99 ? "You" : w <= 0.01 ? "Autopilot" : w > 0.5 ? "You…" : "Autopilot…";
    this.pilot.dataset.manual = String(w > 0.5);
    this.pilot.dataset.paused = String(st.paused);
    if (st.paused !== this.paused) {
      this.paused = st.paused;
      this.play.dataset.paused = String(st.paused);
      this.play.setAttribute("aria-label", st.paused ? "Resume the tour" : "Pause the tour");
      this.play.title = st.paused ? "Resume (Space)" : "Pause (Space)";
    }
    this.hint.classList.toggle("gone", st.input.everUsed);
    this.updateCard(st);

    this.frames++;
    this.fpsT += dt;
    if (this.fpsT >= 0.5) {
      this.fps = Math.round(this.frames / this.fpsT);
      this.frames = 0;
      this.fpsT = 0;
    }
    this.debug.hidden = !st.ui.debug;
    if (st.ui.debug) this.debug.textContent = this.debugText(st);
  }

  private updateCard(st: State): void {
    const c = st.cards;
    if (c.id !== this.cardId) {
      this.cardId = c.id;
      const sight = c.id ? this.sim.cards.sight(c.id) : undefined;
      // Leaving: keep the old text while it slides out.
      if (sight) {
        $("card-name").textContent = sight.name;
        $("card-note").textContent = sight.note;
        $("card-text").textContent = sight.text;
        // The illustration (tools/cards.ts) loads when the card comes in, ready for opening.
        const art = $<HTMLImageElement>("card-art");
        art.hidden = !sight.illustration;
        if (sight.illustration) {
          art.src = `data/${sight.illustration}`;
          art.alt = `${sight.name}, as the flyover shows it`;
        }
      }
      this.card.classList.toggle("in", !!sight);
      this.cardExpanded = !c.expanded; // force the expanded state to refresh below
    }
    if (c.expanded !== this.cardExpanded) {
      this.cardExpanded = c.expanded;
      this.card.classList.toggle("expanded", c.expanded);
      this.cardMore.hidden = !c.expanded;
      this.cardOpen.setAttribute("aria-expanded", String(c.expanded));
    }
    if (c.id) this.cardTimer.style.transform = `scaleX(${Math.max(0, 1 - c.age / CARDS.show)})`;
  }

  private debugText(st: State): string {
    const v = st.vehicle;
    const ap = st.autopilot;
    const r = this.sim.route;
    const cam = st.camera;
    const world = this.sim.world;
    return [
      `fps        ${this.fps}`,
      `mode       ${v.mode}${v.mode === "LANDING" || v.mode === "TAKEOFF" ? ` ${v.transitionT.toFixed(2)} s` : ""}${st.paused ? "  (paused)" : ""}`,
      `control w  ${st.control.w.toFixed(2)}  (idle ${st.control.idleFor.toFixed(1)} s)`,
      `speed      ${v.speed.toFixed(1)} m/s`,
      `altitude   ${v.y.toFixed(1)} m   floor ${world.floor.gliderMin(v.x, v.z).toFixed(1)} m`,
      `lateral    ${v.lateral.toFixed(0)} m from route`,
      `route      ${(ap.s / 1000).toFixed(2)} / ${(r.length / 1000).toFixed(2)} km  (${ap.routeMode})${ap.phase === "end" ? `  end circle ${ap.endT.toFixed(1)} s` : ""}`,
      `beat       ${ap.beat}`,
      `route time ${formatMinutes(ap.routeTime)} / ${formatMinutes(r.totalTime)}`,
      `camera     ${cam.mode}${cam.target ? ` → ${cam.target}` : ""}  key ${cam.key}${cam.blend < 1 ? `  blend ${cam.blend.toFixed(2)}` : ""}${cam.suspended ? "  (suspended)" : ""}`,
      `card       ${st.cards.id ? `${st.cards.id} ${st.cards.age.toFixed(1)} s${st.cards.expanded ? " (open)" : ""}` : "-"}`,
      `sun        ${st.sun.elevation.toFixed(1)}°  az ${st.sun.azimuth.toFixed(0)}°`,
      ...this.extra(),
      `draw       ${this.renderInfo.calls} calls, ${(this.renderInfo.triangles / 1e6).toFixed(2)} M triangles (all passes)`,
      `build ms   ${Object.entries(world.timings).map(([k, ms]) => `${k} ${ms}`).join(", ")}`,
    ].join("\n");
  }
}

function formatMinutes(t: number): string {
  const r = Math.round(t);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
}
