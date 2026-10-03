// Tunables from the design doc, in one place. Units: metres, seconds, radians.

const deg = (d: number) => (d * Math.PI) / 180;

export const GLIDER = {
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
  /** The glider stays at least this far inside the world edge. */
  edgeMargin: 50,
  landBase: 4,
  quayHeight: 4.5,
  quayWidth: 40,
};

/**
 * The far field (tools/build-far.ts, src/world/far.ts): the city, the hills and the river
 * beyond the world, out into the haze. OpenStreetMap is fetched over `box` (26 km square);
 * the terrain goes on, coarser, over `wide` (50 km), for the hills' silhouettes.
 */
export const FAR = {
  box: { latMin: 47.4, latMax: 47.63, lonMin: 18.88, lonMax: 19.22 },
  wide: { latMin: 47.29, latMax: 47.74, lonMin: 18.72, lonMax: 19.38 },
};

export const CAMERA = {
  glider: { back: 12, up: 4, fov: 70 },
  boat: { back: 7.5, up: 2, fov: 60 },
  smoothTime: 0.4,
  /** Changes between camera modes blend over this long. */
  blend: 1.5,
  /** `low`, under bridge decks: just above the vehicle. */
  low: { glider: { back: 8.5, up: 1.2 }, boat: { back: 6.5, up: 1.5 } },
  /** `reveal` starts this far behind and above, and catches up by the next camera key. */
  reveal: { back: 55, up: 22 },
  /**
   * `orbit` swings the rig around the vehicle so the target stays within `frame` of it
   * (both on screen), but never more than `maxSwing` from straight behind.
   */
  orbit: { glider: { back: 18, up: 6 }, boat: { back: 11, up: 2.6 }, frame: deg(34), maxSwing: deg(75) },
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
  /** The glider, which can't hover, circles at this radius while paused. */
  gliderRadius: 60,
};

/** The sunset-run clock eases toward the route's clock with this time constant (s). */
export const CLOCK_EASE = 1.5;

/**
 * The texture set (tools/gen-textures.ts paints it, tools/pack-textures.ts packs it into
 * public/data/tex/). Facade tiles are 4 bays by 4 storeys: the bottom row is the ground
 * floor, the three above repeat up the building. Layer order is the array texture's.
 */
export const TEXTURES = {
  storey: 3.4,
  bays: 4,
  facades: ["pestEclectic", "pestClassic", "secession", "budaBaroque", "castle", "modern", "panel", "villa"],
  roofs: ["roofTile", "roofSlate", "roofCopper", "roofFlat"],
  /** After the roofs in the surface array: the blank firewalls' and trim's render. */
  plaster: "plaster",
  /** Metres covered by one plaster tile. */
  plasterTile: 6,
  /** The ground's surfaces (their own array), and the metres one tile of each covers. */
  ground: ["asphalt", "paving", "sett", "grass", "gravel"],
  groundTile: [4, 3, 2, 6, 4],
  /** Metres covered by one roof and one quay tile. */
  roofTile: 8,
  quayTile: 4,
  /** Water normal-map tile, metres. */
  waterTile: 24,
  /** Facades and roofs are near-white detail, tinted by the building's own colour times this. */
  tintGain: 1.22,
  skies: ["dawn", "day", "golden", "night"],
};

/**
 * The live rendering settings: the high tier until src/quality.ts applies the tier chosen
 * from public/data/quality.json.
 */
export const QUALITY = {
  /** Cap on the device pixel ratio. */
  pixelRatio: 2,
  /** 0: no sun shadows. */
  shadowMapSize: 2048,
  /** Planar reflections near Parliament and the Chain Bridge, at this fraction of the screen. */
  reflections: true,
  reflectionScale: 0.5,
  bloom: true,
  /** MSAA samples for the HDR scene target (the composer replaces the canvas's own AA). */
  samples: 4,
  /** Share of the trees drawn. */
  trees: 1,
  /** Share of the parked and moving cars drawn (0: none). */
  cars: 1,
  anisotropy: 8,
  /** Ambient life: tour boats, trams, gulls. */
  life: true,
  /** Wave simulation cells a side, a power of 2 (WAKE.cell metres each); 0: the plain foam trail. */
  wake: 512,
  /** Metres from the camera within which the far field's buildings are drawn. */
  far: 12000,
};

