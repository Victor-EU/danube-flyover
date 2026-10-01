# Danube Flyover

A browser-based 3D flight along the Budapest riverfront: a bird from the Japanese Garden on Margaret Island to the Central Market Hall, landing on the Danube to continue as a boat. See [the design doc](<Danube Flyover — Design Doc.md>) and [the decisions log](docs/decisions.md).

This is **M2, autopilot**, on top of M1's geography and the M0 grey box:

- camera shots keyed along the route:
  - `orbit` holds Parliament, Buda Castle, the Liberty Statue and the Market Hall in frame;
  - `reveal` opens the tour and the Market Hall finish;
  - `low` takes over under every bridge deck;
- landmark cards with placeholder text, one at a time, once per pass; click one to open it;
- pause (the boat idles, the bird circles), beat jumps on 1–9 and 0, and the loop: 5 s circling the Market Hall, a fade to black, and back to the Japanese Garden;
- from M1: the real city from OpenStreetMap, terrain from Copernicus GLO-30, the river, the five bridges, 16,000 trees and the hero landmarks as labelled placeholder blocks;
- from M0: the route and its autopilot, the bird and the boat, the landing and take-off, manual control with hand-back, and the time-of-day slider.

There are no textures yet: buildings and ground are coloured per vertex until M3, and the night is very dark until M3's lighting.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/, deployable to any static host
npm run timetable  # beat start times computed from public/data/route.json
npm run simulate   # headless runs: the tour through the loop (beats, camera, cards, tracking, floor contacts),
                   # then scripted checks of pause, hand-back and the jumps
```

## Controls

- **Steer** with any of these to take control from the autopilot:
  - W/S: speed
  - A/D: turn
  - Q/E: down/up (bird)
  - or drag
- **Hand-back:** 3 s without input hands control back to the autopilot over 2 s. If the route has changed mode meanwhile, the autopilot takes off, or flies back and lands, first.
- **Land:** hold Q over the water until you're below 2 m.
- **Take off:** hold W at the boat's top speed for 1 s.
- **Space** (or the bar's button) pauses: you keep control, the boat idles and the bird circles. Resuming hands back to the autopilot.
- **1–9 and 0** jump to the ten beats.
- **Cards:** click one to open it, and **Esc** or × to close it.
- **T** hides the time slider. **`** (backquote) shows the debug panel, with the camera mode, the card, draw calls and triangles.
- The **© OpenStreetMap contributors** credit opens the About overlay, with the controls and the data credits.

In the browser console:

- `flyover.jump(n)` cuts straight to the start of beat n, with no fade.
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
  - Hand-edited: `route.json` (the autopilot route, its beats and camera keys) and `landmarks.json` (cards, trigger radii, and the placeholder blocks).
  - Built by the pipeline: the rest.
- `src/`: one module per job.
  - The core modules: `route`, `autopilot`, `input`, `controller` (blend, pause and the mode state machine), `vehicle`, `camera` (shots and blends), `cards` (trigger rules), `tour` (loop and jumps), `lighting`, `hud`, and `load` (fetches `data/` with progress).
  - `sim` is the simulation step shared by the browser and `tools/simulate.ts`.
  - `world/` reads the pipeline's files: `river`, `terrain`, `floor`, `bridges`, `landmarks`, `trees` and `gridFile` (the binary grid format).
- `tools/`: the pipeline, the timetable and the simulator.
  - `tools/osm/` and `tools/dem/` hold the committed source extracts.
  - `tools/lib/` has shared geometry, raster, glTF and file helpers.

## Credits

- Map data © OpenStreetMap contributors, ODbL 1.0. The extracts in `tools/osm/` and the files derived from them in `public/data/` are ODbL databases (see `tools/osm/README.md`).
- Terrain contains modified Copernicus DEM GLO-30 data, © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA.
