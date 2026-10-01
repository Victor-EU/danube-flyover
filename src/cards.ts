// Landmark card triggers. A card qualifies while the vehicle is inside the landmark's trigger
// radius and the landmark is within 40° of the camera's forward vector. One card shows at a
// time, for 8 s (an expanded card stays until it is closed); where several qualify, the one
// nearest the centre of the view wins, and the others can follow if they still qualify. A
// card shows once per pass: it re-arms only after the vehicle has left its radius. No DOM
// here (hud.ts draws the card), so tools/simulate.ts can log the cards a run shows.

import { type Camera, Vector3 } from "three";
import { CARDS } from "./config";
import type { State } from "./state";
import type { Sight } from "./world/landmarks";

const fwd = new Vector3();
const to = new Vector3();

export class Cards {
  /** Sights whose card has shown since the vehicle last entered their radius. */
  private readonly shown = new Set<string>();

  constructor(private readonly sights: Sight[]) {}

  /** After a cut (loop or jump): no card, everything re-armed. */
  reset(st: State): void {
    this.shown.clear();
    Object.assign(st.cards, { id: null, age: 0, expanded: false, gap: 0 });
  }

  update(st: State, camera: Camera, dt: number): void {
    const v = st.vehicle;
    const c = st.cards;
    for (const s of this.sights) if (Math.hypot(v.x - s.x, v.z - s.z) > s.radius) this.shown.delete(s.id);

    if (c.id) {
      if (!c.expanded) c.age += dt;
      if (c.age < CARDS.show || c.expanded) return;
      this.dismiss(st);
    }
    if (c.gap > 0) {
      c.gap -= dt;
      return;
    }
    const best = this.candidate(v.x, v.z, camera);
    if (best) {
      this.shown.add(best.id);
      Object.assign(c, { id: best.id, age: 0, expanded: false });
    }
  }

  /** Close the current card (time up, or the user closed it). */
  dismiss(st: State): void {
    Object.assign(st.cards, { id: null, age: 0, expanded: false, gap: CARDS.gap });
  }

  /** The qualifying landmark nearest the centre of the view, if any. */
  private candidate(x: number, z: number, camera: Camera): Sight | null {
    camera.getWorldDirection(fwd);
    const cos = Math.cos(CARDS.viewAngle);
    let best: Sight | null = null;
    let bestDot = cos;
    for (const s of this.sights) {
      if (this.shown.has(s.id) || Math.hypot(x - s.x, z - s.z) > s.radius) continue;
      const d = to.set(s.x, s.y, s.z).sub(camera.position).normalize().dot(fwd);
      if (d >= bestDot) {
        bestDot = d;
        best = s;
      }
    }
    return best;
  }

  sight(id: string): Sight | undefined {
    return this.sights.find((s) => s.id === id);
  }
}
