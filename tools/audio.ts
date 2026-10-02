// The music for public/data/audio/: decodes each track's original (downloaded by hand into
// tools/out/audio/, see audio.json's `original`), trims the silence at both ends, measures its
// loudness (ITU-R BS.1770: K-weighted, gated) and writes the gain that brings it to TARGET and
// the trimmed length into audio.json, then encodes it as AAC in an .m4a. macOS only: it uses afconvert to decode and
// encode. The outputs are committed, so the app never needs this to run.
// Usage: npm run audio

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AudioJson, TrackJson } from "../src/audio.ts";

/**
 * Integrated loudness the tracks are brought to (LUFS): low enough that the quietest-mastered
 * track reaches it under the peak limit, so all four match. The ambience sits about 7 dB below.
 */
const TARGET = -19.5;
/** Highest sample peak allowed after the gain (dBFS); the gain is lowered to keep it. */
const PEAK = -1;
/** AAC bit rate: stereo music at 128 kb/s is about 1 MB a minute. */
const BITRATE = 128000;
/** Silence at the ends below this (dBFS) is trimmed, keeping MARGIN seconds of it. */
const SILENT = -50;
const MARGIN = 0.05;

const DATA = new URL("../public/data/", import.meta.url);
const SRC = new URL("./out/audio/", import.meta.url);
const path = (u: URL) => fileURLToPath(u);

type Source = TrackJson & { original: string };

const json = JSON.parse(readFileSync(new URL("audio.json", DATA), "utf8")) as AudioJson & { tracks: Source[] };
mkdirSync(new URL("audio/", DATA), { recursive: true });
mkdirSync(new URL("tmp/", SRC), { recursive: true });

for (const t of json.tracks) {
  const original = new URL(t.original, SRC);
  if (!existsSync(original)) throw new Error(`${t.title}: put the original at tools/out/audio/${t.original} (from ${t.source})`);
  const raw = new URL(`tmp/${t.file}.raw.wav`, SRC);
  execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@44100", "-c", "2", path(original), path(raw)]);
  const pcm = readWav(readFileSync(raw));

  const [from, to] = trim(pcm);
  const cut = { rate: pcm.rate, l: pcm.l.subarray(from, to), r: pcm.r.subarray(from, to) };
  // 10 ms fades so a trim never starts or ends on a click.
  fadeEnds(cut, 0.01);
  const loud = loudness(cut);
  let peak = 0;
  for (let i = 0; i < cut.l.length; i++) peak = Math.max(peak, Math.abs(cut.l[i]), Math.abs(cut.r[i]));
  const want = 10 ** ((TARGET - loud) / 20);
  const gain = Math.min(want, 10 ** (PEAK / 20) / peak);
  t.gain = Math.round(gain * 1000) / 1000;
  t.seconds = Math.round((cut.l.length / cut.rate) * 10) / 10;

  const trimmed = new URL(`tmp/${t.file}.wav`, SRC);
  writeFileSync(trimmed, writeWav(cut));
  const out = new URL(`audio/${t.file}`, DATA);
  execFileSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", String(BITRATE), path(trimmed), path(out)]);
  writeFileSync(out, zeroTimes(readFileSync(out)));
  const seconds = cut.l.length / cut.rate;
  console.log(
    `${t.file}: "${t.title}" ${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}, ` +
      `trimmed ${(from / pcm.rate).toFixed(2)} s + ${((pcm.l.length - to) / pcm.rate).toFixed(2)} s, ` +
      `${loud.toFixed(1)} LUFS, peak ${(20 * Math.log10(peak)).toFixed(1)} dB → gain ${t.gain}` +
      `${gain < want ? " (peak-limited)" : ""}, ${(statSync(out).size / 1e6).toFixed(2)} MB`,
  );
}

writeFileSync(new URL("audio.json", DATA), `${JSON.stringify(json, null, 2)}\n`);
const total = json.tracks.reduce((a, t) => a + statSync(new URL(`audio/${t.file}`, DATA)).size, 0);
console.log(`${json.tracks.length} tracks, ${(total / 1e6).toFixed(2)} MB`);

/**
 * Zero the creation and modification times in the MP4's movie, track and media headers, the
 * only bytes that change between runs, so the encode is reproducible.
 */
function zeroTimes(buf: Buffer): Buffer {
  const walk = (from: number, to: number) => {
    for (let o = from; o + 8 <= to; ) {
      const size = buf.readUInt32BE(o);
      const type = buf.toString("ascii", o + 4, o + 8);
      if (size < 8) break;
      if (type === "moov" || type === "trak" || type === "mdia") walk(o + 8, o + size);
      else if (type === "mvhd" || type === "tkhd" || type === "mdhd") {
        const wide = buf[o + 8] === 1; // version 1: 64-bit times
        buf.fill(0, o + 12, o + 12 + (wide ? 16 : 8));
      }
      o += size;
    }
  };
  walk(0, buf.length);
  return buf;
}

