// The far field (tools/build-far.ts): the city, the hills and the river beyond the world, out
// into the haze. Loaded after the first frame; until it arrives the world ends in its apron
// and flat frame, which it then replaces.
//   - Terrain: the box's 40 m grid and the wide square's 160 m grid, as chunks whose detail
//     falls with their distance from the world (40 m near it, 160 m and 320 m far off), with
//     skirts so neighbouring levels never show a crack; coloured from the painted ground
//     textures (alpha is the street light, lit at night).
//   - Buildings: extruded in a worker (farWorker.ts) per 1 km tile, flat-shaded, roofs told
//     from walls by their slope; windows drawn in the shader, dark by day and lit at random
//     after dusk; a tile is drawn within QUALITY.far metres.
//   - Water (the river's material), bridges, towers; the bridges' lamps and the aviation
//     lights as points, the beacons blinking.
// All of it on LAYER.far, which the planar reflection leaves out, and none of it in shadow.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  type Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
  Points,
  RepeatWrapping,
  ShaderMaterial,
  SRGBColorSpace,
  Texture,
  Vector4,
  type WebGLRenderer,
  type Scene,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { QUALITY } from "../config";
import type { Bounds } from "./bounds";
import { FAR_ROOFS, FAR_WALLS } from "./farFormat";
import type { FarTileMessage } from "./farWorker";
import { decodeGrid, type Grid } from "./gridFile";
import { SHARED } from "./night";
import { HASH_GLSL, patchMaterial } from "./shaderPatch";
import { LAYER } from "./water";

const FILES = ["far/terrain.bin", "far/wide.bin", "far/ground.webp", "far/wide.webp", "far/buildings.bin", "far/structures.glb"] as const;

interface HeightGrid {
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
  h: Float32Array;
}

function heights(grid: Grid): HeightGrid {
  const hd = grid.header;
  const raw = grid.layers.height;
  const scale = hd.layers[0].scale ?? 1;
  const h = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) h[i] = raw[i] * scale;
  return { x0: hd.x0, z0: hd.z0, cell: hd.cell, nx: hd.nx, nz: hd.nz, h };
}

/** A rectangle (x0, z0, x1, z1). */
type Rect = [number, number, number, number];
const distToRect = (x: number, z: number, r: Rect) => Math.hypot(Math.max(r[0] - x, 0, x - r[2]), Math.max(r[1] - z, 0, z - r[3]));

/**
 * Chunks of a height grid: `chunk` cells square, at a step chosen by `step(distance to the
 * world)`, leaving out the cells inside `hole` (shrunk by a cell, so the meshes overlap a
 * little under whatever covers the hole), each with a 25 m skirt.
 */
