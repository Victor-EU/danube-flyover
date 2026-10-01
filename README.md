# Danube Flyover

A browser-based 3D flight along the Budapest riverfront: a bird from the Japanese Garden on Margaret Island to the Central Market Hall, landing on the Danube to continue as a boat. See [the design doc](<Danube Flyover — Design Doc.md>) and [the decisions log](docs/decisions.md).

This is **M1, geography**, on top of the M0 grey box:

- the real city from OpenStreetMap: 11,485 buildings extruded to their tagged heights, the river and its quays, the five bridges, parks and 16,000 trees;
- terrain from the Copernicus GLO-30 elevation model, with Castle Hill and Gellért Hill;
- the bird's altitude floor baked from all of it;
- the hero landmarks as labelled placeholder blocks, from `landmarks.json`;
- everything from M0: the route and its autopilot, the bird and the boat, the landing and take-off, manual control and the time-of-day slider.

There are no textures yet: buildings and ground are coloured per vertex until M3.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/, deployable to any static host
npm run timetable  # beat start times computed from public/data/route.json
npm run simulate   # headless autopilot run: beats, mode switches, tracking error, floor contacts
```

## Controls

- **Steer** with any of these to take control from the autopilot:
  - W/S: speed
  - A/D: turn
  - Q/E: down/up (bird)
  - or drag
- **Hand-back:** 3 s without input hands control back to the autopilot over 2 s.
- **Land:** hold Q over the water until you're below 2 m.
- **Take off:** hold W at the boat's top speed for 1 s.
- **T** hides the time slider. **`** (backquote) shows the debug panel, with draw calls and triangles.
- The **© OpenStreetMap contributors** credit opens the About overlay with the data credits.

In the browser console:

- `flyover.jump(n)` moves to the start of beat n.
- `flyover.step(seconds)` advances the simulation, which also works in a hidden tab.
- `flyover.camera = someCamera` renders from another camera, for overviews; set it to `null` to go back.

## The world pipeline

The world is built offline by the scripts in `tools/` and committed, so the site needs no map API. The runtime only reads `public/data/`.

```bash
npm run fetch-osm    # 1. OpenStreetMap layers -> tools/osm/*.geojson (Overpass; slow, retries on 504)
npm run fetch-dem    #    Copernicus GLO-30 window -> tools/dem/ (cloud-optimised GeoTIFF on AWS)
npm run build-world  # 2-6. everything below, in order (about 10 s, deterministic)
```

| Step | Script | Writes |
| --- | --- | --- |
| 2 | `build-water.ts` | `river.json` (water polygon, banks, centreline), `water.glb` (river surface with flow UVs, quays) |
| 3 | `build-terrain.ts` | `terrain.bin`: 10 m heights above the river and a landcover class per sample (`-- --debug <dir>` writes a hillshade PNG) |
| 4 | `build-bridges.ts` | `bridges.json`: deck outlines, piers and towers from OSM, with hand-set heights and styles |
| 5 | `build-city.ts` | `city.glb`: buildings merged per district, and ponds; `trees.json` |
| 6 | `build-floor.ts` | `floor.bin`: the bird's 5 m altitude-floor grid |

`landmarks.json` and `route.json` are hand-edited and never generated. Re-run `build-city` and `build-floor` after moving a landmark's placeholder: the city leaves its footprint out, and the floor includes it.

## Layout

- `public/data/`: everything the runtime loads, about 7 MB.
  - Hand-edited: `route.json` (the autopilot route) and `landmarks.json` (cards, and the placeholder blocks).
  - Built by the pipeline: the rest.
- `src/`: one module per job.
  - The core modules: `route`, `autopilot`, `input`, `controller` (blend and mode state machine), `vehicle`, `camera`, `lighting`, `hud`, and `load` (fetches `data/` with progress).
  - `world/` reads the pipeline's files: `river`, `terrain`, `floor`, `bridges`, `landmarks`, `trees` and `gridFile` (the binary grid format).
- `tools/`: the pipeline, the timetable and the simulator.
  - `tools/osm/` and `tools/dem/` hold the committed source extracts.
  - `tools/lib/` has shared geometry, raster, glTF and file helpers.

## Credits

- Map data © OpenStreetMap contributors, ODbL 1.0. The extracts in `tools/osm/` and the files derived from them in `public/data/` are ODbL databases (see `tools/osm/README.md`).
- Terrain contains modified Copernicus DEM GLO-30 data, © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA.
