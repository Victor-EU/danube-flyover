// Tunables from the design doc, in one place. Units: metres, seconds, radians.

const deg = (d: number) => (d * Math.PI) / 180;

export const BIRD = {
  minSpeed: 8,
  maxSpeed: 25,
  cruise: 15,
  accel: 5,
  maxYawRate: deg(55),
  maxClimb: 10,
  maxDive: 16,
  ceiling: 180,
  /** Minimum height above the floor (ground, buildings, bridge towers) over land. */
  landClearance: 15,
  /** Minimum height above a bridge deck when crossing over it. */
  deckClearance: 6,
  /** Maximum lateral distance from the route. */
  corridor: 300,
};

export const BOAT = {
  minSpeed: 2,
  maxSpeed: 12,
  cruise: 8,
  accel: 3,
  maxYawRate: deg(30),
  /** Distance kept from the river banks. */
  bankMargin: 5,
};

export const CONTROL = {
  blendIn: 0.5,
  idleBeforeReturn: 3,
  blendOut: 2,
  /** Arc-length window searched by `nearest()` while the user is (partly) in control. */
  manualWindow: 300,
};

export const TRANSITION = {
  landing: 2.0,
  takeoff: 2.5,
  /** Manual landing starts below this altitude over water while descending. */
  landingAltitude: 2,
  /** Throttle must be held at max boat speed this long to take off. */
  takeoffHold: 1,
  takeoffAltitude: 25,
  /** Take-off never starts under a deck or this close before one. */
  takeoffDeckGap: 30,
};

export const WORLD = {
  latMin: 47.48,
  latMax: 47.541,
  lonMin: 19.026,
  lonMax: 19.074,
  /** The bird stays at least this far inside the world edge. */
  edgeMargin: 50,
  landBase: 4,
  quayHeight: 4.5,
  quayWidth: 40,
};

export const CAMERA = {
  bird: { back: 12, up: 4, fov: 70 },
  boat: { back: 6, up: 1.5, fov: 60 },
  smoothTime: 0.4,
};