function terrainChunks(g: HeightGrid, chunk: number, hole: Rect, step: (d: number) => number, world: Rect, material: Material): Mesh[] {
  const out: Mesh[] = [];
  const at = (i: number, j: number) => g.h[Math.min(g.nz - 1, Math.max(0, j)) * g.nx + Math.min(g.nx - 1, Math.max(0, i))];
  const inner: Rect = [hole[0] + g.cell, hole[1] + g.cell, hole[2] - g.cell, hole[3] - g.cell];
  for (let cj = 0; cj < g.nz - 1; cj += chunk)
    for (let ci = 0; ci < g.nx - 1; ci += chunk) {
      const i1 = Math.min(ci + chunk, g.nx - 1);
      const j1 = Math.min(cj + chunk, g.nz - 1);
      const cx0 = g.x0 + ci * g.cell;
      const cz0 = g.z0 + cj * g.cell;
      const cx1 = g.x0 + i1 * g.cell;
      const cz1 = g.z0 + j1 * g.cell;
      if (cx0 >= inner[0] && cx1 <= inner[2] && cz0 >= inner[1] && cz1 <= inner[3]) continue;
      const d = distToRect((cx0 + cx1) / 2, (cz0 + cz1) / 2, world) - (Math.hypot(cx1 - cx0, cz1 - cz0) / 2);
      const s = step(Math.max(0, d));
      const cols: number[] = [];
      for (let i = ci; i < i1; i += s) cols.push(i);
      cols.push(i1);
      const rows: number[] = [];
      for (let j = cj; j < j1; j += s) rows.push(j);
      rows.push(j1);
      const nc = cols.length;
      const nr = rows.length;
      const pos = new Float32Array((nc * nr + 2 * (nc + nr)) * 3);
      const nor = new Float32Array(pos.length);
      let v = 0;
      const put = (i: number, j: number, drop: number) => {
        const x = g.x0 + i * g.cell;
        const z = g.z0 + j * g.cell;
        pos.set([x, at(i, j) - drop, z], v * 3);
        // Normal from the grid at this level's spacing.
        const sx = (at(i + s, j) - at(i - s, j)) / (2 * s * g.cell);
        const sz = (at(i, j + s) - at(i, j - s)) / (2 * s * g.cell);
        const l = Math.hypot(sx, 1, sz);
        nor.set([-sx / l, 1 / l, -sz / l], v * 3);
        return v++;
      };
      for (const j of rows) for (const i of cols) put(i, j, 0);
      const idx: number[] = [];
      for (let r = 0; r + 1 < nr; r++)
        for (let c = 0; c + 1 < nc; c++) {
          const x0 = g.x0 + cols[c] * g.cell;
          const x1 = g.x0 + cols[c + 1] * g.cell;
          const z0 = g.z0 + rows[r] * g.cell;
          const z1 = g.z0 + rows[r + 1] * g.cell;
          if (x0 >= inner[0] && x1 <= inner[2] && z0 >= inner[1] && z1 <= inner[3]) continue;
          const a = r * nc + c;
          // +x east, +z south: this winding faces up.
          idx.push(a, a + nc, a + 1, a + 1, a + nc, a + nc + 1);
        }
      if (!idx.length) continue;
      // Skirts down the four edges, facing out.
      const edge = (list: [number, number][], flip: boolean) => {
        let prev = -1;
        let prevDown = -1;
        for (const [i, j] of list) {
          const up = (rows.indexOf(j) * nc + cols.indexOf(i)) as number;
          const down = put(i, j, 25);
          if (prev >= 0) {
            if (flip) idx.push(prev, up, prevDown, up, down, prevDown);
            else idx.push(prev, prevDown, up, up, prevDown, down);
          }
          prev = up;
          prevDown = down;
        }
      };
      edge(cols.map((i) => [i, rows[0]]), true);
      edge(cols.map((i) => [i, rows[nr - 1]]), false);
      edge(rows.map((j) => [cols[0], j]), false);
      edge(rows.map((j) => [cols[nc - 1], j]), true);
      const geo = new BufferGeometry();
      geo.setAttribute("position", new BufferAttribute(pos.slice(0, v * 3), 3));
      geo.setAttribute("normal", new BufferAttribute(nor.slice(0, v * 3), 3));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      const mesh = new Mesh(geo, material);
      mesh.matrixAutoUpdate = false;
      mesh.name = "far terrain";
      out.push(mesh);
    }
  return out;
}

const LAMP = new Color("#ffb769");

