// Gradient noise for the procedural textures: a periodic variant (tiles exactly over `period`
// lattice cells, for the water normal map) and fbm on top. Deterministic: the lattice hash is
// integer arithmetic, so every run paints the same pixels.

function hash2(i: number, j: number, seed: number): number {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** 256 unit gradients, looked up by hash (no trig per lattice corner). */
const GX = new Float64Array(256);
const GY = new Float64Array(256);
for (let k = 0; k < 256; k++) {
  GX[k] = Math.cos((k / 256) * Math.PI * 2);
  GY[k] = Math.sin((k / 256) * Math.PI * 2);
}

function grad(i: number, j: number, seed: number, x: number, y: number): number {
  const k = Math.floor(hash2(i, j, seed) * 256);
  return GX[k] * x + GY[k] * y;
}

/** 2D gradient noise in about [-1, 1]; wraps every `period` cells when period > 0. */
export function noise2(x: number, y: number, seed = 0, period = 0): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const w = (k: number) => (period > 0 ? ((k % period) + period) % period : k);
  const i0 = w(i);
  const i1 = w(i + 1);
  const j0 = w(j);
  const j1 = w(j + 1);
  const u = fade(fx);
  const v = fade(fy);
  const a = grad(i0, j0, seed, fx, fy);
  const b = grad(i1, j0, seed, fx - 1, fy);
  const c = grad(i0, j1, seed, fx, fy - 1);
  const d = grad(i1, j1, seed, fx - 1, fy - 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 1.41;
}

/** Fractal sum of `octaves` noise layers, normalised to about [-1, 1]. */
export function fbm(x: number, y: number, octaves: number, seed = 0, period = 0, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(x * f, y * f, seed + o * 31, period > 0 ? period * f : 0);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
