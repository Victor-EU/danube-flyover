// Step 1 of the M1 pipeline: fetches the OpenStreetMap layers the world is built from and saves
// them as GeoJSON under tools/osm/ (committed, so the later steps run offline). `far` fetches
// the far field's layers over FAR.box instead (26 km square, in tiles so each Overpass query
// stays modest), to tools/osm/far/<group>.geojson.gz, with coordinates to about 10 cm.
// Data © OpenStreetMap contributors, ODbL 1.0. See tools/osm/README.md.
// Usage: npm run fetch-osm [-- group ...]   (default: every group)
//        npm run fetch-osm -- far [group ...]

import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import osmtogeojson from "osmtogeojson";
import { FAR, WORLD } from "../src/config";

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
  roads: {
    query: `(way["highway"](${BBOX}); way["area:highway"](${BBOX}); way["amenity"="parking"](${BBOX}); relation["amenity"="parking"](${BBOX}); way["railway"~"^(rail|light_rail|subway|narrow_gauge|funicular)$"](${BBOX}); way["man_made"="pier"](${BBOX}););`,
    tags: ["highway", "area:highway", "area", "lanes", "width", "surface", "oneway", "sidewalk", "sidewalk:both", "sidewalk:left", "sidewalk:right", "cycleway", "bridge", "tunnel", "layer", "junction", "crossing", "footway", "service", "amenity", "parking", "railway", "man_made", "covered", "indoor", "level"],
  },
};

/** The far field's groups: `query(bbox)`, split into `tiles` × `tiles` boxes. */
const FAR_GROUPS: Record<string, { query: (b: string) => string; tags: string[]; tiles: number }> = {
  buildings: {
    query: (b) => `(way["building"](${b}); relation["building"]["type"="multipolygon"](${b}););`,
    tags: ["building", "height", "building:levels", "roof:levels", "min_height", "building:min_level", "roof:shape", "roof:colour", "building:colour", "man_made"],
    tiles: 4,
  },
  roads: {
    query: (b) =>
      `(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|living_street|pedestrian|service)$"](${b}); way["railway"~"^(rail|light_rail|tram|subway|narrow_gauge)$"](${b}););`,
    tags: ["highway", "railway", "service", "bridge", "tunnel", "layer", "lanes", "width", "area"],
    tiles: 2,
  },
  landcover: {
    query: (b) =>
      `(way["landuse"](${b}); relation["landuse"](${b}); way["leisure"~"^(park|garden|pitch|stadium|golf_course|nature_reserve|track)$"](${b}); relation["leisure"~"^(park|garden|nature_reserve)$"](${b}); way["natural"~"^(wood|scrub|grassland|heath|bare_rock|wetland|sand)$"](${b}); relation["natural"~"^(wood|scrub|grassland|wetland)$"](${b}););`,
    tags: ["landuse", "leisure", "natural", "wetland", "surface"],
    tiles: 2,
  },
  water: {
    query: (b) => `(way["natural"="water"](${b}); relation["natural"="water"](${b}); way["waterway"~"^(river|riverbank)$"](${b}); relation["waterway"="riverbank"](${b}););`,
    tags: ["natural", "water", "waterway"],
    tiles: 1,
  },
  towers: {
    query: (b) => `nwr["man_made"~"^(tower|mast|chimney|water_tower|communications_tower)$"](${b});`,
    tags: ["man_made", "tower:type", "tower:construction", "height", "ele", "building", "material", "colour"],
    tiles: 1,
  },
  bridges: {
    query: (b) => `(way["man_made"="bridge"](${b}); relation["man_made"="bridge"](${b}); way["bridge"]["highway"](${b}); way["bridge"]["railway"](${b}););`,
    tags: ["man_made", "bridge", "bridge:structure", "highway", "railway", "layer", "width", "lanes"],
    tiles: 1,
  },
};

type Json = Record<string, unknown>;

