// The music, off until the user turns it on: browsers block audio until the page has been
// interacted with, and the tour runs without any input. Nothing is created or fetched before then.
//
// The tracks stream from public/data/audio/ (audio.json lists each with its licence and credit)
// through two media elements that crossfade from one track into the next. Each next track is
// chosen by the light, so the day tracks play until dusk and the night tracks after. The
// volume is a Web Audio gain rather than the elements' own, which iOS ignores.

export interface TrackJson {
  /** Under data/audio/. */
  file: string;
  title: string;
  artist: string;
  licence: string;
  licenceUrl: string;
  /** The page the track comes from. */
  source: string;
  light: "day" | "night";
  /** Linear gain that brings the track to the loudness target (tools/audio.ts measures it). */
  gain: number;
  /** Length after trimming (tools/audio.ts). */
  seconds: number;
}

export interface AudioJson {
  tracks: TrackJson[];
}

export interface SoundPrefs {
  on: boolean;
  volume: number;
}

const PREFS_KEY = "flyover.sound";
const DEFAULT_PREFS: SoundPrefs = { on: false, volume: 0.8 };

/** Seconds: the fade on toggling, the crossfade between tracks, the first track's fade-in. */
const FADE = { toggle: 0.35, crossfade: 6, start: 2.5 };

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function loadPrefs(): SoundPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<SoundPrefs>;
    return {
      on: typeof p.on === "boolean" ? p.on : DEFAULT_PREFS.on,
      volume: typeof p.volume === "number" ? clamp01(p.volume) : DEFAULT_PREFS.volume,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(p: SoundPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Private windows and blocked storage: the setting just isn't remembered.
  }
}

export class Sound {
  readonly prefs = loadPrefs();
  private ctx: AudioContext | null = null;
  /** The toggle's fade, the volume, and a safety limiter, in that order. */
  private master: GainNode | null = null;
  private volume: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private playlist: Playlist | null = null;
  private hidden = document.hidden;
  private offTimer = 0;
  /** The light (0 day, 1 night) at the last frame, for choosing a track. */
  private night = 0;
  /** Between resume() and the next stop() or suspend(). */
  private live = false;
  /** Called when on/off changes, for the bar button. */
  onChange: (on: boolean) => void = () => {};

  constructor(private readonly tracks: TrackJson[]) {
    document.addEventListener("visibilitychange", () => {
      this.hidden = document.hidden;
      // The tour stops in a hidden tab, so the music pauses with it.
      if (this.prefs.on) this.hidden ? this.suspend() : this.resume();
    });
  }

  get on(): boolean {
    return this.prefs.on;
  }

  /** True when audio is running (on, and started from a user gesture). */
  get running(): boolean {
    return this.ctx?.state === "running";
  }

  /** Call from a user gesture (a click or key press): browsers only start audio inside one. */
  toggle(): void {
    this.set(!this.prefs.on);
  }

  set(on: boolean): void {
    this.prefs.on = on;
    savePrefs(this.prefs);
    if (on) this.start();
    else this.stop();
    this.onChange(on);
  }

  /** From a user gesture: starts the music if it's on (remembered from an earlier visit). */
  start(): void {
    if (!this.prefs.on || this.hidden || !this.tracks.length || (this.live && this.running)) return;
    window.clearTimeout(this.offTimer);
    if (!this.ctx) {
      const ctx = (this.ctx = new AudioContext({ latencyHint: "playback" }));
      this.master = ctx.createGain();
      this.master.gain.value = 0;
      this.volume = ctx.createGain();
      // A safety limiter only: the tracks are levelled offline with their peaks at -1 dB.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 3;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.005;
      limiter.release.value = 0.2;
      this.analyser = ctx.createAnalyser();
      this.master.connect(this.volume).connect(limiter).connect(ctx.destination);
      limiter.connect(this.analyser);
      this.playlist = new Playlist(ctx, this.master, this.tracks);
      this.setVolume(this.prefs.volume);
    }
    this.playlist!.unlock(this.night);
    this.resume();
  }

  setVolume(value: number): void {
    this.prefs.volume = clamp01(value);
    savePrefs(this.prefs);
    // The slider is perceptual: squared to a gain.
    if (this.ctx && this.volume) this.volume.gain.setTargetAtTime(this.prefs.volume ** 2, this.ctx.currentTime, 0.05);
  }

