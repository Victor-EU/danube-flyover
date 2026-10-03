// The one state object. Each module writes its own part once per frame and reads the rest.

export type Mode = "GLIDER" | "LANDING" | "BOAT" | "TAKEOFF";
export type CameraMode = "follow" | "orbit" | "reveal" | "low";

/** Rates the vehicle integrates: the controller blends autopilot and manual versions of this. */
export interface Command {
  yawRate: number;
  accel: number;
  climb: number;
}

export const ZERO_COMMAND: Readonly<Command> = { yawRate: 0, accel: 0, climb: 0 };

export interface VehicleState {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  vSpeed: number;
  yawRate: number;
  roll: number;
  pitch: number;
  mode: Mode;
  /** Seconds since the current transition started. */
  transitionT: number;
  transitionFrom: { speed: number; y: number };
  /** 0 = glider mesh, 1 = boat mesh; crossfaded behind the splash. */
  boatness: number;
  /** Seconds a take-off has been asked for (E held, or the throttle at the boat's own top speed). */
  takeoffHeld: number;
  /**
   * The user has steered (or landed) this boat, so it stays a boat until they take off: the
   * autopilot keeps it to the river rather than flying the route.
   */
  userBoat: boolean;
  /** Per-bridge-deck choice of passing under or over, while near that deck. */
  deckSide: Map<number, "under" | "over">;
  /** Diagnostics for the debug panel. */
  minAltitude: number;
  lateral: number;
}

export interface State {
  t: number;
  dt: number;
  timeOfDay: number;
  sunsetRun: { enabled: boolean; pausedUntil: number };
  sun: { elevation: number; azimuth: number };
  /** Pause stops the autopilot and leaves the user in free control (Space, or the bar button). */
  paused: boolean;
  input: {
    steer: number;
    throttle: number;
    climb: number;
    /** Shift held, or the bar's boost on. */
    boost: boolean;
    /** True while any steering input (boost included) is held. */
    active: boolean;
    everUsed: boolean;
  };
  autopilot: {
    s: number;
    holdLeft: number;
    routeMode: "glider" | "boat";
    command: Command;
    beat: string;
    routeTime: number;
    /** "end": past the last point, circling the Market Hall before the loop. */
    phase: "tour" | "end";
    /** Seconds spent circling at the end. */
    endT: number;
    /** Which way the user's boat cruises the river: 1 downstream, -1 up, 0 not yet chosen. */
    riverDir: -1 | 0 | 1;
  };
  /** `boost`: the vehicle may run to its boost speed this frame. */
  control: { w: number; idleFor: number; command: Command; boost: boolean };
  vehicle: VehicleState;
  /** What the camera rig is doing, for the HUD and the simulator. */
  camera: {
    mode: CameraMode;
    /** Index of the route's camera key in force (-1 before the first). */
    key: number;
    /** Camera keys are ignored while the user has control, until the next key is reached. */
    suspended: boolean;
    target: string;
    /** 0 → 1 over the 1.5 s blend into the current mode. */
    blend: number;
  };
  /** The landmark card on screen, if any. */
  cards: { id: string | null; age: number; expanded: boolean; gap: number };
  /** `fade`: 0 clear, 1 black (the loop and beat jumps fade through black). `boost`: the bar's boost toggle (or B). */
  ui: { debug: boolean; sliderVisible: boolean; fade: number; boost: boolean };
}

export function createState(): State {
  return {
    t: 0,
    dt: 0,
    timeOfDay: 18,
    sunsetRun: { enabled: true, pausedUntil: 0 },
    sun: { elevation: 0, azimuth: 0 },
    paused: false,
    input: { steer: 0, throttle: 0, climb: 0, boost: false, active: false, everUsed: false },
    autopilot: {
      s: 0,
      holdLeft: 0,
      routeMode: "glider",
      command: { ...ZERO_COMMAND },
      beat: "",
      routeTime: 0,
      phase: "tour",
      endT: 0,
      riverDir: 0,
    },
    control: { w: 0, idleFor: 0, command: { ...ZERO_COMMAND }, boost: false },
    vehicle: {
      x: 0,
      y: 0,
      z: 0,
      heading: 0,
      speed: 0,
      vSpeed: 0,
      yawRate: 0,
      roll: 0,
      pitch: 0,
      mode: "GLIDER",
      transitionT: 0,
      transitionFrom: { speed: 0, y: 0 },
      boatness: 0,
      takeoffHeld: 0,
      userBoat: false,
      deckSide: new Map(),
      minAltitude: 0,
      lateral: 0,
    },
    camera: { mode: "follow", key: -1, suspended: false, target: "", blend: 1 },
    cards: { id: null, age: 0, expanded: false, gap: 0 },
    ui: { debug: false, sliderVisible: true, fade: 0, boost: false },
  };
}
