# Danube Flyover

A browser-based 3D flight along the Budapest riverfront: a bird from the Japanese Garden on Margaret Island to the Central Market Hall, landing on the Danube to continue as a boat. See [the design doc](<Danube Flyover — Design Doc.md>) and [the decisions log](docs/decisions.md).

This is **M3, lighting**, on top of M2's autopilot, M1's geography and the M0 grey box:

- a painted sky: four panoramas (dawn, day, golden hour, night) mixed with three's physical sky, blue hour, stars and a moon; the hemisphere light and the fog take their colours from it;
- textured buildings: eight facade styles and four roof kinds, tinted per building, from a procedural style sheet ([`docs/style-sheet.webp`](docs/style-sheet.webp));
- night: windows that come on one by one between 18:00 and 19:30, floodlit landmarks, the Chain Bridge's string lights, deck lamps on the other bridges, lamps along both embankments, and a pool of four real point lights;
- the water: flowing ripples, sky reflections, planar reflections near Parliament and the Chain Bridge, and a reflection streak under every night light;
- bloom and ACES tone mapping, with exposure following the sun;
- from M2: camera shots along the route, landmark cards, pause, beat jumps and the loop;
- from M1: the real city from OpenStreetMap, terrain from Copernicus GLO-30, the river, the five bridges, 16,000 trees and the hero landmarks as labelled placeholder blocks (until M4);
- from M0: the route and its autopilot, the bird and the boat, the landing and take-off, manual control with hand-back, and the time-of-day slider.

The textures are procedural stand-ins for the design's image-API set (see `docs/decisions.md`, M3).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/, deployable to any static host
npm run timetable  # beat start times computed from public/data/route.json
npm run simulate   # headless runs: the tour through the loop (beats, camera, cards, tracking, floor contacts),
                   # scripted checks of pause, hand-back and the jumps, and the lighting at the money shots
npm run textures   # repaint the texture set and the style sheet, and pack public/data/tex/
```

To record the run, open the dev server with `?record=timelapse` (the whole tour in 30 s) or `?record=beat6` (30 s of a beat in real time), wait for the last frame, then `npm run record -- timelapse`: it writes `tools/out/timelapse.webp`.

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
- **T** hides the time slider. **`** (backquote) shows the debug panel, with the camera mode, the card, the night ramp, exposure and bloom, the reflection, the point lights, draw calls and triangles.
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
| 7 | `gen-textures.ts`, then `pack-textures.ts` | `assets/raw/` (lossless masters, not committed), then `tex/`: the surface array textures, quay, water normal map and skies; and `docs/style-sheet.webp` |

`gen-textures` is procedural by default. With `-- --api` and `OPENAI_API_KEY` set it takes the design's image-API path instead (prompts in `tools/prompts/`; untested so far).

`landmarks.json` and `route.json` are hand-edited and never generated. Re-run `build-city` and `build-floor` after moving a landmark's placeholder: the city leaves its footprint out, and the floor includes it.

## Layout

- `public/data/`: everything the runtime loads, about 8 MB (`tex/` is the textures).
  - Hand-edited: `route.json` (the autopilot route, its beats and camera keys) and `landmarks.json` (cards, trigger radii, and the placeholder blocks).
  - Built by the pipeline: the rest.
- `src/`: one module per job.
  - The core modules: `route`, `autopilot`, `input`, `controller` (blend, pause and the mode state machine), `vehicle`, `camera` (shots and blends), `cards` (trigger rules), `tour` (loop and jumps), `hud`, and `load` (fetches `data/` with progress).
  - Light and render: `lighting` (sun, moon, hemisphere, fog, exposure and bloom curves), `sky` (the dome and its environment cube), `post` (bloom and tone mapping), `textures` (loads `tex/`), and `record` (dev-only recording).
  - `sim` is the simulation step shared by the browser and `tools/simulate.ts`.
  - `world/` reads the pipeline's files: `river`, `terrain`, `floor`, `bridges`, `landmarks`, `trees` and `gridFile` (the binary grid format). It also holds the surfaces' shader patches (`surfaces`, `shaderPatch`), the river (`water`), and the night lights (`nightLights`, `night`).
- `tools/`: the pipeline, the timetable, the simulator and the recorder.
  - `tools/osm/` and `tools/dem/` hold the committed source extracts.
  - `tools/textures/` paints the texture set; `tools/prompts/` holds the image-API prompts.
  - `tools/lib/` has shared geometry, raster, glTF, file and image-API helpers.
  - `tools/capturePlugin.ts` is the dev server's frame capture endpoint.

## Credits

- Map data © OpenStreetMap contributors, ODbL 1.0. The extracts in `tools/osm/` and the files derived from them in `public/data/` are ODbL databases (see `tools/osm/README.md`).
- Terrain contains modified Copernicus DEM GLO-30 data, © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA.
