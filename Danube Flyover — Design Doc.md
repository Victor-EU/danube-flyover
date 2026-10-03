# Danube Flyover — Design Doc

Oct 1, 2026 · @Victor Zhang

## Overview

**Platform: a web app, desktop first.** A static site (Vite, TypeScript, three.js) that runs in a desktop browser with no install and deploys to any static host. Mobile is best-effort through the low quality tier, with a dedicated pass only in the final milestone.

Danube Flyover is a browser-based 3D showcase of the Budapest riverfront: you fly a glider from the Japanese Garden on Margaret Island to the Central Market Hall, and at any point you can land on the water and continue as a boat. An autopilot plays the trip as a guided, cinematic tour by default; the user can take control at any moment and hand it back.

The world is a Budapest as close to reality as open data and the browser allow (since the realism pass of 3 October; it began as a stylized, low-poly city). Real geography (river bends, bridge positions, the two Buda hills) and the real city (every OSM building roofed from its block's straight skeleton, the streets, kerbs and markings, the trees by species, the moored ships, the traffic) give it credibility; photographed materials and a physically lit scene give it its look. A time-of-day slider runs the whole scene from morning haze through golden hour to a fully lit night.

Target feel: Budapest as you'd see it from a glider and a boat. The two money shots are golden hour from the air over Parliament and night on the water under the Chain Bridge. Everything in this document serves those two moments.

The route is about 5.5 km of river, and about 8.6 km flown once the arc around Parliament and the swing over Buda are counted. A full autopilot run takes about 9½ minutes: flight over Margaret Island and past Parliament, a landing just north of the Chain Bridge, a boat leg under the Chain Bridge and past the Castle and Gellért Hill, and a final take-off for an aerial of the Market Hall roof.

## Goals and non-goals

**Goals**

- Run in a desktop browser at a steady 60 fps on a mid-range laptop, 30 fps on a recent phone, with no install.
- Make the autopilot run worth watching with zero input: a person who touches nothing still gets the full tour.
- Make the fly-to-boat switch the signature moment: a continuous, readable transition, not a cut.
- Get the geography right: someone who knows Budapest should recognise every bridge and the order of landmarks.
- Support a time-of-day range from 06:00 to 24:00 with believable lighting at every point, and a night mode that looks like the postcard.
- Keep the whole thing a single static site (HTML, JS, assets) deployable to any static host.

**Non-goals**

- Survey accuracy. Buildings outside the hero list are their OSM footprints to their tagged (or typical) eaves, with roofs, cornices and chimneys made from rules and photographed facades, not modelled one by one.
- A full flight or boat simulator. Movement is constrained to a corridor around the river spline.
- The whole city in detail. The world ends a few hundred metres back from each bank (further on Buda, to take in Castle Hill); beyond it the far field carries the real city, hills and river on into the haze, simplified.
- Multiplayer, accounts, or any backend. State lives in the browser.
- Mobile as a first-class target in V1. It should run, but the tuning target is desktop.

## The experience

The app opens in autopilot at golden hour, gliding above the Japanese Garden, and the autopilot takes it into the tour after two seconds. There is no menu; the only persistent UI is a thin bottom bar with the time-of-day slider, a mode indicator (glider or boat), a play/pause button, a music button (off until the user turns it on), a small "take control" hint that fades after first use, and a small "© OpenStreetMap contributors" credit that opens the About overlay.

**The route**, north to south, with the planned camera beats. Times follow from each beat's distance and keyframed speed (`npm run timetable` prints them from `route.json`; regenerate this table after editing the route). The clock column is the sunset run (see Demo mode).

| # | Beat | Mode | Approx. time | Clock (sunset run) | Camera |
| --- | --- | --- | --- | --- | --- |
| 1 | Japanese Garden, Margaret Island | Glider | 0:00–1:42 | 17:30 | Rise from the ponds, clear the treeline, reveal the river, then a fast run down the island |
| 2 | Margaret Bridge | Glider | 1:42–2:20 | 17:45 | Cross the bridge low, bank left toward Pest |
| 3 | Parliament | Glider | 2:20–3:07 | 17:55–18:10 | The route arcs about 130° around the dome on the river side while the camera holds on it, then pulls back for the full facade |
| 4 | Shoes on the Danube | Glider | 3:07–3:38 | 18:10 | Slow, low pass along the Pest bank |
| 5 | Castle Hill and Fisherman's Bastion | Glider | 3:38–4:44 | 18:15–18:55 | Climb and swing right over Buda as the sun sets, Bastion in foreground, Parliament across the water |
| 6 | Chain Bridge | Glider → Boat | 4:44–6:00 | 18:55–19:45 | Dive to the water, land about 200 m north of the bridge, pass under it as a boat |
| 7 | Buda Castle and the Promenade | Boat | 6:00–7:03 | 19:45 | Castle towering above on the right, the Vigadó and the Promenade lit on the left, Elisabeth Bridge ahead |
| 8 | Elisabeth Bridge and Gellért Hill | Boat | 7:03–7:53 | 20:00 | Under the bridge, Liberty Statue high on the right |
| 9 | Liberty Bridge | Boat → Glider | 7:53–8:32 | 20:15 | Throttle up under the green ironwork, lift off just past it |
| 10 | Central Market Hall | Glider | 8:32–9:29 | 20:20–20:30 | Climb and circle the tiled roof; the tour ends circling above it and loops after a pause |

**Modes**

- *Glider*: altitude up to 180 m above the water. Over water it can come down to the surface; over land it stays at least 15 m above the floor (ground, buildings and bridge towers; see Corridor). Speed 8 to 25 m/s, free steering within a corridor 300 m either side of the route. Pitch and bank are visual only; the path is corridor-constrained.
- *Boat*: on the water surface, speed 2 to 12 m/s (cruise 8 m/s), steering within the river polygon. Camera 7.5 m behind and 2 m above the water. The boat rides the waves under it, its own wake's and the tour boats'.
- *Switch*: in glider mode over water, holding descend (Q) until altitude drops below 2 m triggers landing. In boat mode, holding throttle at max speed for 1 s triggers take-off, unless the boat is under or just before a bridge deck. Both are also keyframed into the autopilot.

**Control model**

- Autopilot is the default state. Any steering input (keys, mouse drag, touch drag) blends control to the user over 0.5 s.
- After 3 s without input, control blends back to autopilot over 2 s. Autopilot re-joins the spline from the current position rather than snapping; if the vehicle is in a different mode from the route at that point, autopilot runs the transition first (see Manual override).
- Pause stops the autopilot and leaves the user in free control where they are: the boat idles to a stop, and the glider, which can't hover, circles at minimum speed until the user steers. Control never blends back while paused, and the sunset-run clock stops. Resuming hands control straight back to the autopilot (the 2 s blend, without the 3 s wait).
- Keyboard: W/S speed, A/D steer, Q/E altitude (glider; Q descends), Space pause, T toggles the time slider, M turns the music on and off, 1–9 and 0 jump to beats 1–10 (through a short fade to black), Esc closes a card.
- Touch (and mouse drag): sideways turns; up and down climbs or dives as the glider, and sets the speed as the boat (so a held drag up takes off).

**Landmark cards**: when the camera is within a landmark's trigger radius and it is in frame, a small card slides in with the name and a two-line note. Clicking expands it to an illustration and a short paragraph. Cards never block the view and never pause the tour. One card shows at a time (rules under Landmark triggers).

**Time of day** is a slider from 06:00 to 24:00, continuous, default 18:00 (the golden-hour peak in early October). Autopilot can optionally advance time during the tour ("sunset run": 17:30 to 20:30, keyframed per beat), which is the demo-mode default.

## The world

**Extent.** A corridor from the north tip of Margaret Island (47.535 N) to just south of Liberty Bridge (47.483 N), about 6 km long and 1.5 km wide, centred on the river, and widened to about 1 km west of the river between Batthyány tér and the Tabán so all of Castle Hill is inside. Scene units are metres; the origin is a simple equirectangular offset centred on the Chain Bridge (error under 1 m across the extent), with +X east, +Z south, +Y up, and the river surface at Y = 0. Everything outside the corridor is the far field: 26 km of OpenStreetMap and 50 km of terrain, simplified (see layer 7).

**Scene layers**, from the bottom up:

1. *Terrain*: a heightmap mesh from a DEM, flat on the Pest side, rising to Castle Hill (about 70 m above the river; 168 m above sea level) and Gellért Hill (about 135 m above the river; 235 m above sea level) on Buda. 10 m resolution is enough. The DEM needs processing before use (see the Terrain row under Data sources).
2. *Water*: the river polygon as a flat mesh at 0 m with an animated normal map, reflections (planar near the two money shots, a reflection probe elsewhere, plus light streaks at night; see Night). Around the boat, a 256 m square of simulated linear deep-water waves (an FFT on the GPU, following the boat and drifting with the current) makes the wakes: the hulls press on the water, the waves disperse into Kelvin wakes, and foam ages from white water into lace. A dense mesh around the camera is displaced by them.
3. *Embankments and quays*: extruded strips along both banks with a generated stone texture; tram tracks on the Buda side as a decal.
4. *Filler buildings*: OSM footprints extruded to their eaves (tagged height less the roof, or levels × 3.3 m, or 15–21 m), roofed from their block's straight skeleton (pitched, mansard, steep or flat), with firewalls, cornices, parapets, chimneys and rooftop units, merged into one mesh per 320 m tile, textured with 8 photographed facade atlases chosen by district and height and baked street-canyon occlusion. Window emissive mask for night.
5. *Hero landmarks*: modelled in code (`tools/heroes/`) on their OSM footprints and the bridges' decks: Parliament, Buda Castle, Fisherman's Bastion with Matthias Church, Chain Bridge, Elisabeth Bridge, Liberty Bridge, Margaret Bridge, Gellért Hotel, Liberty Statue, Central Market Hall, and with the same kit the other landmarks on the cards. Each under 20k triangles, textured from shared day layers, with window masks for the night.
6. *Vegetation*: Margaret Island, the streets and the hills as instanced trees of nine species, grown procedurally (branches and leaf cards), at three levels of detail by distance.
7. *Far field*: beyond the world, the real terrain to 25 km (the Buda hills and the Pilis), its ground painted from OpenStreetMap (land use, woods, streets, roofs, and the street light at night), 121,000 buildings within 6 km (and the tall ones further), built by the world's own rules and shaded with its facade and roof tiles, the river, its bridges and the towers and chimneys with their aviation lights; it loads after the first frame. Plus the skydome.
8. *Life*: trams on both embankments, two sightseeing boats on a loop up and down the river, river-cruise ships moored at the pontoons, parked cars and traffic on the main roads, and flocks of gulls (left out on the low tier).
9. *Ground*: the streets painted onto the terrain from a 1 m mask (carriageway distance field, lawns, paths, setts), with photographed asphalt, paving, setts, lawn and gravel, ground occlusion, and markings and tram rails as geometry.

**Art direction.** Realistic: the city as it is, in the light of the hour. Budapest's stone and plaster (warm ochres, creams and greys, aged), tile, slate, tin and copper roofs, dark teal water, and gold night lighting. Photographed materials (from the image API, as photographs of the real surfaces), shadows and baked occlusion, light haze. No text on buildings. (Until the realism pass: stylized, between a travel poster and an animated-film background, with a style sheet attached to every generated texture.)

**Scale honesty.** Positions and bridge spans match reality; building heights match tags. Hero landmarks may be exaggerated up to 15 percent vertically to read better from the air.

## Data sources and asset pipeline

All geometry comes from open data, processed once by offline scripts into static assets. The runtime never calls a map API.

| Asset | Source | Licence | Processing |
| --- | --- | --- | --- |
| Building footprints and heights | OpenStreetMap via Overpass API (bbox 47.48–47.54 N, 19.025–19.07 E), tags `building`, `height`, `building:levels` | ODbL, attribution required | Script: fetch, project to local metres, extrude, merge by district, export glTF |
| River polygon, islands, banks | OSM `natural=water` + `water=river` areas for the Danube (plus legacy `waterway=riverbank` where still tagged) | ODbL | Script: union, simplify to 2 m tolerance, triangulate, export glTF |
| Bridges | OSM `bridge=yes` ways and `man_made=bridge` areas (deck outline + span) | ODbL | Deck geometry generated; towers and ironwork hand-modelled |
| Terrain | Copernicus GLO-30 DEM (30 m), optionally resampled to 10 m with smoothing | Free, attribution | Script: clip; subtract the river level (about 100 m above sea level) so the water sits at 0 m; flatten Pest and the islands, and remove buildings and trees on Buda (a morphological opening, with level pads for the widest footprints), because GLO-30 is a surface model that includes them; export a 10 m height grid (`terrain.bin`). If building bumps survive on Buda, hand-sculpt the two hills from contours instead |
| Roads, tram lines, parks, trees | OSM `highway`, `railway=tram`, `leisure=park`, `natural=tree` | ODbL | Decals and instance point lists |
| Boat route and piers | BKK GTFS open data (lines D11, D12, D14) | Open | Optional; pier positions for boat-mode stops |
| Hero landmark meshes | Modelled in code from reference dimensions, on the OSM footprints and `bridges.json` (`tools/heroes/`) | Own work | `build-heroes`: one meshopt-compressed glb per landmark; their texture layers are painted with the facades |
| Facade atlases, quays, roofs, hero layers | The OpenAI image API (`gpt-image-2.5-sunburst`, the current set), each repainting its procedural texture (`tools/textures/`) as a layout guide with the style sheet attached, 1024×1024 or the layer's aspect, flat lighting; brought to the procedural level of colour, seams repainted where they show. Procedural alone without a key | API: the output is ours under OpenAI's Services Agreement; credited as AI-generated. Procedural: own work | Packed by `pack-textures.ts`: KTX2/Basis (ETC1S, mipmapped) at the masters' 1024², a file per layer, stacked into array textures at load; and the WebP fallback, 512² layers |
| Skydome panoramas | Procedural (the current set), or the OpenAI image API: 4 panoramas (dawn, day, golden hour, night), equirectangular | Own work | Masters at 4096×2048: KTX2 (UASTC) at full size, swapped in after the first frame, which draws with 2048×1024 WebP; generated ones below target size, upscaled to 4096×2048, 360° seam and poles cleaned up; blended at runtime by time of day |
| Music | Four jazz tracks by Kevin MacLeod (incompetech.com): "Bossa Antigua" and "Backbay Lounge" by day, "Smooth Lovin" and "Night in Venice" by night | CC BY 4.0, credit in the About overlay | `npm run audio` (macOS: afconvert): trimmed, levelled to -19.5 LUFS (BS.1770), AAC at 128 kb/s in `public/data/audio/` |
| Landmark illustrations | Rendered from the scene, one per landmark, at a set viewpoint and hour (`?record=cards`), then repainted by the image API as an illustration in the style sheet's style (the current set; the render fixes the composition) | API output credited as AI-generated; the renders are own work | `npm run cards -- --api`: the repaint (without `--api`, a painted finish on the render), 720×450 WebP, shown in cards |

**Pipeline scripts** (`tools/`, TypeScript run with tsx, run once and committed outputs; `npm run build-world` runs steps 2 to 8 in order):

1. `fetch-osm.ts` and `fetch-dem.ts`: the Overpass queries and the GLO-30 window; save the raw extracts to `tools/osm/` (GeoJSON) and `tools/dem/`.
2. `build-water.ts`: unions and clips the river areas; writes `river.json` (water polygon, banks, centreline) and `water.glb` (river mesh with UVs for flow direction, and the quays).
3. `build-terrain.ts`: DEM resample, river-level offset, flattening and building removal; writes `terrain.bin` (heights plus a landcover class per sample).
4. `build-bridges.ts`: deck outlines, piers and pylons from OSM, with hand-set deck heights and styles; writes `bridges.json`.
5. `build-heroes.ts`: models the landmarks in code (`tools/heroes/`) on their OSM footprints and the bridges' decks, towers and cable curves; writes `heroes/<id>.glb`, and lists the cells each hero stands on for the next two steps.
6. `build-city.ts`: projects, extrudes, assigns district and one of eight facade styles (by type, district and height) and a roof kind, writes `city.glb` and `trees.json`; leaves out the buildings a hero replaces (`osm` in `landmarks.json`) or stands on.
7. `build-floor.ts`: combines the terrain, building and hero heights, tree crowns and bridge towers into `floor.bin`, a 5 m height grid for the glider's altitude floor. Bridge decks stay out of the grid: the runtime tests the deck outlines directly.
8. `build-life.ts`: traces the tram lines along both embankments from the OSM tram ways; writes `life.json`.
9. `gen-textures.ts` (M3): paints the texture set and the style sheet, writes lossless PNGs to `assets/raw/`. The default is procedural (deterministic and offline); with `--api` (the committed set) it prompts the image API with each procedural texture as a layout guide and the style sheet attached. `--dry` lists the requests and their cost first. Answers are kept in `assets/raw/api/`, keyed by a hash of the request, so a rerun only asks for what's missing or changed. `--budget` caps the total, which is kept across runs. `pack-textures.ts` then packs `assets/raw/` into `public/data/tex/`: the WebP fallback for the first frame, and the full-size KTX2 set, swapped in once it has loaded. `npm run textures` runs both.
10. `audio.ts` (after M4): decodes the music's originals from `tools/out/audio/` (downloaded by hand, not committed), trims the silence at the ends, measures each track's loudness and writes the gain that levels it and its length into `audio.json`, and encodes it as an .m4a. `npm run audio`.

The autopilot spline and its beat keyframes are built at load from the hand-edited `route.json`; `npm run timetable` prints the beat timetable (each beat's start time from arc length and speed) used in the route table above.

**Texture generation rules**

- Generate a single style-sheet image first (a riverside street in the target style, flat midday light). Attach it to every later prompt.
- All surface textures are lighting-neutral: flat, even light, no shadows, no sky colour, no time of day in the prompt. Card illustrations get the style without these rules, and keep their render's sky and hour (with the rules, they came back with plain paper for a sky).
- Facades come in pairs: `facade_X_day.png` and `facade_X_lit.png` (same facade, windows glowing). The lit one is stored as the emissive layer, black wherever nothing glows (an API-generated night version has the day one subtracted). The runtime crossfades it window by window.
- A facade is one tile of exactly 4 bays by 4 storeys (3.4 m each), one window per bay and storey: the bottom row is the ground floor, and the three rows above must repeat when stacked. The model doesn't keep to a grid it's only told about, so every texture repaints its procedural twin, drawn to the grid, as a layout guide (without one, a surface can come back as the style sheet's whole scene).
- Facades, roofs and hero layers are near-white detail; the runtime tints them with each building's or face's colour. The model paints in colour, so each texture is scaled channel by channel to its procedural twin's level.
- The API can't make a tile, though a guided answer often does. Where a seam stands out, shift the texture by half a tile (by whole bays and storeys, so the windows keep their grid; facades only sideways), repaint a band over the seam with a masked edit, and blend the band back. A repaint that strays from the surface is asked once more. Verify with the 2×2 tile check before accepting.
- Keep prompts in `tools/prompts/` so textures can be regenerated consistently.

**Attribution**: an "About" overlay credits OpenStreetMap contributors (ODbL), Copernicus and the music (CC BY 4.0: title, artist, licence, and a note that the tracks are trimmed and re-encoded), opened from a small "© OpenStreetMap contributors" credit that is always visible in the bottom bar. This is mandatory for OSM-derived data. The OSM extracts committed to the repo (raw GeoJSON under `tools/` and the JSON derived from it) are themselves an ODbL database, so they carry an ODbL licence note.

## Technical architecture

A single-page static site built with Vite, TypeScript and three.js (r170 or later), no framework. State is a plain object updated once per frame; modules read it, nothing else owns it. Everything below is a module in `src/`.

&#91;embedded content: runtime architecture · 9 modules, one renderer\]

The Controller is the only module that knows about both autopilot and the user; Vehicle, Camera and Lighting take a target and never ask where it came from.

**Modules**

| Module | Responsibility | Key inputs | Key outputs |
| --- | --- | --- | --- |
| `route` | Loads `route.json`; exposes a Catmull-Rom spline (position, heading, altitude, speed, mode) and the beat list | route.json | `sample(s)`, `nearest(pos, sHint)` |
| `autopilot` | Advances a parameter along the spline at the keyframed speed; emits mode-switch and card events; advances the clock in the sunset run | route, clock | target pose, mode request, time of day |
| `input` | Normalises keyboard, mouse drag and touch into a steering vector and buttons; reports last-input time | DOM events | steer, throttle, climb, pause |
| `controller` | Blends autopilot and manual targets by a weight that ramps 0 to 1 over 0.5 s on input, and back to 0 over 2 s after 3 s without input; owns the mode state machine and the mode rule on hand-back | autopilot, input | vehicle target, mode |
| `vehicle` | Integrates position and velocity for glider or boat with per-mode limits; clamps to the corridor and altitude floor, or the river polygon; computes bank and pitch | controller target, river polygon, floor grid | pose |
| `camera` | Third-person rig behind the vehicle with per-mode offsets, camera keys (1.5 s blends between camera modes), and the landing/take-off blend | vehicle pose, route camera keys | three.js camera |
| `cards` | Landmark card triggers: radius, view cone, one at a time, once per pass | vehicle pose, camera, landmarks | current card |
| `tour` | The loop and the beat jumps, both cut through black | autopilot, keys | fade, reset |
| `scene` | Loads and places terrain, water, city, heroes, trees, the far field; owns the surface shaders (facades, quays, floodlights), the water shader and the night light groups with the point-light pool (`world/`) | assets | three.js scene graph |
| `lighting` | Sun and moon directional lights, hemisphere light, the sky dome (`sky`), fog, exposure and bloom curves, the shared night ramp; every curve keyed to sun elevation | time of day | light state |
| `hud` | Bottom bar, time slider, mode badge, music button, OSM credit, landmark cards, about overlay | state | DOM |
| `audio` | The music: off until turned on from a user gesture (remembered); two streamed media elements crossfading over 6 s into the next track for the light (day tracks until dusk, night tracks after); a Web Audio gain for the volume and a safety limiter; pauses with a hidden tab | audio.json, night ramp | sound |
| `effects` | The hulls and splashes that make the wakes, spray, gulls, ambient boats and trams | vehicle pose, mode | scene objects, wave sources |
| `wake` | The waves around the boat: a GPU FFT simulation of linear deep-water waves in a square that follows the boat and drifts with the current; the hulls press on it, the land and piers take its waves, and foam ages from white water into lace; a probe reads the heights under the hull back for its motion | wave sources, river mask, camera | the water's slopes, foam and displaced patch; the boat's heave, pitch and roll |
| `render` | Renderer, the planar reflection pass, post-processing (bloom, tone mapping, `post`), resize, quality tiers and the frame-time probe (`quality`) | scene, camera | frame |

**Mode state machine**: `GLIDER` → `LANDING` → `BOAT` → `TAKEOFF` → `GLIDER`. Landing starts when altitude drops below 2 m over water with downward velocity (manual) or on a keyframe (autopilot); it runs for 2 s during which the vehicle decelerates to boat speed and the camera lowers. Take-off is the mirror, 2.5 s, and never starts under a bridge deck or within 30 m before one. Inputs during a transition are ignored.

**Key data files**

- `route.json`: an ordered list of control points `{lat, lon, alt, speed, mode, hold?, beat?, timeOfDay?, camera?}`. `mode` applies from that point on; heading comes from the spline. A beat is anchored to the point where it starts (`beat: {id, name}`), so editing points never invalidates a hand-written arc length; `camera: {mode, target?}` sets the camera mode from that point to the next camera key (`target` is a landmark id); `timeOfDay` keys the sunset-run clock at that point.
- `landmarks.json`: `{id, name, position, triggerRadius, model, height?, base?, note, text, illustration, osm?}`; `model` is the hero's glb, `height` sets the aim point (half way up) and the label, `note` is the card's two lines and `text` its paragraph, and `osm` lists the OSM buildings the hero replaces.
- `audio.json`: the music, hand-edited: `{file, original, title, artist, licence, licenceUrl, source, light, gain, seconds}`; `light` is `day` or `night`, and `npm run audio` writes `gain` and `seconds`.
- `quality.json`: three tiers (low, medium, high) setting the pixel-ratio cap, shadow map size, planar reflections and their resolution, bloom, MSAA, the share of trees and cars, anisotropy, ambient life and the wake's simulation (512², 256² or off); plus the start tier for desktop and touch devices and the probe's settings.
- `floor.bin`: the glider's altitude-floor grid, written by `build-floor.ts`. `terrain.bin` and `floor.bin` share one format: a JSON header and typed-array layers, zlib-compressed.
- Written by the pipeline, read at load: `river.json`, `bridges.json`, `trees.json`, `terrain.bin`, `city.glb`, `water.glb`, `heroes/*.glb`, `life.json`.

**Coordinate helpers** (`src/geo.ts`): `lonLatToLocal(lon, lat)` and back, so hand-edited route points can be written in lat/lon and converted at load time.

## Lighting and time of day

One number drives everything: `timeOfDay` in hours, 6.0 to 24.0. It sets the sun's position, and every lighting parameter is a curve over the sun's elevation rather than the clock, so there are no discrete day/night states, only a continuous blend, and dawn mirrors dusk.

Reference for Budapest on 1 October (CEST):

| Event | Time | Sun elevation |
| --- | --- | --- |
| Civil dawn | 06:12 | −6° |
| Sunrise | 06:43 | 0° |
| Golden hour | 17:43–18:24 | 6° to 0° |
| Sunset | 18:24, azimuth 266° | 0° |
| Civil dusk | 18:54 | −6° |
| Nautical dusk | 19:30 | −12° |

**Sun and sky**

- Sun direction: azimuth and elevation computed for Budapest (47.5 N, 19.05 E) on 1 October, so golden hour runs 17:43–18:24, peaking around 18:00, and the sun sets behind Buda, which is correct and flattering for Parliament.
- `DirectionalLight` for the sun: intensity curve peaks at 3.0 at noon (elevation about 39°) and falls to 0 at elevation 0°, so it never lights the scene from below the horizon; colour from warm white to deep orange as the elevation drops from 10° to 0°. Casts shadows (2048 map on high, 1024 on medium, off on low) with one cascade fitted to a 600 m box around the camera.
- `HemisphereLight` for ambient: sky and ground colours sampled from the current skydome (a CPU twin of the dome's blend), as hues; the strength is a curve.
- Sky: three.js `Sky` shader (its own clouds off) driven by the sun position while the sun is above −6°, then a crossfade to the generated night panorama between −6° and −12° (18:54 to 19:30 in the evening, mirrored before dawn). The four generated panoramas (dawn, day, golden hour, night) are blended by weight (dawn or golden hour into day between 4° and 14°); the shader sky and the painted sky are mixed so clouds and colour stay consistent, with the painted sky carrying the clouds. The shader sky goes black just below the horizon, so blue hour is the painted sky dimmed and tinted blue, and a soft knee keeps its glow round a low sun from burning out. Stars and the moon are drawn in the dome.
- Fog: exponential fog (`FogExp2`), colour sampled from the horizon of the current sky (each sample capped, so the sun's side doesn't wash it out), density highest at dawn and at night.

**Night**

- Moon: a second directional light, cool blue, intensity 0.15, rising in the east-south-east as the sun sets. It stays in the scene by day at intensity 0 and never casts shadows.
- Emissive crossfade: every building material has an emissive map (the `_lit` facade texture, or a window mask for heroes). Emissive intensity ramps from 0 at sun elevation +3° to 1 at −12° (about 18:00 to 19:30, and the reverse before dawn, so the city is still lit at 06:00), with per-building random jitter of plus or minus 3° of elevation (about 20 minutes) so windows come on unevenly. Each window has its own moment on that ramp, and a share of them never comes on.
- Named light groups, each emissive geometry and sprites: Parliament floodlights (warm white, from the water side), Chain Bridge string lights (gold, along both chains) and its floodlit towers, Castle floodlights, Bastion, Matthias Church, Gellért Hill statue and the Citadella, the riverside landmarks (Academy, Gresham, Vigadó, Gellért Hotel, Market Hall), Liberty, Elisabeth, Margaret and Árpád Bridge deck lights, embankment lamps as emissive sprites, and a faint glow on the streets and quays. Floodlights are emissive light on the surface, brightest at its foot. Groups fade in on the same ramp. Real lights are a pool of four point lights (the boat light is one of them), always in the scene, faded by intensity and reassigned to the nearest groups as the camera moves. Lights are never added or removed at runtime: three.js recompiles every material when the light count changes, which shows as a hitch. For the same reason every program is compiled before the first frame.
- Water at night: near Parliament and the Chain Bridge on medium and high tiers, planar reflections of the lit scene; everywhere else, and on low, each night light gets a stretched, glowing streak sprite on the water, laid out by viewing angle so it's a column under the light, as on rippled water. The water's direct highlights are capped at night, so the moon makes a glitter path. Bloom (threshold 0.9, strength 0.6) makes lights bleed the way they do in photographs; by day its threshold rises with the light, or sunlit walls would bloom.
- Street-level: a faint warm point light attached to the boat so near surfaces read.

**Tone mapping**: ACES filmic, exposure as a curve over sun elevation (1.0 in daylight, 0.7 at golden hour, 0.5 at night) so highlights never blow out.

**What generated textures must obey**

- Albedo textures contain no lighting, no shadows and no time of day.
- Facades come as day + lit pairs with identical geometry.
- Panoramas are the only generated images allowed to contain light; they are sampled, never used as albedo.

**Demo mode**: autopilot advances `timeOfDay` from 17:30 to 20:30 across a run, keyframed per beat (`timeOfDay` in `route.json`; the clock column in the route table) rather than linearly. It holds golden hour over Parliament (17:55–18:10), sweeps through sunset during the swing over Buda, and reaches full night at the Chain Bridge under-pass (about 19:35). The two money shots are about two and a half minutes apart on the route but need well over an hour of clock between them, so a linear clock would put the Chain Bridge at dusk. The slider still works; dragging it pauses the auto-advance for 10 s.

## Camera, autopilot and the mode switch

**The spline.** `route.json` holds about 65 hand-placed control points in lat/lon with altitude, speed and mode. At load they become a centripetal Catmull-Rom curve in local metres. Autopilot moves a parameter `s` (arc length) at the keyframed speed; everything else (heading, altitude, mode) is interpolated from the nearest control points. The spline is the vehicle's path, not the camera's. Where a beat circles a landmark (the Parliament arc, the Market Hall finish), the spline itself makes the arc.

**Beats.** Ten named beats sit on the spline at arc-length positions; their start times follow from the distances and speeds between them. Camera keys on route points (most of them at beat starts) set a camera mode until the next key:

- `follow` (default): camera 12 m behind and 4 m above the glider, 6 m behind and 1.5 m above the boat, smoothed with a critically damped spring (0.4 s).
- `orbit`: the camera stays on the vehicle's rig but aims at a target landmark (the Parliament dome, Buda Castle, the Liberty Statue, the Market Hall) while the spline arcs around or past it. The rig swings round the vehicle only as far as it takes to keep the target within 34° of it (at most 75° from straight behind) and aims between the two, so the vehicle never leaves the frame.
- `reveal`: camera lags further behind and higher, then catches up by the next key, used for the first climb and the Market Hall finish.
- `low`: camera drops to just above the vehicle, used under bridges. It switches on by itself whenever the vehicle is passing under a deck, in manual flight too.

Changes between camera modes blend over 1.5 s.

Beats never move the vehicle; they only move the camera around it. This keeps manual override simple: the vehicle is always where the user expects.

**Manual override.** Input sets a manual target (steer, throttle, climb) applied to the vehicle directly. The controller's blend weight `w` ramps from 0 to 1 over 0.5 s on first input and holds while input continues; after 3 s without input it ramps back to 0 over 2 s. The vehicle target is `lerp(autopilotTarget, manualTarget, w)`. While `w` > 0, the autopilot parameter `s` is re-derived from the vehicle's nearest point on the spline, searched only within 300 m of arc length around the current `s`: the route passes close to itself over Buda and at the Market Hall, and a global search would snap backwards. When control returns, the autopilot continues from where the user actually is. If the vehicle's mode doesn't match the route's mode at that point, autopilot runs the transition first: it takes off at once if the route says glider, or flies back to the route and lands if the route says boat (boat stretches of the route are always on water). Camera keys are suspended while `w` > 0.5 and resume at the next camera key.

**Corridor.** The glider is clamped to 300 m lateral distance from the spline, never closer than 50 m to the edge of the world, and to at most 180 m above the water. The lower limit comes from the floor grid (`floor.bin`, 5 m cells holding the highest of terrain, building tops, tree crowns and bridge towers): over land the glider stays at least 15 m above it (4 m above a tree crown), and over water the floor is the surface. Bridge decks are tested against their outlines, so the glider passes under a bridge if it arrives below the deck and over it otherwise. Pushing against a limit slows and turns the vehicle back (or lifts it, at the floor) rather than stopping it. The boat is clamped inside the river polygon with a 5 m margin, tested by a 2D point-in-polygon check each frame.

**Landing (glider to boat), 2.0 s.**

1. Trigger: altitude below 2 m over water with vertical speed negative (manual), or a `mode: boat` keyframe (autopilot).
2. Vehicle: speed eases from current to boat cruise (8 m/s); altitude eases to 0; pitch eases to level.
3. Camera: offset eases from glider follow to boat follow; field of view narrows from 70 to 60 degrees.
4. Effects: at t = 0.6 s the splash punches a crater in the water that rings out, with spray and foam; the boat's hull presses on the water (its wake) from t = 1.0 s; the glider mesh morphs or swaps to the boat mesh behind the splash.
5. Inputs ignored for the duration; HUD badge switches at t = 1.0 s.

**Take-off (boat to glider), 2.5 s.** The mirror: triggered by holding throttle at max for 1 s or a `mode: glider` keyframe, but never under a bridge deck or within 30 m before one (the trigger waits until the boat is clear); speed rises to glider cruise (15 m/s), altitude rises to 25 m on an ease-out, the wake fades, the camera widens. A short spray burst at t = 0.3 s.

**Mesh.** V1 uses one stylized vehicle with two states: a glider (a white low-poly sailplane with red wingtips and a red T-tail, and navigation lights that brighten at night) and a small boat. A simple crossfade behind the splash is enough; a morph is a stretch goal.

**Landmark triggers.** Each landmark has a trigger radius (150 to 500 m; the landmarks on the banks need the most, since the boat runs mid-river). When the vehicle is inside it and the landmark is within 40 degrees of the camera forward vector, the HUD shows its card. One card shows at a time, for 8 s; where radii overlap (Parliament, the Shoes, the Bastion and the Chain Bridge), the landmark nearest the centre of the view wins and the others can show once it has gone, if they still qualify. Each card shows once per pass: it can show again only after the vehicle has left its trigger radius, so a long arc around a landmark does not re-trigger it.

**Loop.** At the end of the route, autopilot circles the Market Hall for 5 s, fades to black for 1 s, resets to the Japanese Garden and plays again. In demo mode the time of day also resets. The beat jumps (1–9 and 0) cut through black the same way, with a shorter fade.

## Performance budget and constraints

Target: 60 fps at 1080p on a 2022 integrated-GPU laptop (high tier), 30 fps on a 2021 phone (low tier). The budget below is for the high tier; lower tiers scale down shadows, reflections, trees, cars and bloom via `quality.json`, chosen at start from a 2 s frame-time probe. Since the realism pass the city is far heavier: about 24 ms a frame at 2880 × 1720 on an M3 (high tier, full retina), so the probe's step down to medium matters more.

| Budget item | Limit | Notes |
| --- | --- | --- |
| Triangles in view | 3 M | The city in 320 m tiles (1.6 M building triangles in all), culled per tile; chimneys and rooftop units, trees and cars instanced and drawn near the camera only; heroes ≤ 20k each |
| Draw calls | 150 in the main pass; ≤ 75 each in the shadow and reflection passes | Merge by material; trees instanced; shadow and reflection passes draw a reduced set; at most 4 real point lights, everything else emissive sprites |
| Texture memory | 256 MB | KTX2/Basis at the masters' 1024² for the facade, roof, quay and hero layers: 27 MB as ETC2. The panoramas at 4096×2048 as UASTC: 32 MB as ASTC or BC7 |
| Initial download | 90 MB (was 25 MB) | Meshopt-compressed, quantised glTF; textures streamed after first frame. About 73 MB since the realism pass: the roofed city 30 MB, the ground mask 13 MB |
| Time to first frame | 12 s | On a 50 Mbps connection: the first-frame set is about 60 MB (was at most 12 MB); progressive loading with a styled loading screen |
| Shadow map | 2048² high / 1024² medium / off low | One cascade, fitted to a 600 m box around the camera |
| Water reflection | 50% resolution planar / probe | Planar reflection costs a second scene pass; use it only near the two money shots (inside the Parliament and Chain Bridge trigger radii) on medium and high; elsewhere a probe, plus streak sprites for night lights |
| Music | 20 MB, streamed on demand | Four AAC tracks, 16.4 MB; nothing is fetched until the music is turned on, so it is outside the initial download |
| JS main thread per frame | 6 ms | Physics, spline sampling and HUD are trivial; keep allocations out of the loop |

**Constraints**

- Static site only: no server, no API keys in the client. The image API is used offline in `tools/`, never at runtime.
- OSM attribution must be visible: a persistent credit in the bottom bar, plus the About overlay.
- Hero models must not reproduce any third-party model or artwork; generated illustrations must not include real signage or text.
- The whole scene lives in one WebGL context; avoid any library that spins up its own.
- Everything must degrade. The first frame draws with the WebP set, then the KTX2 set, transcoded to whatever compressed format the GPU takes, replaces it. The WebP stays when the Basis transcoder fails to load or the GPU takes no compressed format. Fallback textures are half resolution (512² layers, 2048×1024 skies), because WebP decodes to uncompressed RGBA, four times the memory of the KTX2 set at full size. If WebGL2 is missing, show a static golden-hour render with a message.

## Milestones and build order

Build the skeleton before the skin: the route, the vehicles and the switch are proven in flat colours before any data or art goes in, so every later phase is adding to something that already works.

&#91;embedded content: build order · 5 phases, 5 gates, about 8 weeks part-time\]

Each gate is a yes/no check on a running build; the next phase does not start until the gate passes.

**M0 Grey box** is the first Claude Code task: a Vite + three.js app with a hand-placed spline for the real route (lat/lon from a map, converted at load), a bird and a boat as simple meshes, the corridor clamp and altitude floor (taken from the placeholder boxes), the 2 s landing and 2.5 s take-off transitions, manual controls, autopilot along the spline, and the time-of-day slider driving a sun, hemisphere light and the three.js sky through the sun-elevation curves. Flat-coloured boxes stand in for the city; a flat plane with a tinted material stands in for the river. No assets, no textures.

**M1 Geography** adds the `tools/` pipeline: OSM fetch, extrusion, terrain heightmap, river mesh, bridge decks and the floor grid, exported as glTF and loaded into the M0 scene. Hero positions come from `landmarks.json` as labelled placeholder blocks.

**M2 Autopilot** adds beats and camera modes, the override blend with re-join and the mode rule on hand-back, landmark trigger cards with placeholder text, pause, keyboard jumps and the loop.

**M3 Lighting** adds the full lighting curves, night light groups, emissive crossfade, generated panoramas and facade atlases, the water shader with reflections and night light streaks, bloom and tone mapping. This is where the style sheet is generated and locked.

**M4 Heroes** replaces placeholders with the ten hero models (Parliament first, then the Chain Bridge, then the rest in route order), adds effects, quality tiers, the mobile pass, and the cards' illustrations and paragraphs. Audio is parked until after M4 (see Open questions).

**After M4: music** adds the jazz (four CC BY tracks), the music button and M key, the volume setting and the credits. Music only: no sound effects.

**Working rules for the implementation**

- Every phase ends with a deployable static build and a 30 s screen recording of the autopilot run.
- `route.json` and `landmarks.json` are hand-edited and committed; never generate them at runtime.
- Keep a `docs/decisions.md` log of anything that departs from this document.

## Open questions

- [x] Hero models: modelled in code (`tools/heroes/`) on the OSM footprints, rather than in Blender or with an image-to-3D tool: neither was available, and models in code are deterministic, reviewable and fit their sites exactly. Any one can still be replaced by a hand-made glb.
- [x] Vehicle: a glider. A white sailplane that lands on the Danube and carries on as a boat, as the bird did; the bird of M0–M4 was replaced after M4. It can't hover either, so the opening two seconds glide straight on over the Japanese Garden, and paused it circles.
- [x] Narration: text cards only in V1. No voice-over, so the beat durations stand.
- [x] Image API terms: OpenAI's Services Agreement gives the customer ownership of the output, and nothing in the terms stops redistributing it in a public build and repository. The site credits the textures and illustrations as AI-generated (the terms forbid passing output off as human-made). The outputs' C2PA credentials don't survive our re-encoding, which the terms don't require keeping. The key stays in a git-ignored `.env.local`, used only by `tools/`.
- [x] Planar reflections on medium tier: keep, but only near the two money shots (Parliament and the Chain Bridge); probe and light streaks everywhere else.
- [x] Season: autumn, to match the 1 October sun. Three quarters of the trees have turned (gold, orange, rust and brown) and a quarter are still green; the grass is a tired olive and the woods' floor leaf litter.
- [x] Ambient life (trams, boats, birds): in V1, kept simple: six trams on both embankments, two tour boats, gulls over the river; off on the low tier.
- [x] Audio: music only. Four jazz tracks by Kevin MacLeod under CC BY 4.0, which allows hosting them in a public build with a credit; an `audio` module, a music button (browsers block sound until the user interacts, and the tour runs without input) and a 20 MB on-demand slot in the budget. The landing and take-off cues were tried as synthesised wind, water and city sounds and dropped: music only.