function terrainMaterial(ground: Texture, wide: Texture, box: Rect, wideRect: Rect): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ roughness: 1, metalness: 0, name: "far terrain" });
  patchMaterial(mat, {
    key: "far-terrain",
    uniforms: {
      uGround: { value: ground },
      uWide: { value: wide },
      uBox: { value: new Vector4(box[0], box[1], box[2] - box[0], box[3] - box[1]) },
      uWideRect: { value: new Vector4(wideRect[0], wideRect[1], wideRect[2] - wideRect[0], wideRect[3] - wideRect[1]) },
      uNight: SHARED.uNight,
      uLamp: { value: LAMP.clone().multiplyScalar(1.4) },
    },
    vertexPars: "varying vec2 vFarXZ;",
    vertex: [["begin_vertex", "vFarXZ = (modelMatrix * vec4(transformed, 1.0)).xz;"]],
    fragmentPars: `uniform sampler2D uGround;\nuniform sampler2D uWide;\nuniform vec4 uBox;\nuniform vec4 uWideRect;\nuniform float uNight;\nuniform vec3 uLamp;\nvarying vec2 vFarXZ;\nvec4 farGround;\n${HASH_GLSL}`,
    fragment: [
      [
        "color_fragment",
        /* glsl */ `
        {
          vec2 ub = (vFarXZ - uBox.xy) / uBox.zw;
          vec2 uw = (vFarXZ - uWideRect.xy) / uWideRect.zw;
          // The box's texture inside it, fading to the wide one over its last 2 %.
          vec2 e = min(ub, 1.0 - ub);
          float inBox = smoothstep(0.0, 0.02, min(e.x, e.y));
          farGround = mix(texture2D(uWide, uw), texture2D(uGround, ub), inBox);
          // Break the texels up close to.
          float n = vnoise(vFarXZ / 6.0) * 0.6 + vnoise(vFarXZ / 23.0) * 0.4;
          diffuseColor.rgb = farGround.rgb * (0.86 + 0.28 * n);
        }`,
      ],
      ["emissivemap_fragment", "totalEmissiveRadiance += uLamp * farGround.a * farGround.a * uNight * (0.6 + 0.8 * vnoise(vFarXZ / 9.0));"],
    ],
  });
  return mat;
}

/** The far buildings' material: palette colours, windows by storey and bay, lit at random at night. */
function buildingMaterial(): MeshStandardMaterial {
  const mat = new MeshStandardMaterial({ roughness: 0.85, metalness: 0, flatShading: true, name: "far buildings" });
  const walls = FAR_WALLS.map((c) => new Color(c));
  const roofs = FAR_ROOFS.map((c) => new Color(c));
  patchMaterial(mat, {
    key: "far-buildings",
    uniforms: { uWalls: { value: walls }, uRoofs: { value: roofs }, uNight: SHARED.uNight, uWarm: { value: new Color("#ffc98a") } },
    vertexPars: "attribute vec4 aInfo;\nattribute float aBase;\nflat varying vec4 vInfo;\nflat varying float vBase;\nvarying vec3 vFarPos;",
    vertex: [["begin_vertex", "vInfo = aInfo;\nvBase = aBase;\nvFarPos = (modelMatrix * vec4(transformed, 1.0)).xyz;"]],
    fragmentPars: `uniform vec3 uWalls[${walls.length}];\nuniform vec3 uRoofs[${roofs.length}];\nuniform float uNight;\nuniform vec3 uWarm;\nflat varying vec4 vInfo;\nflat varying float vBase;\nvarying vec3 vFarPos;\nvec3 farLit = vec3(0.0);\n${HASH_GLSL}`,
    fragment: [
      [
        "normal_fragment_maps",
        /* glsl */ `
        {
          vec3 wn = inverseTransformDirection(normal, viewMatrix);
          if (wn.y > 0.5) {
            diffuseColor.rgb = uRoofs[int(vInfo.y)] * (0.9 + 0.2 * hash12(vec2(vInfo.z, vInfo.x)));
          } else {
            // Darker toward the street, as the world's canyons are.
            vec3 wall = uWalls[int(vInfo.x)] * mix(0.55, 0.92, smoothstep(0.0, 14.0, vFarPos.y - vBase));
            // Storeys of 3.3 m from the base, bays of 3.4 m along the wall.
            vec2 t = normalize(vec2(-wn.z, wn.x) + 1e-5);
            float storey = (vFarPos.y - vBase) / 3.3;
            float bay = dot(vFarPos.xz, t) / 3.4;
            vec2 cell = vec2(fract(bay), fract(storey));
            float win = step(0.24, cell.x) * step(cell.x, 0.76) * step(0.3, cell.y) * step(cell.y, 0.74) * step(1.0, storey);
            // Fade the pattern to its average where a window is smaller than a pixel.
            float px = max(fwidth(storey), fwidth(bay));
            float sharp = clamp(1.6 - px * 2.2, 0.0, 1.0);
            float glass = mix(0.14 * step(1.0, storey), win, sharp);
            diffuseColor.rgb = mix(wall, wall * 0.32 + vec3(0.02, 0.025, 0.03), glass * 0.85);
            // At night a third of the windows are lit, warmer and dimmer at random; shopfronts below.
            float on = step(hash12(floor(vec2(bay, storey)) + vInfo.z * 3.17), 0.32) * (0.5 + 0.5 * hash12(floor(vec2(bay, storey)) * 1.7 + 4.1));
            float lit = mix(0.32 * 0.75 * step(1.0, storey), win * on, sharp);
            float shop = (1.0 - step(1.0, storey)) * step(0.15, cell.y) * step(cell.y, 0.85) * 0.6;
            farLit = uWarm * (lit * 0.9 + shop) * uNight;
          }
        }`,
      ],
      ["emissivemap_fragment", "totalEmissiveRadiance += farLit;"],
    ],
  });
  return mat;
}

