// The one vehicle with two states: a sailplane and a small boat, scaled in and out of each
// other behind the splash. Both face -Z in their local space, in metres.

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
} from "three";
import type { State } from "./state";
import { SHARED } from "./world/night";

/**
 * A closed solid through cross-sections of equal size (each a ring of points), with flat ends.
 * Wings and fins are lofts of four-point aerofoils: leading edge, top, trailing edge, bottom.
 */
function loft(sections: Vector3[][]): BufferGeometry {
  const pos: number[] = [];
  const tri = (a: Vector3, b: Vector3, c: Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  const n = sections[0].length;
  for (let k = 0; k + 1 < sections.length; k++) {
    const a = sections[k];
    const b = sections[k + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tri(a[i], b[i], b[j]);
      tri(a[i], b[j], a[j]);
    }
  }
  const first = sections[0];
  const last = sections[sections.length - 1];
  for (let i = 1; i + 1 < n; i++) {
    tri(first[0], first[i + 1], first[i]);
    tri(last[0], last[i], last[i + 1]);
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  return geo;
}

/** A spanwise aerofoil section at `x`: chord from `le` to `te` (z), `t` thick, at height `y`. */
function aerofoil(x: number, y: number, le: number, te: number, t: number): Vector3[] {
  const top = le + (te - le) * 0.3;
  return [new Vector3(x, y, le), new Vector3(x, y + t * 0.6, top), new Vector3(x, y, te), new Vector3(x, y - t * 0.4, top)];
}

/** The same for a vertical fin: a section at height `y`, `t` thick across x. */
function finSection(y: number, le: number, te: number, t: number): Vector3[] {
  const mid = le + (te - le) * 0.3;
  return [new Vector3(0, y, le), new Vector3(-t / 2, y, mid), new Vector3(0, y, te), new Vector3(t / 2, y, mid)];
}

/** Wing geometry: 3.6 m a side, tapering, with 3.5° of dihedral; the last 0.55 m is the red tip. */
const WING = { root: 0.12, tip: 3.7, y: 0.15, dihedral: Math.tan((3.5 * Math.PI) / 180), red: 3.15 };
const wingY = (x: number) => WING.y + Math.abs(x) * WING.dihedral;
const wingLe = (x: number) => -0.3 + 0.14 * (Math.abs(x) / WING.tip);
const wingTe = (x: number) => 0.16 - 0.16 * (Math.abs(x) / WING.tip);
const wingT = (x: number) => 0.075 - 0.05 * (Math.abs(x) / WING.tip);

function wingPanel(side: 1 | -1, from: number, to: number): BufferGeometry {
  const at = (x: number) => aerofoil(side * x, wingY(x), wingLe(x), wingTe(x), wingT(x));
  const mid = (from + to) / 2;
  const sections = [at(from), at(mid), at(to)];
  // Keep the triangles facing out on both sides.
  return loft(side > 0 ? sections : sections.map((s) => [...s].reverse()));
}

export class VehicleMesh {
  readonly group = new Group();
  private readonly glider = new Group();
  private readonly boat = new Group();
  private readonly navMat: MeshBasicMaterial[] = [];

  constructor() {
    const gelcoat = new MeshStandardMaterial({ color: "#f6f5f1", roughness: 0.32, flatShading: true });
    const red = new MeshStandardMaterial({ color: "#d9442f", roughness: 0.4, flatShading: true });
    const glass = new MeshStandardMaterial({ color: "#1c2a3a", roughness: 0.12, metalness: 0.4, flatShading: true });

    // The fuselage: a slim pod tapering into the tail boom, turned about its long axis.
    const profile = [
      [0, -1.55], [0.1, -1.46], [0.2, -1.22], [0.26, -0.86], [0.27, -0.46], [0.22, -0.05],
      [0.14, 0.45], [0.09, 1.1], [0.07, 1.7], [0.06, 2.06], [0, 2.14],
    ].map(([r, a]) => new Vector2(r, a));
    const bodyGeo = new LatheGeometry(profile, 10);
    bodyGeo.rotateX(Math.PI / 2);
    bodyGeo.scale(1, 1.12, 1);
    const body = new Mesh(bodyGeo, gelcoat);
    const canopyGeo = new SphereGeometry(1, 10, 6);
    canopyGeo.scale(0.2, 0.17, 0.62);
    const canopy = new Mesh(canopyGeo, glass);
    canopy.position.set(0, 0.17, -0.8);
    this.glider.add(body, canopy);

    for (const side of [1, -1] as const) {
      this.glider.add(new Mesh(wingPanel(side, WING.root, WING.red), gelcoat), new Mesh(wingPanel(side, WING.red, WING.tip), red));
      // A winglet standing up from the tip, canted slightly out.
      const x = WING.tip;
      const y = wingY(x);
      const winglet = [finSection(0, -0.16, 0.0, 0.02), finSection(0.22, -0.07, 0.02, 0.012)].map((sec) =>
        sec.map((p) => new Vector3(side * (x + 0.18 * p.y) + p.x, y + p.y, p.z)),
      );
      this.glider.add(new Mesh(loft(winglet), red));
      // Navigation lights at the tips: red to port (left), green to starboard.
      const nav = new MeshBasicMaterial({ color: side > 0 ? "#3dff6a" : "#ff3a2a" });
      nav.userData.base = nav.color.clone();
      this.navMat.push(nav);
      const lamp = new Mesh(new SphereGeometry(0.045, 6, 4), nav);
      lamp.position.set(side * (x + 0.02), y + 0.01, -0.1);
      this.glider.add(lamp);
    }

    // The T-tail: the fin over the end of the boom and the tailplane across its top.
    const fin = loft([finSection(0.04, 1.56, 2.13, 0.05), finSection(0.42, 1.74, 2.13, 0.035), finSection(0.78, 1.9, 2.1, 0.025)]);
    this.glider.add(new Mesh(fin, red));
    for (const side of [1, -1] as const) {
      const at = (x: number) => aerofoil(side * x, 0.79, 1.86 + 0.1 * (x / 0.78), 2.12 - 0.04 * (x / 0.78), 0.03 - 0.012 * (x / 0.78));
      const sections = [at(0), at(0.39), at(0.78)];
      this.glider.add(new Mesh(loft(side > 0 ? sections : sections.map((sec) => [...sec].reverse())), gelcoat));
    }

    const hullMat = new MeshStandardMaterial({ color: "#f1ede4", roughness: 0.6, flatShading: true });
    const stripe = new MeshStandardMaterial({ color: "#b0362e", roughness: 0.6, flatShading: true });
    const deckMat = new MeshStandardMaterial({ color: "#a07850", roughness: 0.8, flatShading: true });
    const hullGeo = new BoxGeometry(1.8, 0.8, 4.6);
    // Taper the bow: pull the front vertices together.
    const p = hullGeo.attributes.position as BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      if (p.getZ(i) < 0) p.setX(i, p.getX(i) * 0.25);
    }
    hullGeo.computeVertexNormals();
    const hull = new Mesh(hullGeo, hullMat);
    hull.position.y = 0.25;
    const band = new Mesh(new BoxGeometry(1.84, 0.12, 2.6), stripe);
    band.position.set(0, 0.45, 0.95);
    const deck = new Mesh(new BoxGeometry(1.6, 0.06, 2.4), deckMat);
    deck.position.set(0, 0.67, 0.9);
    const cabin = new Mesh(new BoxGeometry(1.2, 0.7, 1.3), hullMat);
    cabin.position.set(0, 1.0, 0.5);
    this.boat.add(hull, band, deck, cabin);
    // The boat's lamp is one of the night lights' pool (nightLights.ts), in the scene root: a
    // light inside this group, which is hidden in flight, would drop out of three's light list
    // and recompile every material at each landing.

    for (const m of [...this.glider.children, ...this.boat.children]) {
      m.castShadow = true;
      m.traverse((c) => (c.castShadow = true));
    }
    this.group.add(this.glider, this.boat);
  }

  update(st: State, _dt: number): void {
    const v = st.vehicle;
    this.group.position.set(v.x, v.y, v.z);
    this.group.rotation.set(v.pitch, -v.heading, -v.roll, "YXZ");

    const glider = Math.max(0.001, 1 - v.boatness);
    const boat = Math.max(0.001, v.boatness);
    this.glider.scale.setScalar(glider);
    this.glider.visible = glider > 0.01;
    this.boat.scale.setScalar(boat);
    this.boat.visible = boat > 0.01;
    this.boat.position.y = Math.sin(st.t * 1.7) * 0.06;

    // The navigation lights brighten into the night, enough for the bloom to catch them.
    const k = 0.7 + 3.3 * SHARED.uNight.value;
    for (const m of this.navMat) m.color.copy(m.userData.base as Color).multiplyScalar(k);
  }
}
