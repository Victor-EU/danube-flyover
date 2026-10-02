// Quality tiers from public/data/quality.json: low, medium and high set the pixel-ratio cap,
// shadow map, planar reflections, bloom, MSAA, tree share, anisotropy and ambient life. The
// start tier depends on the device (touch or not); a frame-time probe during the opening
// hover then steps down while frames are slow. Nothing a tier changes recompiles a program:
// shadows switch off by intensity, not by castShadow, and the light count never changes.

import { QUALITY } from "./config";

export type TierName = "high" | "medium" | "low";
export type Tier = typeof QUALITY;

export interface QualityJson {
  start: { desktop: TierName; touch: TierName };
  probe: { warmup: number; seconds: number; slowMs: number; maxSteps: number };
  tiers: Record<TierName, Tier>;
}

const ORDER: TierName[] = ["high", "medium", "low"];

export class Quality {
  tier: TierName;
  /** "auto" while the probe may still step down; a fixed tier otherwise. */
  mode: "auto" | TierName;
  /** The probe's last median frame time (ms), for the debug panel. */
  probeMs = 0;
  private probeT = 0;
  private samples: number[] = [];
  private steps = 0;
  private probing: boolean;

  constructor(
    private readonly json: QualityJson,
    fixed: string | null,
    touch: boolean,
    private readonly apply: (t: Tier) => void,
  ) {
    const valid = ORDER.includes(fixed as TierName) ? (fixed as TierName) : null;
    this.mode = valid ?? "auto";
    this.tier = valid ?? (touch ? json.start.touch : json.start.desktop);
    this.probing = !valid;
    this.set(this.tier);
  }

  private set(t: TierName): void {
    this.tier = t;
    Object.assign(QUALITY, this.json.tiers[t]);
    this.apply(QUALITY);
  }

  /** From the settings menu: a fixed tier, or auto (probe again from the start tier). */
  choose(mode: "auto" | TierName, touch: boolean): void {
    this.mode = mode;
    this.steps = 0;
    this.restartProbe(mode === "auto");
    this.set(mode === "auto" ? (touch ? this.json.start.touch : this.json.start.desktop) : mode);
  }

  private restartProbe(on: boolean): void {
    this.probing = on;
    this.probeT = 0;
    this.samples = [];
  }

  /** Call once per displayed frame with the real interval since the last one (ms). */
  frame(ms: number): void {
    if (!this.probing) return;
    this.probeT += ms / 1000;
    const p = this.json.probe;
    if (this.probeT < p.warmup) return;
    this.samples.push(ms);
    if (this.probeT < p.warmup + p.seconds) return;
    const sorted = [...this.samples].sort((a, b) => a - b);
    this.probeMs = sorted[Math.floor(sorted.length / 2)];
    const next = ORDER[ORDER.indexOf(this.tier) + 1];
    if (this.probeMs > p.slowMs && next && this.steps < p.maxSteps) {
      this.steps++;
      this.set(next);
      this.restartProbe(true);
    } else this.probing = false;
  }

  describe(): string {
    return `${this.tier} (${this.mode}${this.probing ? ", probing" : this.probeMs ? `, probe ${this.probeMs.toFixed(1)} ms` : ""})`;
  }
}

export function isTouchDevice(): boolean {
  return matchMedia("(pointer: coarse)").matches;
}
