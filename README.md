# Danube Flyover

A browser-based 3D flight along the Budapest riverfront: a bird from the Japanese Garden on Margaret Island to the Central Market Hall, landing on the Danube to continue as a boat. See [the design doc](<Danube Flyover — Design Doc.md>) and [the decisions log](docs/decisions.md).

This is **M4, heroes**, plus the music, on top of M3's lighting, M2's autopilot, M1's geography and the M0 grey box:

- music: four jazz tracks by Kevin MacLeod (CC BY 4.0), off until you turn it on, day tracks at golden hour and night tracks after dusk;
- the ten hero landmarks, modelled in code on their real footprints: Parliament, the Chain, Margaret, Elisabeth and Liberty Bridges, Fisherman's Bastion and Matthias Church, Buda Castle, the Liberty Statue, the Gellért Hotel and the Central Market Hall; plus the Academy, Gresham Palace, the Vigadó, the Citadella and the Shoes on the Danube;
- effects: the boat's wake and foam, the landing splash and the take-off spray;
- ambient life: two tour boats, trams on both embankments, gulls over the river;
- quality tiers (high, medium, low), chosen by device and a 2 s frame-time probe, or in the About overlay;
- the mobile pass: touch steering (and take-off), a wider view on phones held upright, a golden-hour still where WebGL2 is missing;
- landmark cards that open to an illustration (a render of the scene) and a paragraph;
- from M3: the painted sky, textured city, night lights, the water's reflections and streaks, bloom and tone mapping;
- from M2: camera shots along the route, landmark cards, pause, beat jumps and the loop;
- from M1: the real city from OpenStreetMap, terrain from Copernicus GLO-30, the river, the five bridges and 16,000 trees;
- from M0: the route and its autopilot, the bird and the boat, the landing and take-off, manual control with hand-back, and the time-of-day slider.

The textures and illustrations are procedural or rendered stand-ins for the design's image-API set (see `docs/decisions.md`, M3 and M4).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/, deployable to any static host
npm run timetable  # beat start times computed from public/data/route.json
npm run simulate   # headless runs: the tour through the loop (beats, camera, cards, tracking, floor contacts),
                   # scripted checks of pause, hand-back and the jumps, the lighting at the money shots,
                   # the heroes, cards, quality tiers and tram lines, and the music's licences and playlist
npm run textures   # repaint the texture set and the style sheet, and pack public/data/tex/
npm run cards      # finish the card illustrations (after ?record=cards, below)
npm run audio      # trim, level and encode the music into public/data/audio/ (macOS; originals in tools/out/audio/)
```

To record the run, open the dev server with `?record=timelapse` (the whole tour in 30 s) or `?record=beat6` (30 s of a beat in real time), wait for the last frame, then `npm run record -- timelapse`: it writes `tools/out/timelapse.webp`. `?record=cards` renders each landmark's card picture from its set viewpoint; `npm run cards` then writes `public/data/cards/`.

`?quality=low`, `medium` or `high` fixes the quality tier (see `public/data/quality.json`); without it the app picks one and measures.

## Controls

- **Steer** with any of these to take control from the autopilot:
  - W/S: speed
  - A/D: turn
  - Q/E: down/up (bird)
  - or drag (touch or mouse): sideways turns; up and down climbs or dives as the bird, and sets the speed as the boat
- **Hand-back:** 3 s without input hands control back to the autopilot over 2 s. If the route has changed mode meanwhile, the autopilot takes off, or flies back and lands, first.
- **Land:** hold Q over the water until you're below 2 m.
- **Take off:** hold W (or drag up) at the boat's top speed for 1 s.
- **Space** (or the bar's button) pauses: you keep control, the boat idles and the bird circles. Resuming hands back to the autopilot.
- **1–9 and 0** jump to the ten beats.
- **Cards:** click one to open it, and **Esc** or × to close it.
- **M** (or the bar's speaker button) turns the music on and off; the About overlay sets its volume. Browsers block sound until you interact with the page, so it starts off; once turned on, it's remembered, and starts with your first click or key on the next visit.
- **T** hides the time slider. **`** (backquote) shows the debug panel, with the camera mode, the card, the night ramp, exposure and bloom, the reflection, the point lights, the effects, the quality tier, the music, draw calls and triangles.
- The **© OpenStreetMap contributors** credit opens the About overlay, with the controls, the quality and volume settings, and the data and music credits.

In the browser console:

- `flyover.jump(n)` cuts straight to the start of beat n, with no fade.
- `flyover.step(seconds)` advances the simulation, which also works in a hidden tab.
- `flyover.camera = someCamera` renders from another camera, for overviews; set it to `null` to go back.

## The world pipeline

The world is built offline by the scripts in `tools/` and committed, so the site needs no map API. The runtime only reads `public/data/`.