/**
 * The boat's wake (src/world/wake.ts): linear deep-water waves simulated on the GPU in a
 * square that follows the boat on a leash and drifts with the current. The hulls press on
 * the water; everything else (the V, its feathered crests, the waves running on after the
 * boat turns or stops, other boats' wakes crossing it) comes out of the waves themselves.
 */
export const WAKE = {
  /** Metres per cell. */
  cell: 0.5,
  /** Absorbing band at the square's edges, as a share of its size. */
  sponge: 0.08,
  /** The boat may stray this share of the size from the centre before the square follows. */
  leash: 0.27,
  /** The current, m/s downstream (the water normal maps' flow). */
  current: 0.6,
  /** Horizontal displacement toward the crests (sharper crests, flatter troughs). */
  chop: 0.55,
  /** Seconds the waves keep running after the boat leaves the water (for the view from the air). */
  linger: 90,
  /** Scales every hull's pressure: 1 is the linear theory's wake for the hull's weight. */
  gain: 1,
};

/**
 * The heroes' texture layers (tools/textures/heroes.ts paints them, tools/heroes/ models
 * with them). Each is one layer of a second array texture (1024², 512² in the WebP
 * fallback), `tile` metres wide and tall; window layers (`lit`) hold `bays` × `rows` windows
 * per tile and come first, in the order of the lit array. Alpha is roughness. Most are
 * near-white detail tinted per vertex.
 */
export const HERO_LAYERS = [
  { name: "gothic", tile: [8.8, 12], bays: 2, rows: 2, lit: true },
  { name: "palace", tile: [8, 9.2], bays: 2, rows: 2, lit: true },
  { name: "secession", tile: [7.2, 7.6], bays: 2, rows: 2, lit: true },
  { name: "market", tile: [10, 14], bays: 2, rows: 2, lit: true },
  { name: "lancet", tile: [9, 15], bays: 2, rows: 1, lit: true },
  { name: "arcade", tile: [6.4, 8.4], bays: 2, rows: 2, lit: true },
  { name: "ashlar", tile: [4, 4], bays: 1, rows: 1, lit: false },
  { name: "tiles", tile: [4, 4], bays: 1, rows: 1, lit: false },
  { name: "zsolnay", tile: [6, 6], bays: 1, rows: 1, lit: false },
  { name: "copper", tile: [4, 4], bays: 1, rows: 1, lit: false },
  { name: "iron", tile: [4, 2], bays: 1, rows: 1, lit: false },
  { name: "plain", tile: [8, 8], bays: 1, rows: 1, lit: false },
  { name: "metal", tile: [8, 8], bays: 1, rows: 1, lit: false },
] as const;

export type HeroLayer = (typeof HERO_LAYERS)[number]["name"];
export const HERO_LAYER = Object.fromEntries(HERO_LAYERS.map((l, i) => [l.name, i])) as Record<HeroLayer, number>;
/** Hero texture coordinates are stored as tiles / HERO_UV_RANGE + 0.5, so they quantise into [0, 1]. */
export const HERO_UV_RANGE = 128;

/**
 * The tree species (tools/build-trees.ts grows them, tools/build-city.ts plants them, and
 * build-floor clears their crowns): height and crown radius in metres at scale 1, and the
 * share of leaves turned in early October.
 */
export const TREE_SPECIES = [
  { name: "plane", height: 24, radius: 8.5, turned: 0.45 },
  { name: "chestnut", height: 17, radius: 7, turned: 0.7 },
  { name: "linden", height: 19, radius: 6.5, turned: 0.65 },
  { name: "maple", height: 15, radius: 6, turned: 0.8 },
  { name: "poplar", height: 26, radius: 6.5, turned: 0.5 },
  { name: "willow", height: 14, radius: 7, turned: 0.25 },
  { name: "oak", height: 18, radius: 7.5, turned: 0.35 },
  { name: "robinia", height: 15, radius: 5.5, turned: 0.4 },
  { name: "pine", height: 16, radius: 4.5, turned: 0 },
] as const;
export type TreeSpecies = (typeof TREE_SPECIES)[number]["name"];
export const TREE_SPECIES_INDEX = Object.fromEntries(TREE_SPECIES.map((s, i) => [s.name, i])) as Record<TreeSpecies, number>;
/** Shape variants grown per species. */
export const TREE_VARIANTS = 3;