  private stop(): void {
    this.live = false;
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, FADE.toggle / 4);
    window.clearTimeout(this.offTimer);
    this.offTimer = window.setTimeout(() => this.suspend(), FADE.toggle * 1000 + 50);
  }

  private suspend(): void {
    this.live = false;
    this.playlist?.pause();
    void this.ctx?.suspend();
  }

  private resume(): void {
    if (!this.ctx || !this.master) return;
    this.live = true;
    const now = this.ctx.currentTime;
    void this.ctx.resume();
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(1, now, FADE.toggle / 4);
    this.playlist?.resume();
  }

  /** Per frame: near the end of a track, crossfades into the next one for the light. */
  update(night: number): void {
    this.night = night;
    if (this.live && this.running) this.playlist!.update(night);
  }

  describe(): string {
    if (!this.tracks.length) return "no music";
    if (!this.ctx) return this.prefs.on ? "on, waiting for a click or key" : "off";
    const l = this.levels();
    const db = (x: number) => (x > 1e-6 ? `${(20 * Math.log10(x)).toFixed(0)}` : "-∞");
    return `${this.prefs.on ? "on" : "off"} (${this.ctx.state})  rms ${db(l.rms)} dB, peak ${db(l.peak)} dB  ${this.playlist!.describe()}`;
  }

  /** Debug: the output's RMS and peak over the last ~40 ms, linear. */
  levels(): { rms: number; peak: number } {
    if (!this.analyser) return { rms: 0, peak: 0 };
    const scope = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(scope);
    let sum = 0;
    let peak = 0;
    for (const x of scope) {
      sum += x * x;
      peak = Math.max(peak, Math.abs(x));
    }
    return { rms: Math.sqrt(sum / scope.length), peak };
  }
}

/**
 * Two media elements (streamed, not decoded into memory), crossfading from one track into
 * the next. Nothing is fetched until the first `unlock()`.
 */
class Playlist {
  private readonly els: HTMLAudioElement[] = [];
  private readonly gains: GainNode[] = [];
  /** The element playing now and the track on it. */
  private cur = 0;
  private track = -1;
  /** The last track played for each light. */
  private readonly last = { day: -1, night: -1 };
  private crossfading = false;
  private unlocked = false;
  private night = 0;

  constructor(
    private readonly ctx: AudioContext,
    out: GainNode,
    private readonly tracks: TrackJson[],
  ) {
    for (let i = 0; i < 2; i++) {
      const el = new Audio();
      el.preload = "auto";
      // A track too short to crossfade out of ends instead.
      el.addEventListener("ended", () => i === this.cur && this.next(this.night));
      const g = ctx.createGain();
      g.gain.value = 0;
      ctx.createMediaElementSource(el).connect(g).connect(out);
      this.els.push(el);
      this.gains.push(g);
    }
  }

  /** In the user gesture: start the first track, and prime the other element (iOS asks per element). */
  unlock(night: number): void {
    if (this.unlocked) return;
    this.unlocked = true;
    this.next(night, FADE.start);
    const other = this.els[1 - this.cur];
    other.src = silenceUrl();
    other.play().then(() => other.pause(), () => {});
  }

  /** Crossfade into the next track: the light's tracks take turns, in audio.json's order. */
  private next(night: number, fadeIn = FADE.crossfade): void {
    const pick = nextTrack(this.tracks, night > 0.5 ? "night" : "day", this.last);
    const now = this.ctx.currentTime;
    const prev = this.cur;
    if (this.track >= 0) {
      this.cur = 1 - this.cur;
      const g = this.gains[prev].gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + fadeIn);
      const old = this.els[prev];
      window.setTimeout(() => this.cur !== prev && old.pause(), fadeIn * 1000 + 100);
    }
    this.track = pick;
    const t = this.tracks[pick];
    const el = this.els[this.cur];
    el.src = `data/audio/${t.file}`;
    void el.play().catch(() => {});
    const g = this.gains[this.cur].gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(t.gain, now + fadeIn);
    this.crossfading = false;
  }

  update(night: number): void {
    this.night = night;
    const el = this.els[this.cur];
    if (this.track < 0 || this.crossfading || !Number.isFinite(el.duration)) return;
    if (el.duration - el.currentTime < FADE.crossfade) {
      this.crossfading = true;
      this.next(night);
    }
  }

  pause(): void {
    for (const el of this.els) el.pause();
  }

  resume(): void {
    if (this.track >= 0) void this.els[this.cur].play().catch(() => {});
  }

  describe(): string {
    if (this.track < 0) return "not started";
    const el = this.els[this.cur];
    const t = this.tracks[this.track];
    const m = (s: number) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "?");
    return `"${t.title}" ${m(el.currentTime)} / ${m(el.duration)}`;
  }
}

/**
 * The track after `last[light]` among the light's tracks (any track if the light has none),
 * and records it in `last`. Shared with tools/simulate.ts.
 */
export function nextTrack(tracks: TrackJson[], light: "day" | "night", last: { day: number; night: number }): number {
  let ids = tracks.flatMap((t, i) => (t.light === light ? [i] : []));
  if (!ids.length) ids = tracks.map((_, i) => i);
  const pick = ids.find((i) => i > last[light]) ?? ids[0];
  last[light] = pick;
  return pick;
}

/** A tenth of a second of silence as a WAV, to prime a media element inside the gesture. */
let silence = "";
function silenceUrl(): string {
  if (silence) return silence;
  const rate = 8000;
  const n = rate / 10;
  const b = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  b.setUint32(4, 36 + n * 2, true);
  str(8, "WAVEfmt ");
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true); // PCM
  b.setUint16(22, 1, true); // mono
  b.setUint32(24, rate, true);
  b.setUint32(28, rate * 2, true);
  b.setUint16(32, 2, true);
  b.setUint16(34, 16, true);
  str(36, "data");
  b.setUint32(40, n * 2, true);
  silence = URL.createObjectURL(new Blob([b.buffer], { type: "audio/wav" }));
  return silence;
}