/** Glowing points (bridge lamps, aviation lights) that show after dusk; `blink` flashes them. */
function lightPoints(flat: number[], color: string, size: number, blink: boolean): Points {
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(flat), 3));
  const phase = new Float32Array(flat.length / 3);
  for (let i = 0; i < phase.length; i++) phase[i] = (i * 0.618) % 1;
  geo.setAttribute("aPhase", new BufferAttribute(phase, 1));
  const mat = new ShaderMaterial({
    uniforms: { uNight: SHARED.uNight, uTime: SHARED.uTime, uColor: { value: new Color(color) }, uSize: { value: size }, uScale: { value: 800 } },
    vertexShader: /* glsl */ `
      attribute float aPhase;
      uniform float uSize;
      uniform float uScale;
      uniform float uTime;
      varying float vOn;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(uSize * uScale / -mv.z, 1.5, 9.0);
        vOn = ${blink ? "step(0.82, fract(uTime * 0.75 + aPhase))" : "1.0"};
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uNight;
      varying float vOn;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, r);
        gl_FragColor = vec4(uColor * 4.0 * a * vOn * uNight, 1.0);
      }`,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
  const pts = new Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

export class Far {
  readonly group = new Group();
  private readonly tiles: { mesh: Mesh; x: number; z: number; r: number }[] = [];
  buildings = 0;
  private lights: Points[] = [];

  private constructor() {
    this.group.name = "far field";
  }

  /** Loads and builds the far field; `water` is the river's material, for the water beyond the world. */
  static async load(renderer: WebGLRenderer, world: Bounds, water: Material, get: (file: string) => Promise<ArrayBuffer>): Promise<Far> {
    const far = new Far();
    const [terrainBytes, wideBytes, groundBytes, wideTexBytes, buildingBytes, structureBytes] = await Promise.all(FILES.map((f) => get(f)));
    const texture = async (bytes: ArrayBuffer) => {
      const img = await createImageBitmap(new Blob([bytes], { type: "image/webp" }), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
      const tex = new Texture(img);
      tex.colorSpace = SRGBColorSpace;
      tex.flipY = false;
      tex.wrapS = tex.wrapT = RepeatWrapping;
      tex.minFilter = LinearMipmapLinearFilter;
      tex.magFilter = LinearFilter;
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      tex.needsUpdate = true;
      return tex;
    };
    const [ground, wideTex] = await Promise.all([texture(groundBytes), texture(wideTexBytes)]);
    const box = heights(decodeGrid(terrainBytes));
    const wide = heights(decodeGrid(wideBytes));
    const boxRect: Rect = [box.x0, box.z0, box.x0 + (box.nx - 1) * box.cell, box.z0 + (box.nz - 1) * box.cell];
    const wideRect: Rect = [wide.x0, wide.z0, wide.x0 + (wide.nx - 1) * wide.cell, wide.z0 + (wide.nz - 1) * wide.cell];
    const worldRect: Rect = [world.x0, world.z0, world.x1, world.z1];

    // Terrain: 40 m within 2 km of the world, 80 m to 6 km, 160 m beyond; the wide square 160 m, 320 m past 4 km from the box.
    const tmat = terrainMaterial(ground, wideTex, boxRect, wideRect);
    for (const m of terrainChunks(box, 32, worldRect, (d) => (d < 2000 ? 1 : d < 6000 ? 2 : 4), worldRect, tmat)) far.group.add(m);
    for (const m of terrainChunks(wide, 16, boxRect, (d) => (d < 4000 ? 1 : 2), boxRect, tmat)) far.group.add(m);

    // Water, bridges, towers, and the lights.
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(structureBytes, "data/");
    gltf.scene.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      if ((mesh.material as Material).name === "water") {
        mesh.material = water;
        mesh.layers.set(LAYER.water);
      } else {
        const m = mesh.material as MeshStandardMaterial;
        m.vertexColors = true;
        m.flatShading = false;
      }
      mesh.frustumCulled = true;
    });
    far.group.add(gltf.scene);
    const extras = gltf.scene.userData as { lamps?: number[]; beacons?: number[] };
    if (extras.lamps?.length) far.lights.push(lightPoints(extras.lamps, "#ffcf87", 2.2, false));
    if (extras.beacons?.length) far.lights.push(lightPoints(extras.beacons, "#ff2a1a", 3.5, true));
    for (const p of far.lights) far.group.add(p);

    // Buildings, from the worker, a tile at a time.
    const bmat = buildingMaterial();
    await new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL("./farWorker.ts", import.meta.url), { type: "module" });
      worker.onerror = (e) => reject(new Error(`far buildings: ${e.message}`));
      worker.onmessage = (e: MessageEvent<FarTileMessage | { done: true }>) => {
        if ("done" in e.data) {
          worker.terminate();
          resolve();
          return;
        }
        const t = e.data;
        const geo = new BufferGeometry();
        geo.setAttribute("position", new BufferAttribute(t.position, 3));
        geo.setAttribute("aInfo", new BufferAttribute(t.info, 4));
        geo.setAttribute("aBase", new BufferAttribute(t.base, 1));
        geo.setIndex(new BufferAttribute(t.index, 1));
        geo.computeBoundingSphere();
        const mesh = new Mesh(geo, bmat);
        mesh.position.set(t.x, 0, t.z);
        mesh.updateMatrix();
        mesh.matrixAutoUpdate = false;
        mesh.name = "far buildings";
        const s = geo.boundingSphere!;
        far.tiles.push({ mesh, x: t.x + s.center.x, z: t.z + s.center.z, r: s.radius });
        far.buildings += t.buildings;
        far.group.add(mesh);
      };
      worker.postMessage({ bytes: buildingBytes }, [buildingBytes]);
    });

    far.group.traverse((o: Object3D) => {
      o.layers.set(o.layers.isEnabled(LAYER.water) ? LAYER.water : LAYER.far);
      o.castShadow = false;
      o.receiveShadow = false;
      o.updateMatrix();
    });
    far.group.updateMatrixWorld(true);
    return far;
  }

  /** Compiles the far field's programs off the frame (where the browser can), before it's shown. */
  async compile(renderer: WebGLRenderer, camera: PerspectiveCamera, scene: Scene): Promise<void> {
    await renderer.compileAsync(this.group, camera, scene);
  }

  /** Building tiles within QUALITY.far of the camera; the lights' size by the screen's height. */
  update(camera: PerspectiveCamera, screenHeight: number): void {
    const range = QUALITY.far;
    const p = camera.position;
    for (const t of this.tiles) t.mesh.visible = Math.hypot(t.x - p.x, t.z - p.z) - t.r < range;
    const scale = screenHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    for (const l of this.lights) (l.material as ShaderMaterial).uniforms.uScale.value = scale;
  }

  describe(): string {
    const shown = this.tiles.filter((t) => t.mesh.visible).length;
    return `far: ${this.buildings} buildings in ${this.tiles.length} tiles (${shown} drawn), ${this.group.children.length} objects`;
  }
}
