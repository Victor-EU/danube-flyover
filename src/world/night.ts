// The uniforms every lit-at-night material shares, set once per frame by Lighting, and the
// one ramp they all follow: 0 at sun elevation +3°, 1 at -12° (about 18:00 to 19:30, and
// the reverse before dawn).

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export const NIGHT_RAMP = { start: 3, end: -12 };

export function nightRamp(elevation: number): number {
  return clamp01((NIGHT_RAMP.start - elevation) / (NIGHT_RAMP.start - NIGHT_RAMP.end));
}

/** Shared by reference: patched materials put these very objects in their uniforms. */
export const SHARED = {
  /** Sun elevation in degrees. */
  uSunElevation: { value: 30 },
  /** nightRamp(elevation), smoothed: night lights and floodlights. */
  uNight: { value: 0 },
  /** Seconds, for anything that moves (water, twinkle). */
  uTime: { value: 0 },
};

/** GLSL twin of nightRamp, with an elevation offset (jitter) in degrees. */
export const NIGHT_GLSL = /* glsl */ `
uniform float uSunElevation;
uniform float uNight;
uniform float uTime;
float nightRampAt(float jitter) {
  return clamp((${NIGHT_RAMP.start.toFixed(1)} - (uSunElevation + jitter)) / ${(NIGHT_RAMP.start - NIGHT_RAMP.end).toFixed(1)}, 0.0, 1.0);
}`;
