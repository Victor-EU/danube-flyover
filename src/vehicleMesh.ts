// The one vehicle with two states: a low-poly gull and a small boat, scaled in and out of
// each other behind the splash. Both face -Z in their local space.

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  ConeGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  PointLight,
} from "three";
import type { State } from "./state";

const SCALE = 2; // stylised: big enough to read 12 m in front of the camera

function wingGeometry(side: 1 | -1): BufferGeometry {
  // A swept, tapered wing from the shoulder outwards, with a dark tip.
  const s = side;
  const pos = new Float32Array([
    0, 0, -0.18, s * 0.75, 0.03, -0.1, 0, 0, 0.22, // inner panel
    s * 0.75, 0.03, -0.1, s * 0.72, 0.03, 0.16, 0, 0, 0.22,
    s * 0.75, 0.03, -0.1, s * 1.45, 0.06, 0.08, s * 0.72, 0.03, 0.16, // tip
  ]);
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  const col = new Float32Array(27);
  for (let i = 0; i < 9; i++) col.set(i >= 6 ? [0.18, 0.18, 0.2] : [0.62, 0.65, 0.7], i * 3);
  geo.setAttribute("color", new BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

export class VehicleMesh {
  readonly group = new Group();
  private readonly bird = new Group();
  private readonly boat = new Group();
  private readonly wings: Group[] = [];
  private readonly boatLight = new PointLight("#ffd9a0", 0, 40, 2);
  private flap = 0;

  constructor() {
    const white = new MeshStandardMaterial({ color: "#f4f2ec", roughness: 0.7, flatShading: true });
    const wingMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true, side: DoubleSide });
    const beak = new MeshStandardMaterial({ color: "#e8b13a", roughness: 0.6, flatShading: true });

    const body = new Mesh(new OctahedronGeometry(0.5, 0), white);
    body.scale.set(0.32, 0.3, 1.1);
    const head = new Mesh(new OctahedronGeometry(0.16, 0), white);
    head.position.set(0, 0.08, -0.52);
    const bill = new Mesh(new ConeGeometry(0.04, 0.16, 4), beak);
    bill.rotation.x = -Math.PI / 2;
    bill.position.set(0, 0.06, -0.7);
    const tail = new Mesh(new ConeGeometry(0.16, 0.36, 3), white);
    tail.rotation.x = Math.PI / 2;
    tail.scale.set(1.4, 1, 0.3);
    tail.position.set(0, 0, 0.6);
    this.bird.add(body, head, bill, tail);
    for (const side of [1, -1] as const) {
      const pivot = new Group();
      pivot.position.set(side * 0.1, 0.05, -0.05);
      pivot.add(new Mesh(wingGeometry(side), wingMat));
      this.bird.add(pivot);
      this.wings.push(pivot);
    }
    this.bird.scale.setScalar(SCALE);

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
    // The lamp hangs off the always-visible group, not the boat, and casts no shadow: a light
    // inside a hidden group drops out of three's light list, so a change in the light count
    // recompiled every material at each landing, and the shadow it had picked up from the
    // castShadow loop below was never rendered at night (black frames on the boat).
    this.boatLight.position.set(0, 2.2, 0.4);
    this.group.add(this.boatLight);

    for (const m of [...this.bird.children, ...this.boat.children]) {
      m.castShadow = true;
      m.traverse((c) => (c.castShadow = true));
    }
    this.group.add(this.bird, this.boat);
  }

  update(st: State, dt: number): void {
    const v = st.vehicle;
    this.group.position.set(v.x, v.y, v.z);
    this.group.rotation.set(v.pitch, -v.heading, -v.roll, "YXZ");

    const bird = Math.max(0.001, 1 - v.boatness);
    const boat = Math.max(0.001, v.boatness);
    this.bird.scale.setScalar(SCALE * bird);
    this.bird.visible = bird > 0.01;
    this.boat.scale.setScalar(boat);
    this.boat.visible = boat > 0.01;
    this.boat.position.y = Math.sin(st.t * 1.7) * 0.06;

    // Flap harder when climbing or hovering, glide when diving.
    const hover = st.autopilot.holdLeft > 0;
    const rate = hover ? 3.2 : v.vSpeed > 1 ? 2.6 : v.vSpeed < -3 ? 0.4 : 1.6;
    const amp = hover ? 0.75 : v.vSpeed < -3 ? 0.08 : 0.45;
    this.flap += dt * rate * Math.PI * 2;
    const a = Math.sin(this.flap) * amp;
    this.wings[0].rotation.z = a;
    this.wings[1].rotation.z = -a;

    // The boat's lamp is the pooled warm light; it fades in after sunset.
    this.boatLight.intensity = v.boatness * Math.min(1, Math.max(0, -st.sun.elevation / 6)) * 6;
  }
}
