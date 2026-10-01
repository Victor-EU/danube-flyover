// The world rectangle in local metres, shared by the runtime and the tools/ pipeline.

import { WORLD } from "../config";
import { lonLatToLocal } from "../geo";

export interface Bounds {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export function worldBounds(): Bounds {
  const nw = lonLatToLocal(WORLD.lonMin, WORLD.latMax);
  const se = lonLatToLocal(WORLD.lonMax, WORLD.latMin);
  return { x0: nw.x, x1: se.x, z0: nw.z, z1: se.z };
}