```bash
npm run fetch-osm    # 1. OpenStreetMap layers -> tools/osm/*.geojson (Overpass; slow, retries on 504)
npm run fetch-dem    #    Copernicus GLO-30 window -> tools/dem/ (cloud-optimised GeoTIFF on AWS)
npm run build-world  # 2-8. everything below, in order (about 15 s, deterministic)
```

| Step | Script | Writes |
| --- | --- | --- |
| 2 | `build-water.ts` | `river.json` (water polygon, banks, centreline), `water.glb` (river surface with flow UVs, quays) |
| 3 | `build-terrain.ts` | `terrain.bin`: 10 m heights above the river and a landcover class per sample (`-- --debug <dir>` writes a hillshade PNG) |
| 4 | `build-bridges.ts` | `bridges.json`: deck outlines, piers and towers from OSM, with hand-set heights and styles |
| 5 | `build-heroes.ts` | `heroes/<id>.glb`: the landmarks, modelled in code in `tools/heroes/`; `-- <id>` builds one |
| 6 | `build-city.ts` | `city.glb`: buildings merged per district, and ponds; `trees.json` |
| 7 | `build-floor.ts` | `floor.bin`: the bird's 5 m altitude-floor grid |
| 8 | `build-life.ts` | `life.json`: the tram lines along both embankments |
| 9 | `gen-textures.ts`, then `pack-textures.ts` | `assets/raw/` (lossless masters, not committed), then `tex/`: the surface and hero array textures, quay, water normal map and skies; and `docs/style-sheet.webp` |

`gen-textures` is procedural by default. With `-- --api` and `OPENAI_API_KEY` set it takes the design's image-API path instead (prompts in `tools/prompts/`; untested so far).

`landmarks.json`, `route.json`, `quality.json` and `audio.json` are hand-edited and never generated (`npm run audio` fills in each track's `gain` and `seconds`).

The music isn't part of `build-world`. To change it, download the originals into `tools/out/audio/` (each track's `original` in `audio.json`; they aren't committed), then `npm run audio`. It trims the silence at the ends, levels every track to -19.5 LUFS (BS.1770), and encodes AAC at 128 kb/s with macOS's `afconvert`. Only CC0 or CC BY music can be used: `npm run simulate` checks the licences. Re-run `build-heroes`, `build-city` and `build-floor` after moving a landmark or editing a hero: the city leaves its footprint out, and the floor includes it.

## Layout

- `public/data/`: everything the runtime loads, about 8.4 MB, plus 16.4 MB of music streamed only once it's turned on (`tex/` is the textures, `heroes/` the landmarks' models, `cards/` their illustrations, `audio/` the music).
  - Hand-edited: `route.json` (the autopilot route, its beats and camera keys), `landmarks.json` (models, cards, trigger radii), `quality.json` (the tiers) and `audio.json` (the tracks, their credits and light).
  - Built by the pipeline: the rest.
- `src/`: one module per job.
  - The core modules: `route`, `autopilot`, `input`, `controller` (blend, pause and the mode state machine), `vehicle`, `camera` (shots and blends), `cards` (trigger rules), `tour` (loop and jumps), `hud`, and `load` (fetches `data/` with progress).
  - Light and render: `lighting` (sun, moon, hemisphere, fog, exposure and bloom curves), `sky` (the dome and its environment cube), `post` (bloom and tone mapping), `quality` (the tiers and the probe), `textures` (loads `tex/`), and `record` (dev-only recording).
  - `effects`: the wake, splash and spray, the tour boats, trams and gulls.
  - `audio`: the music, its button and the playlist.
  - `sim` is the simulation step shared by the browser and `tools/simulate.ts`.
  - `world/` reads the pipeline's files: `river`, `terrain`, `floor`, `bridges`, `landmarks`, `trees` and `gridFile` (the binary grid format). It also holds the hero models (`heroes`), the surfaces' shader patches (`surfaces`, `shaderPatch`), the river (`water`), and the night lights (`nightLights`, `night`).
- `tools/`: the pipeline, the timetable, the simulator, the recorder and the music's encoder (`audio.ts`).
  - `tools/heroes/` models the landmarks: `kit.ts` is the modelling kit, `bridgeKit.ts` the bridges' shared parts.
  - `tools/osm/` and `tools/dem/` hold the committed source extracts.
  - `tools/textures/` paints the texture set; `tools/prompts/` holds the image-API prompts.
  - `tools/lib/` has shared geometry, raster, glTF, file and image-API helpers.
  - `tools/capturePlugin.ts` is the dev server's frame capture endpoint.

## Credits

- Map data © OpenStreetMap contributors, ODbL 1.0. The extracts in `tools/osm/` and the files derived from them in `public/data/` are ODbL databases (see `tools/osm/README.md`).
- Terrain contains modified Copernicus DEM GLO-30 data, © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA.
- Music: "Bossa Antigua", "Backbay Lounge", "Smooth Lovin" and "Night in Venice", Kevin MacLeod (incompetech.com), licensed under Creative Commons: By Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/). Trimmed, levelled and re-encoded for the web.