interface Pcm {
  rate: number;
  l: Float32Array;
  r: Float32Array;
}

function readWav(buf: Buffer): Pcm {
  // Walk the chunks: afconvert may add some before "data".
  let o = 12;
  let rate = 44100;
  let channels = 2;
  while (o < buf.length) {
    const id = buf.toString("ascii", o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(o + 10);
      rate = buf.readUInt32LE(o + 12);
    } else if (id === "data") {
      const n = Math.floor(size / (2 * channels));
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        l[i] = buf.readInt16LE(o + 8 + i * 2 * channels) / 32768;
        r[i] = channels > 1 ? buf.readInt16LE(o + 10 + i * 2 * channels) / 32768 : l[i];
      }
      return { rate, l, r };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error("no data chunk");
}

function writeWav(p: Pcm): Buffer {
  const n = p.l.length;
  const b = Buffer.alloc(44 + n * 4);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + n * 4, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(p.rate, 24);
  b.writeUInt32LE(p.rate * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(n * 4, 40);
  const q = (x: number) => Math.round(Math.max(-1, Math.min(1, x)) * 32767);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(q(p.l[i]), 44 + i * 4);
    b.writeInt16LE(q(p.r[i]), 46 + i * 4);
  }
  return b;
}

/** The first and last samples above SILENT, widened by MARGIN. */
function trim(p: Pcm): [number, number] {
  const thr = 10 ** (SILENT / 20);
  const loud = (i: number) => Math.abs(p.l[i]) > thr || Math.abs(p.r[i]) > thr;
  let a = 0;
  while (a < p.l.length && !loud(a)) a++;
  let b = p.l.length - 1;
  while (b > a && !loud(b)) b--;
  const m = Math.round(MARGIN * p.rate);
  return [Math.max(0, a - m), Math.min(p.l.length, b + 1 + m)];
}

function fadeEnds(p: Pcm, seconds: number): void {
  const n = Math.min(Math.round(seconds * p.rate), p.l.length >> 1);
  for (let i = 0; i < n; i++) {
    const g = i / n;
    const j = p.l.length - 1 - i;
    p.l[i] *= g;
    p.r[i] *= g;
    p.l[j] *= g;
    p.r[j] *= g;
  }
}

/** BS.1770 integrated loudness (LUFS): K-weighting, 400 ms blocks at 75% overlap, two gates. */
function loudness(p: Pcm): number {
  const shelf = biquad("highshelf", 1681.974450955533, 3.999843853973347, 0.7071752369554196, p.rate);
  const hp = biquad("highpass", 38.13547087602444, 0, 0.5003270373238773, p.rate);
  const z = [p.l, p.r].map((x) => hp(shelf(x)));
  const block = Math.round(0.4 * p.rate);
  const hop = Math.round(0.1 * p.rate);
  const powers: number[] = [];
  for (let s = 0; s + block <= z[0].length; s += hop) {
    let sum = 0;
    for (const ch of z) for (let i = s; i < s + block; i++) sum += ch[i] * ch[i];
    powers.push(sum / block);
  }
  const lufs = (pw: number) => -0.691 + 10 * Math.log10(pw);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const abs = powers.filter((pw) => lufs(pw) > -70);
  const rel = lufs(mean(abs)) - 10;
  return lufs(mean(abs.filter((pw) => lufs(pw) > rel)));
}

/**
 * The two K-weighting stages at any sample rate, from Brecht De Man's derivation of the
 * BS.1770 coefficients (exact at 48 kHz): a +4 dB shelf above ~1.7 kHz and a 38 Hz high-pass.
 */
function biquad(type: "highshelf" | "highpass", fc: number, gainDb: number, q: number, rate: number): (x: Float32Array) => Float32Array {
  const K = Math.tan((Math.PI * fc) / rate);
  const a0 = 1 + K / q + K * K;
  const a1 = (2 * (K * K - 1)) / a0;
  const a2 = (1 - K / q + K * K) / a0;
  let b0 = 1, b1 = -2, b2 = 1;
  if (type === "highshelf") {
    const vh = 10 ** (gainDb / 20);
    const vb = vh ** 0.4996667741545416;
    b0 = (vh + (vb * K) / q + K * K) / a0;
    b1 = (2 * (K * K - vh)) / a0;
    b2 = (vh - (vb * K) / q + K * K) / a0;
  }
  return (x) => {
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x[i];
      y2 = y1;
      y1 = v;
      y[i] = v;
    }
    return y;
  };
}
