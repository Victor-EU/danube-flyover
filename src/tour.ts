// The loop and the beat jumps, both cuts through black. At the end of the route the autopilot
// circles the Market Hall; after LOOP.circle seconds of that the view fades to black, the
// tour resets to the Japanese Garden (and, in the sunset run, to 17:30) and plays again.
// Keys 1–9 and 0 jump to the start of beats 1–10 the same way, with a shorter fade.

import { placeAt, resetToStart } from "./autopilot";
import { JUMP, LOOP } from "./config";
import type { Route } from "./route";
import type { State } from "./state";

type Cut = { kind: "loop" } | { kind: "jump"; beat: number };

export class Tour {
  private pending: Cut | null = null;
  private fadeIn: number = LOOP.fadeIn;

  constructor(
    private readonly route: Route,
    /** Called after every cut, for the camera and the cards to start afresh. */
    private readonly onCut: (st: State) => void,
  ) {}

  /** Fade out, move to the start of beat `n`, fade in. */
  jump(n: number): void {
    if (!this.route.beats.some((b) => b.id === n) || this.pending?.kind === "loop") return;
    this.pending = { kind: "jump", beat: n };
  }

  /** The same without the fade (console and simulator). */
  jumpNow(st: State, n: number): void {
    const beat = this.route.beats.find((b) => b.id === n);
    if (!beat) return;
    this.cut(st, { kind: "jump", beat: n });
    st.ui.fade = 0;
  }

  update(st: State, dt: number): void {
    if (!this.pending && st.autopilot.phase === "end" && st.autopilot.endT >= LOOP.circle) this.pending = { kind: "loop" };
    if (this.pending) {
      const out = this.pending.kind === "loop" ? LOOP.fadeOut : JUMP.fadeOut;
      st.ui.fade = Math.min(1, st.ui.fade + dt / out);
      if (st.ui.fade >= 1) {
        this.fadeIn = this.pending.kind === "loop" ? LOOP.fadeIn : JUMP.fadeIn;
        this.cut(st, this.pending);
        this.pending = null;
      }
    } else if (st.ui.fade > 0) st.ui.fade = Math.max(0, st.ui.fade - dt / this.fadeIn);
  }

  private cut(st: State, cut: Cut): void {
    const beat = cut.kind === "jump" ? this.route.beats.find((b) => b.id === cut.beat) : undefined;
    if (!beat || beat.s === 0) resetToStart(st, this.route);
    else placeAt(st, this.route, beat.s);
    this.onCut(st);
  }
}
