// Keyboard, mouse drag and touch drag, normalised into steer / throttle / climb in [-1, 1].
// W/S speed, A/D steer, Q/E altitude (Q descends). Arrow keys mirror W/A/S/D. One-shot keys
// (Space, digits, T, Esc, `) go to the hotkey table; Space is always pause, never a button press.

import type { State } from "./state";

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
const DRAG_RANGE = 140; // pixels for full deflection

export class Input {
  private readonly keys = new Set<string>();
  private drag: { id: number; x0: number; y0: number; dx: number; dy: number } | null = null;

  constructor(target: HTMLElement, hotkeys: Record<string, () => void>) {
    window.addEventListener("keydown", (e) => {
      if (document.querySelector("dialog[open]")) return; // the About overlay has the keyboard
      const inField = e.target instanceof HTMLInputElement;
      if (inField && e.code.startsWith("Arrow")) return; // let the slider have its arrows
      if (e.metaKey || e.ctrlKey || e.altKey) return; // browser shortcuts
      if (hotkeys[e.code]) {
        e.preventDefault();
        if (!e.repeat) hotkeys[e.code]();
        return;
      }
      if (GAME_KEYS.has(e.code)) {
        this.keys.add(e.code);
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
      // A focused button would otherwise click on Space's keyup.
      if (e.code === "Space" && !document.querySelector("dialog[open]")) e.preventDefault();
    });
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.drag = null;
    });

    target.addEventListener("pointerdown", (e) => {
      if (this.drag) return;
      target.setPointerCapture(e.pointerId);
      this.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0 };
    });
    target.addEventListener("pointermove", (e) => {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      this.drag.dx = e.clientX - this.drag.x0;
      this.drag.dy = e.clientY - this.drag.y0;
    });
    const end = (e: PointerEvent) => {
      if (this.drag && e.pointerId === this.drag.id) this.drag = null;
    };
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  }

  update(st: State): void {
    const k = (...codes: string[]) => (codes.some((c) => this.keys.has(c)) ? 1 : 0);
    let steer = k("KeyD", "ArrowRight") - k("KeyA", "ArrowLeft");
    const throttle = k("KeyW", "ArrowUp") - k("KeyS", "ArrowDown");
    let climb = k("KeyE") - k("KeyQ");
    // A small dead zone so a click is not a steer.
    if (this.drag && Math.hypot(this.drag.dx, this.drag.dy) > 6) {
      steer += this.drag.dx / DRAG_RANGE;
      climb += -this.drag.dy / DRAG_RANGE;
    }
    st.input.steer = clamp1(steer);
    st.input.throttle = clamp1(throttle);
    st.input.climb = clamp1(climb);
    st.input.active = st.input.steer !== 0 || st.input.throttle !== 0 || st.input.climb !== 0;
    if (st.input.active) st.input.everUsed = true;
  }
}

const GAME_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);
