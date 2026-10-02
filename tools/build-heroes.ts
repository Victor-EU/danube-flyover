// Step 5: the hero landmarks, modelled in code (tools/heroes/) on their
// OSM footprints and bridges.json, one meshopt-compressed glb each in public/data/heroes/.
// Also writes tools/out/heroes.json for build-city (the footprints the filler city and the
// trees keep clear of) and build-floor (the cells each hero raises, at its triangles' tops).
// Usage: npm run build-heroes [-- <landmark id>]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { FLOOR_CELL } from "../src/world/floor";
import { worldBounds } from "../src/world/bounds";
import { distToSegment, type Pt } from "./lib/geom";
import { writeGlb } from "./lib/gltf";
import { kb, ODBL } from "./lib/io";
import { HeroContext } from "./heroes/context";
import type { Model } from "./heroes/kit";
import { elisabethBridge, libertyBridge, margaretBridge } from "./heroes/bridges";
import { bastion, matthias, palace } from "./heroes/castleHill";
import { chainBridge } from "./heroes/chainBridge";
import { citadella, gellertHotel, libertyStatue } from "./heroes/gellertHill";
import { parliament } from "./heroes/parliament";
import { academy, gresham, marketHall, shoes, vigado } from "./heroes/pest";

/** Builders by landmark id. Bridges stay out of the floor grid (their decks are tested directly). */
const BUILDERS: Record<string, { build: (ctx: HeroContext) => Model[]; floor: boolean }> = {
  // The ten heroes, in the design's order: Parliament, the Chain Bridge, then the route's.
  parliament: { build: parliament, floor: true },
  chainBridge: { build: chainBridge, floor: false },
  margaretBridge: { build: margaretBridge, floor: false },
  bastion: { build: bastion, floor: true },
  matthias: { build: matthias, floor: true },
  palace: { build: palace, floor: true },
  elisabethBridge: { build: elisabethBridge, floor: false },
  libertyStatue: { build: libertyStatue, floor: true },
  gellertHotel: { build: gellertHotel, floor: true },
  libertyBridge: { build: libertyBridge, floor: false },
  marketHall: { build: marketHall, floor: true },
  // The other landmarks, with the same kit.
  shoes: { build: shoes, floor: false },
  academy: { build: academy, floor: true },
  gresham: { build: gresham, floor: true },
  vigado: { build: vigado, floor: true },
  citadella: { build: citadella, floor: true },
};

const MAX_TRIANGLES = 20000;
const ctx = new HeroContext();
const b0 = worldBounds();
const nx = Math.ceil((b0.x1 - b0.x0) / FLOOR_CELL);
const HALF_DIAG = (FLOOR_CELL * Math.SQRT2) / 2;

/** True if (x, z) is inside triangle abc or within d of its edges. */
function nearTriangle(x: number, z: number, a: Pt, b: Pt, c: Pt, d: number): boolean {
  const s1 = (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]);
  const s2 = (c[0] - b[0]) * (z - b[1]) - (c[1] - b[1]) * (x - b[0]);
  const s3 = (a[0] - c[0]) * (z - c[1]) - (a[1] - c[1]) * (x - c[0]);
  if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;
  return Math.min(distToSegment(x, z, a, b), distToSegment(x, z, b, c), distToSegment(x, z, c, a)) <= d;
}
const OUT = new URL("./out/heroes.json", import.meta.url);
// Building one hero (npm run build-heroes -- <id>) keeps the others' entries.
const only = process.argv[2];
const out: Record<string, { rings: number[][]; cells: number[] }> = only && existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")).heroes : {};
mkdirSync(new URL("../public/data/heroes/", import.meta.url), { recursive: true });

for (const [id, def] of Object.entries(BUILDERS)) {
  if (only && id !== only) continue;
  const models = def.build(ctx);
  const tris = models.reduce((s, m) => s + m.triangles, 0);
  const bytes = await writeGlb(`heroes/${id}.glb`, models.map((m) => m.toMesh()), { license: ODBL, hero: id });
  // The floor: every cell whose centre is within half a cell's diagonal of a triangle (seen
  // from above), at that triangle's top.
  const cells = new Map<number, number>();
  if (def.floor)
    for (const m of models) {
      const t = m.worldTriangles();
      for (let k = 0; k < t.length; k += 9) {
        const a: Pt = [t[k], t[k + 2]];
        const b: Pt = [t[k + 3], t[k + 5]];
        const c: Pt = [t[k + 6], t[k + 8]];
        const top = Math.max(t[k + 1], t[k + 4], t[k + 7]);
        const i0 = Math.floor((Math.min(a[0], b[0], c[0]) - HALF_DIAG - b0.x0) / FLOOR_CELL);
        const i1 = Math.floor((Math.max(a[0], b[0], c[0]) + HALF_DIAG - b0.x0) / FLOOR_CELL);
        const j0 = Math.floor((Math.min(a[1], b[1], c[1]) - HALF_DIAG - b0.z0) / FLOOR_CELL);
        const j1 = Math.floor((Math.max(a[1], b[1], c[1]) + HALF_DIAG - b0.z0) / FLOOR_CELL);
        for (let j = j0; j <= j1; j++)
          for (let i = i0; i <= i1; i++) {
            const x = b0.x0 + (i + 0.5) * FLOOR_CELL;
            const z = b0.z0 + (j + 0.5) * FLOOR_CELL;
            if (!nearTriangle(x, z, a, b, c, HALF_DIAG)) continue;
            const key = j * nx + i;
            cells.set(key, Math.max(cells.get(key) ?? -Infinity, top));
          }
      }
    }
  const flat: number[] = [];
  for (const [k, top] of cells) flat.push(k % nx, Math.floor(k / nx), Math.round(top * 10) / 10);
  const rings = (ctx.landmark(id).osm ?? []).flatMap((o) => ctx.footprint(o).map((p) => p[0].flatMap(([x, z]) => [Math.round(x * 100) / 100, Math.round(z * 100) / 100])));
  out[id] = { rings, cells: flat };
  const warn = tris > MAX_TRIANGLES ? `  (over the ${MAX_TRIANGLES} budget)` : "";
  console.log(`heroes/${id}.glb ${kb(bytes)}, ${tris} triangles, ${cells.size} floor cells${warn}`);
}

mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
writeFileSync(OUT, JSON.stringify({ cell: FLOOR_CELL, nx, heroes: out }));
