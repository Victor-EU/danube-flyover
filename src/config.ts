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
  /** Changes between camera modes blend over this long. */
  blend: 1.5,
  /** `low`, under bridge decks: just above the vehicle. */
  low: { bird: { back: 8.5, up: 1.2 }, boat: { back: 4.5, up: 0.7 } },
  /** `reveal` starts this far behind and above, and catches up by the next camera key. */
  reveal: { back: 55, up: 22 },
  /**
   * `orbit` swings the rig around the vehicle so the target stays within `frame` of it
   * (both on screen), but never more than `maxSwing` from straight behind.
   */
  orbit: { bird: { back: 18, up: 6 }, boat: { back: 11, up: 2.6 }, frame: deg(34), maxSwing: deg(75) },
};

export const CARDS = {
  /** Seconds a card shows (unless expanded). */
  show: 8,
  /** Pause between one card leaving and the next arriving. */
  gap: 0.8,
  /** The landmark must be within this angle of the camera's forward vector. */
  viewAngle: deg(40),
};

export const LOOP = {
  /** Seconds the autopilot circles the Market Hall after the route ends. */
  circle: 5,
  fadeOut: 1,
  fadeIn: 1.2,
};

/** Keyboard jumps to a beat fade through black. */
export const JUMP = { fadeOut: 0.3, fadeIn: 0.5 };

export const PAUSE = {
  /** The bird, which can't hover, circles at this radius while paused. */
  birdRadius: 60,
};

/** The sunset-run clock eases toward the route's clock with this time constant (s). */
export const CLOCK_EASE = 1.5;