async function overpass(query: string): Promise<Json> {
  const body = new URLSearchParams({ data: `[out:json][timeout:300];${query}out geom;` });
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

/** Rounds coordinates to 7 decimals (about 1 cm), or `places`. */
function roundCoords(c: unknown, places = 7): unknown {
  const k = 10 ** places;
  if (typeof c === "number") return Math.round(c * k) / k;
  if (Array.isArray(c)) return c.map((x) => roundCoords(x, places));
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

/** A far-field group, tile by tile, deduplicated (ways crossing tile edges come back twice). */
async function fetchFar(name: string): Promise<void> {
  const group = FAR_GROUPS[name];
  const t0 = Date.now();
  const box = FAR.box;
  const keep = new Set(group.tags);
  const byId = new Map<string, Feature>();
  let timestamp: unknown;
  for (let ty = 0; ty < group.tiles; ty++)
    for (let tx = 0; tx < group.tiles; tx++) {
      const lat0 = box.latMin + ((box.latMax - box.latMin) * ty) / group.tiles;
      const lat1 = box.latMin + ((box.latMax - box.latMin) * (ty + 1)) / group.tiles;
      const lon0 = box.lonMin + ((box.lonMax - box.lonMin) * tx) / group.tiles;
      const lon1 = box.lonMin + ((box.lonMax - box.lonMin) * (tx + 1)) / group.tiles;
      const raw = await overpass(group.query([lat0, lon0, lat1, lon1].map((v) => v.toFixed(5)).join(",")));
      timestamp = (raw.osm3s as Json | undefined)?.timestamp_osm_base;
      const gj = osmtogeojson(raw as never, { flatProperties: true }) as unknown as { features: Feature[] };
      for (const f of gj.features) {
        if (!f.geometry) continue;
        const id = String(f.properties.id ?? f.id);
        if (byId.has(id)) continue;
        const props: Json = { id };
        for (const [k, v] of Object.entries(f.properties)) if (keep.has(k)) props[k] = v;
        byId.set(id, { type: "Feature", properties: props, geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates, 6) } });
      }
      console.log(`  ${name} tile ${ty * group.tiles + tx + 1}/${group.tiles ** 2}: ${byId.size} features so far`);
      if (group.tiles > 1) await new Promise((r) => setTimeout(r, 8000));
    }
  const features = [...byId.values()].sort((a, b) => String(a.properties.id).localeCompare(String(b.properties.id)));
  const bbox = [box.latMin, box.lonMin, box.latMax, box.lonMax].join(",");
  const text = `{"type":"FeatureCollection","license":"ODbL-1.0, © OpenStreetMap contributors","osm_base":${JSON.stringify(timestamp)},"bbox":${JSON.stringify(bbox)},"features":[\n${features.map((f) => JSON.stringify(f)).join(",\n")}\n]}\n`;
  const gz = gzipSync(text, { level: 9 });
  mkdirSync(new URL("far/", OUT), { recursive: true });
  writeFileSync(new URL(`far/${name}.geojson.gz`, OUT), gz);
  console.log(`far ${name}: ${features.length} features, ${(text.length / 1e6).toFixed(1)} MB (${(gz.length / 1e6).toFixed(1)} MB gzipped), ${((Date.now() - t0) / 1000).toFixed(0)} s (OSM ${timestamp})`);
}

mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
if (args[0] === "far") {
  const wantedFar = args.slice(1);
  for (const name of wantedFar.length ? wantedFar : Object.keys(FAR_GROUPS)) {
    if (!FAR_GROUPS[name]) throw new Error(`Unknown far group "${name}". Groups: ${Object.keys(FAR_GROUPS).join(", ")}`);
    await fetchFar(name);
    await new Promise((r) => setTimeout(r, 10000));
  }
  process.exit(0);
}
const wanted = args;
for (const name of wanted.length ? wanted : Object.keys(GROUPS)) {
  if (!GROUPS[name]) throw new Error(`Unknown group "${name}". Groups: ${Object.keys(GROUPS).join(", ")}`);
  await fetchGroup(name);
  // Overpass asks for gaps between heavy queries.
  await new Promise((r) => setTimeout(r, 2000));
}
