// Local metric frame: a simple equirectangular offset centred on the Chain Bridge.
// +X east, +Y up (metres above the river surface), +Z south. Error is under 1 m
// across the 6 km extent, so no projection library is needed.

export const ORIGIN = { lat: 47.499, lon: 19.0437 };

const phi = (ORIGIN.lat * Math.PI) / 180;
export const M_PER_DEG_LAT = 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
export const M_PER_DEG_LON =
  111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);

export interface XZ {
  x: number;
  z: number;
}

export function lonLatToLocal(lon: number, lat: number): XZ {
  return { x: (lon - ORIGIN.lon) * M_PER_DEG_LON, z: -(lat - ORIGIN.lat) * M_PER_DEG_LAT };
}

export function localToLonLat(x: number, z: number): { lon: number; lat: number } {
  return { lon: ORIGIN.lon + x / M_PER_DEG_LON, lat: ORIGIN.lat - z / M_PER_DEG_LAT };
}

/** Convenience for `[lat, lon]` tuples as stored in the data files. */
export function latLonToLocal(p: readonly [number, number]): XZ {
  return lonLatToLocal(p[1], p[0]);
}

/** Compass heading (radians, 0 = north, clockwise) of a direction in the local frame. */
export function headingOf(dx: number, dz: number): number {
  return Math.atan2(dx, -dz);
}

/** Unit forward vector (x, z) for a compass heading. */
export function forwardOf(heading: number): XZ {
  return { x: Math.sin(heading), z: -Math.cos(heading) };
}

export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
