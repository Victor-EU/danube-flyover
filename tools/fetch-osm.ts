// Step 1 of the M1 pipeline: fetches the OpenStreetMap layers the world is built from and saves
// them as GeoJSON under tools/osm/ (committed, so the later steps run offline).
// Data © OpenStreetMap contributors, ODbL 1.0. See tools/osm/README.md.
// Usage: npm run fetch-osm [-- group ...]   (default: every group)

import { mkdirSync, writeFileSync } from "node:fs";
import osmtogeojson from "osmtogeojson";
import { WORLD } from "../src/config";

const OUT = new URL("./osm/", import.meta.url);
const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const USER_AGENT = "danube-flyover-pipeline/0.1 (offline asset build; one fetch per group)";

// A little wider than the world, so rings crossing the edge are complete before clipping.
const PAD = 0.004;
const BBOX = [WORLD.latMin - PAD, WORLD.lonMin - PAD, WORLD.latMax + PAD, WORLD.lonMax + PAD].join(",");

/** Tags kept per group; everything else is dropped to keep the committed extracts small. */
const COMMON = ["name", "name:en"];
const GROUPS: Record<string, { query: string; tags: string[] }> = {
  buildings: {
    query: `(way["building"](${BBOX}); relation["building"]["type"="multipolygon"](${BBOX}););`,
    tags: ["building", "height", "building:levels", "roof:levels", "min_height", "building:min_level", "roof:shape", "roof:colour", "building:colour", "amenity", "historic", "tourism"],
  },
  water: {
    query: `(way["natural"="water"](${BBOX}); relation["natural"="water"](${BBOX}); way["waterway"="riverbank"](${BBOX}); relation["waterway"="riverbank"](${BBOX}); way["waterway"="river"](${BBOX}););`,
    tags: ["natural", "water", "waterway"],
  },
  bridges: {
    query: `(way["man_made"="bridge"](${BBOX}); relation["man_made"="bridge"](${BBOX}); way["bridge"]["highway"](${BBOX}); way["bridge"]["railway"](${BBOX}); way["bridge:support"](${BBOX}); node["bridge:support"](${BBOX}););`,
    tags: ["man_made", "bridge", "bridge:support", "bridge:name", "bridge:structure", "highway", "railway", "layer", "width", "lanes", "oneway", "tunnel"],
  },
  landcover: {
    query: `(way["leisure"~"^(park|garden|playground|pitch|stadium|golf_course)$"](${BBOX}); relation["leisure"~"^(park|garden)$"](${BBOX}); way["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery|village_green|allotments|orchard|vineyard)$"](${BBOX}); relation["landuse"~"^(forest|grass|recreation_ground)$"](${BBOX}); way["natural"~"^(wood|scrub|grassland|heath|bare_rock)$"](${BBOX}); relation["natural"~"^(wood|scrub)$"](${BBOX}); way["place"="square"](${BBOX}); way["highway"="pedestrian"]["area"="yes"](${BBOX}););`,
    tags: ["leisure", "landuse", "natural", "place", "highway", "area", "surface"],
  },
  trees: {
    query: `(node["natural"="tree"](${BBOX}); way["natural"="tree_row"](${BBOX}););`,
    tags: ["natural", "leaf_type", "genus", "species", "height"],
  },
  districts: {
    query: `relation["boundary"="administrative"]["admin_level"="9"](${BBOX});`,
    tags: ["admin_level", "boundary", "ref"],
  },
  trams: {
    query: `way["railway"="tram"](${BBOX});`,
    tags: ["railway", "bridge", "tunnel", "layer"],
  },
};

type Json = Record<string, unknown>;

async function overpass(query: string): Promise<Json> {
  const body = new URLSearchParams({ data: `[out:json][timeout:180];${query}out geom;` });
  let lastError = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(url, { method: "POST", body, headers: { "User-Agent": USER_AGENT } });
      if (res.ok) return (await res.json()) as Json;
      lastError = `${url} answered ${res.status}`;
    } catch (err) {
      lastError = `${url}: ${err instanceof Error ? err.message : String(err)}`;
    }
    const wait = 5000 * (attempt + 1);
    console.warn(`  ${lastError}; retrying in ${wait / 1000} s`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error(`Overpass failed: ${lastError}`);
}

/** Rounds coordinates to 7 decimals (about 1 cm) in place. */
function roundCoords(c: unknown): unknown {
  if (typeof c === "number") return Math.round(c * 1e7) / 1e7;
  if (Array.isArray(c)) return c.map(roundCoords);
  return c;
}

interface Feature {
  type: "Feature";
  id?: string;
  properties: Json;
  geometry: { type: string; coordinates: unknown };
}

async function fetchGroup(name: string): Promise<void> {
  const group = GROUPS[name];
  const t0 = Date.now();
  const raw = await overpass(group.query);
  const timestamp = (raw.osm3s as Json | undefined)?.timestamp_osm_base;
  const gj = osmtogeojson(raw as never, { flatProperties: true }) as unknown as { features: Feature[] };
  const keep = new Set([...COMMON, ...group.tags]);
  const features = gj.features
    .filter((f) => f.geometry)
    .map((f): Feature => {
      const props: Json = { id: f.properties.id ?? f.id };
      for (const [k, v] of Object.entries(f.properties)) if (keep.has(k)) props[k] = v;
      return { type: "Feature", properties: props, geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates) } };
    })
    .sort((a, b) => String(a.properties.id).localeCompare(String(b.properties.id)));
  const out = { type: "FeatureCollection", license: "ODbL-1.0, © OpenStreetMap contributors", osm_base: timestamp, bbox: BBOX, features };
  // One feature per line: readable diffs when the extract is refreshed.
  const text = `{"type":"FeatureCollection","license":${JSON.stringify(out.license)},"osm_base":${JSON.stringify(timestamp)},"bbox":${JSON.stringify(BBOX)},"features":[\n${features.map((f) => JSON.stringify(f)).join(",\n")}\n]}\n`;
  writeFileSync(new URL(`${name}.geojson`, OUT), text);
  console.log(`${name}: ${features.length} features, ${(text.length / 1e6).toFixed(2)} MB, ${((Date.now() - t0) / 1000).toFixed(1)} s (OSM ${timestamp})`);
}

mkdirSync(OUT, { recursive: true });
const wanted = process.argv.slice(2);
for (const name of wanted.length ? wanted : Object.keys(GROUPS)) {
  if (!GROUPS[name]) throw new Error(`Unknown group "${name}". Groups: ${Object.keys(GROUPS).join(", ")}`);
  await fetchGroup(name);
  // Overpass asks for gaps between heavy queries.
  await new Promise((r) => setTimeout(r, 2000));
}
