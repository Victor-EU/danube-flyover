# Decisions

Changes to the design doc and departures from it, with the reason. Newest first.

## 2026-10-01 — M2 autopilot

**Camera**

- **Camera modes are keyed on route points, not on beats.** A point can carry `camera: {mode, target?}`, and the mode holds until the next key.
  - Why: the bridge under-passes and the Market Hall circle fall in the middle of beats. A point stays valid when the route is edited, where a `duration` in seconds goes stale.
  - The doc's `cameraMode`, `target` and `duration` fields on the beat are not used. `reveal` catches up by the next key instead of over a duration.
  - There are 12 keys (see `npm run timetable`).
- **`low` switches on by itself under bridge decks**, for both the autopilot and the user, rather than being keyed. The bird's 4 m-up follow camera would otherwise sit inside the deck. It lingers for 0.5 s after the deck.
- **`orbit` swings the rig around the vehicle only as far as it needs to.**
  - It keeps the target within 34° of the vehicle and aims halfway between them, so both stay in frame.
  - It never goes more than 75° from straight behind. Leaving an orbit is a 1.5 s swing, and at 97° that read as a whip pan.
  - The boat orbits from 11 m back rather than its 6 m follow distance.
- **Three orbits come from the beat descriptions, not the doc's camera list:**
  - Beat 5 orbits Parliament, which puts the Bastion in the foreground.
  - Beat 7 orbits Buda Castle ("towering above on the right").
  - Beat 8 orbits the Liberty Statue ("high on the right").
- **The Market Hall finish is `reveal` (the climb out of Liberty Bridge), then `orbit` for the circle.**
- **Mode changes blend from wherever the camera is,** in the vehicle's frame: yaw offset, distance, height, look point and field of view. A change in the middle of a blend doesn't jump.
- **Hand-back:** camera keys stay suspended until the next key is reached, which stands in for the doc's "next beat boundary".

**Cards**

- **Trigger radii widened for the landmarks on the banks:**
  - Academy 250 m, Gresham 400 m, Buda Castle 450 m, Liberty Statue 450 m, Vigadó 500 m, Citadella 500 m, Gellért Hotel 500 m.
  - The doc's range is 150 to 400 m, but the boat runs mid-river, 300 to 420 m from them, and the 40° view test only passes once they are well ahead.
- **A hands-off run shows 16 of the 17 cards.** The Gresham Palace loses to the Chain Bridge, which is nearer the centre of the view, and has passed by the time that card is gone. That is the doc's rule working.
- **Layout:** cards sit at the top right, clear of the bar and the debug panel.
- **An opened card stays until it is closed** (× or Esc), and its 8 s timer stops while it's open.
- **The opened card shows an illustration placeholder, with the note standing in for the paragraph,** until M4's illustrations and text.
- **Cards trigger in manual flight and while paused too.** The rule is about the vehicle and the camera, not the pilot.

**Pause, jumps and the loop**

- **Pause:**
  - The boat idles down to a stop: its minimum speed is 0 while paused.
  - The bird circles at minimum speed on a 60 m radius, turning the way it already was.
  - The sunset-run clock stops.
  - Pausing during the opening hover ends the hover.
- **Resuming hands control back at once** (a 2 s blend), without the 3 s idle wait. Pressing play means "carry on with the tour".
- **Space is always pause.** A focused button or checkbox doesn't also click on Space.
- **The sunset-run clock eases toward the route's clock** (1.5 s time constant) instead of following it exactly. Resuming or handing back far from where the user took over no longer snaps the lighting. Cuts (the loop, jumps) set it directly.
- **1–9 and 0 jump to beats 1–10 through black** (0.3 s out, 0.5 s in).
  - A jump hands control to the autopilot and keeps the pause state.
  - It snaps the camera and clears the cards.
- **The loop:**
  - Past the last point, the autopilot flies the circle through the route's last three points, at the last altitude and speed.
  - After 5 s it fades to black over 1 s, resets to the Japanese Garden (17:30 in the sunset run) and fades back in over 1.2 s during the 2 s hover.
  - Any input or a pause cancels the end circle.

**Code and checks**

- **Two new modules:** `cards` (the trigger rules, with no DOM; `hud` draws the card) and `tour` (the loop and the jumps). Both are in the doc's module table.
- **One simulation step (`src/sim.ts`) is shared by the browser and `tools/simulate.ts`.** It runs the autopilot, controller, vehicle, camera, cards and loop.
- **`npm run simulate` now runs 23 checks.** It flies the hands-off tour through the loop, then scripts pause (bird and boat), both hand-back mode rules, and the jumps.
  - Results: tracking within 2.0 m, no floor contacts, the loop black 5.98 s after the route ends, landing on hand-back, and take-off 4.0 s after release.

**Bugs fixed**

- **The boat's lamp was a shadow-casting point light inside the boat's group.** The vehicle mesh's `castShadow` traverse had reached it.
  - The group is hidden while flying, which drops the light from three's light list, so every landing added a light and recompiled every material.
  - At night the shadow pass is paused, so the lamp's shadow map was never created. Every standard-material draw then failed (`GL_INVALID_OPERATION`, sampler mismatch), and the boat leg rendered black apart from the labels.
  - The same code was in M1, whose landing is after sunset, so this is probably part of what M1 logged as "night is too dark".
  - The fix: the lamp now hangs off the always-visible vehicle group and casts no shadow, so the light count never changes.
- **The sun's shadow map is rendered at least once, even when the first frame is at night.** Before this, a jump straight to a night beat before any daylight frame left it missing, with the same black result.

## 2026-10-01 — M1 geography

**Pipeline**

- **The pipeline is TypeScript, run with tsx, not `.js` and `.py` scripts.** That means one language with the runtime, and the tools import the runtime's own modules (`geo`, `river`, `terrain`, `bridges`, `landmarks`), so the pipeline and the app can't disagree about a placement.
- **It has seven scripts:**
  - two fetches (`fetch-osm`, `fetch-dem`), whose raw extracts are committed in `tools/osm/` and `tools/dem/`;
  - five builds (`build-water`, `build-terrain`, `build-bridges`, `build-city`, `build-floor`), all run by `npm run build-world`.
- **What's missing from the doc's list:**
  - `build-route.js` is still `npm run timetable`, since the spline is built at load.
  - `gen-textures.js` is M3.
- **The builds are deterministic.** A second run gives byte-identical outputs.

**File formats**

- **glTF files use meshopt compression (`EXT_meshopt_compression` plus quantisation), not Draco.** three's loader bundles the meshopt decoder, so there are no wasm decoder files to ship or point at, and it decodes faster.
- **`city.glb` is 6.1 MB on the wire (2.7 MB if the host gzips it).** All of `public/data/` is 7.1 MB, inside the 12 MB first-frame budget.
- **The terrain heightmap is `terrain.bin`, not a 16-bit PNG.** Browsers decode PNGs to 8 bits per channel through canvas, which would lose the precision.
  - `terrain.bin` and `floor.bin` share one small format (`src/world/gridFile.ts`): a JSON header, then typed-array layers, the whole file zlib-compressed.
  - It's read with fflate in the browser and in Node.

**Terrain**

- **GLO-30 is resampled to 10 m.** The river level is measured from the DEM's own flattened water: 98.0 m above sea level in the north, falling to 97.0 m in the south, and subtracted.
- **Buda keeps the real hills.**
  - A morphological opening with a 70 m window removes buildings and trees.
  - Footprints too wide for it become level pads at the 75th percentile of the ground around them; a mean fill sank the palace toward the slopes below.
- **Results:**
  - Castle Hill comes out at 70 m above the river.
  - Gellért Hill comes out at 128 m. The doc's 135 m sharp summit is lost at 30 m resolution; the DEM itself reads 132 m there.
- **Pest and the islands are flattened to a heavily smoothed lower envelope.** Pest comes out at about +7 to +8 m (M0 had +4 m) and Margaret Island at +4.5 m.
- **Next to the banks, the terrain dips under the quay strip, as in M0.**

**Buildings**

- **There are 11,485 buildings in the world rectangle, with heights from three sources:**
  - 318 have a `height` tag.
  - 5,773 come from levels: levels × 3.3 m + 1 m + 2 m per roof level.
  - 5,394 take a default. The doc's 18 m applies except for:
    - small types (garages, sheds, kiosks), 3.5 m;
    - houses, 8 m;
    - churches, 20 m;
    - industrial, 10 m;
    - ruins, 4 m.
- **Skipped:** `building=roof` canopies, construction sites without levels, and `building:part`, since only outlines are used.
- **They are merged into one mesh per district** (12 districts plus "other", which is mostly Margaret Island). The roofs are flat.
- **Colours** come from a palette per bank and type, and wall bases are darkened as a cheap ambient occlusion.
- **For M3:**
  - UVs are stored in units of 1024 m so they quantise.
  - A per-building `_SEED` attribute is stored for the emissive jitter.

**Bridges**

- **Deck outlines, river piers and the Chain and Liberty pylons come from OSM.** Deck heights, tower heights and the ironwork style are set by hand in `build-bridges.ts` until M4.
- **Deck queries test the real outline polygon instead of centreline segments.** That covers the Margaret Bridge's spur onto the island.
- **The deck ramp rule:** full height over the water and 30 m past the bank, so the quay road passes under, then down at 9% to street level.

**Floor and trees**

- **Tree crowns are in the floor grid, with 4 m of clearance rather than 15 m.** The doc's floor has no trees. Without them the bird flew through the Margaret Island canopy, and 15 m above a crown pushed the opening hover far above the garden.
- **Bridge towers are flagged as towers only where they stand in the water.** On land they are simply solid.
- **There are 16,059 trees:** OSM tree points, tree rows, and scatter in woods (11 m spacing), scrub (14 m) and parks (17 m). The quays, pitches, squares, bridges and building footprints are kept clear.

**Landmarks**

- **`landmarks.json` gains two fields:**
  - `osm`: the OSM buildings the hero replaces, which the filler leaves out.
  - `placeholder`: the block's heading and parts, the M0 shapes refitted to the OSM footprints.
- **The four bridges in the route are landmarks without placeholders.** The Árpád Bridge isn't a hero.
- **Each landmark has a two-line note for M2's cards.**
- **Labels keep a constant screen size and fade out between 700 and 1300 m.**

**Changes outside the world**

- **The terrain fades out over 2.5 km beyond the world edge** instead of ending in a cliff. The water continues north and south. The doc's backdrop ring (scene layer 7) isn't in any milestone yet.
- **The About overlay is in:** the credit in the bar opens it, with the OSM and Copernicus credits. The terrain now needs the Copernicus credit as well as OSM's.
- **Route altitudes changed in four points; the run is still 9:29:**
  - The start hover rises from 20 to 28 m and the next point from 30 to 34 m, above the tree crowns around the garden.
  - The two points of the Chain Bridge dive over Buda rise from 86 to 90 m and from 56 to 60 m.
  - The headless run now has no floor contacts, with tracking within 2.0 m.
- **The sun's shadow camera is shortened and pauses at night.**
  - It now sits 1100 m up-sun from the focus and ends 400 m past it.
  - Shadow-map updates stop while the sun is down, rather than toggling `castShadow`, which would recompile every material.
  - The shadow pass peaks at 38 draw calls.
- **Measured at the beat starts:**
  - Main pass: 28–114 draw calls and 1.0–1.22 M triangles.
  - Triangles: trees about 480 k, terrain about 370 k, buildings 284 k.
- **Night is too dark with the real city.** M0's temporary night ambient doesn't carry it; M3's emissive windows and light groups are the fix.

## 2026-10-01 — M0 grey box

- **The run is 9:29 over 8.6 km.** That's from the real route, so the doc's table was regenerated from `npm run timetable`. The Japanese Garden is at 47.5342 N, further north than estimated, and the Parliament arc and the Buda swing were longer than the estimate. To shorten it: speed up the Margaret Island run or tighten the Buda loop.
- **The Parliament arc is about 130°, not 180°.** A full 180° around the dome would put both ends over Pest. The river-side arc keeps the bird over the water, facing the sunlit facade.
- **`route.json` points are lat/lon:** `{lat, lon, alt, speed, mode, hold?, beat?, timeOfDay?}`.
  - Heading comes from the spline tangent.
  - Beats are anchored to the point where they start rather than to a hand-written arc length `s`, which goes stale whenever a point moves.
  - The design doc's data-file line was updated to match.
- **The M0 river, islands, bridge lines and landmark points come from OpenStreetMap** (Overpass and Nominatim), simplified to 2.5 m. They live in `src/world/osmPlaceholder.ts` and `src/world/bridges.ts`, credited under ODbL, and M1's pipeline replaces them. This keeps the hand-placed route accurate: the boat legs sit mid-channel on the real river.
- **The override blend, windowed `nearest()` and the hand-back mode rule landed in M0 instead of M2.** Manual and autopilot have to coexist in the grey box, and these are what make that work. M2 still adds beats and camera modes, cards, pause, keyboard jumps and the loop. At the end of the route, M0 simply restarts.
- **The 2 m manual landing trigger only applies while the user has control (`w ≥ 0.5`).** Without that, the autopilot dipping below 2 m on approach landed one point early, and then took straight back off.
- **The autopilot re-derives `s` from the vehicle's position every frame** (windowed nearest) and steers by pure pursuit, instead of advancing `s` on its own clock. This means it can never run ahead of the vehicle.
- **The floor grid is built at load from the placeholder boxes;** M1 bakes `floor.bin`. Bridge decks and piers are a deck list plus obstacle boxes, not per-cell data. That gives the same under/over behaviour with simpler bookkeeping.
- **The placeholder city boxes are instanced** (one unit cube). M1's real footprints will be merged, as the doc says.
- **The sunset run is already in** and on by default, since its clock lives in `route.json`.
- **Temporary lighting until M3:**
  - Night ambient is a brighter blue than the doc's curves, so the grey box stays readable without emissive windows.
  - The water picks up a little of the horizon colour in place of reflections.
- **Vehicle:** M0 uses the bird, as the doc assumes. The open question (bird, plane or glider) is still due before M0 ends.

## 2026-10-01 — Design review pass

Everything below is already folded into the design doc.

- **The tour runs about 9 minutes, not 5 to 7.** The old beat times needed 68 m/s from the Japanese Garden to Margaret Bridge (bird max 25) and 13.5 m/s on the boat leg (boat max 8). Beat times are now computed from distance and speed by `build-route.js`, and the boat max went up to 12 m/s. To shorten the tour, speed up the Margaret Island run or cut the swing over Buda.
- **Shoes on the Danube moved to beat 4, as a low bird pass.** It is about 600 m north of the Chain Bridge, so a southbound boat leg starting there had already passed it. Its old slot is now "Buda Castle and the Promenade".
- **The landing finishes about 200 m north of the Chain Bridge**, so the boat, not the bird, passes under it. That makes money shot 2 happen as described.
- **The route flies the Parliament orbit itself** (a 180° arc on the river side), and the `orbit` camera only aims at the dome, so the vehicle never leaves frame. Camera-mode changes blend over 1.5 s.
- **Altitude floor: 0 m over water, and 15 m above a floor grid (terrain, buildings, bridge towers) over land; ceiling 180 m.** The old "15 m minimum everywhere" made manual landing impossible, and nothing stopped the bird flying through Parliament.
- **The corridor is ±300 m from the route, kept inside the world.** The world is widened to about 1 km west of the river around Castle Hill so the Bastion beat fits.
- **Hand-back: 3 s idle, then a 2 s blend.** If the route's mode differs, autopilot runs the transition first. `nearest()` only searches within 300 m of the current position along the route.
- **Lighting curves are keyed to sun elevation, not the clock.** The default time is now 18:00; the old 18:30 was after the 18:24 sunset. The sun light reaches 0 at the horizon, not at 19:00, and dawn mirrors dusk.
- **The sunset run is keyframed per beat**, still 17:30 → 20:30. A linear clock put the Chain Bridge at dusk (about 18:50); now it holds golden hour over Parliament and reaches full night (about 19:35) under the Chain Bridge.
- **Planar reflections only near Parliament and the Chain Bridge, on medium and high tiers**; stretched light-streak sprites for night lights everywhere else. This closes the open question.
- **Terrain:** GLO-30 is a surface model (buildings and trees included) with heights above sea level. The pipeline subtracts the river level and flattens Pest and building footprints, with hand-sculpting as the fallback.
- **Take-off never starts under a bridge deck or within 30 m before one.**
- **Budgets:**
  - One shadow cascade, fitted to a 600 m box.
  - A pool of four real point lights, never added or removed.
  - A first-frame set of at most 12 MB.
  - Half-resolution WebP fallback textures.
  - Draw calls counted per pass.
  - City meshes merged, not instanced.
- **HUD and cards:**
  - A persistent OSM credit in the bottom bar.
  - One card at a time, once per pass.
  - Keys 1–9 and 0 for beats 1–10.
- **Smaller fixes:**
  - Equirectangular projection instead of EPSG:23700.
  - `FogExp2`.
  - Current OSM water tags.
  - ODbL licence note on committed OSM extracts.
  - Pause behaviour for a bird that can't hover.
  - The tour ends circling the Market Hall instead of "settling" on it.
- **Audio is parked until after M4.** We'll look for freely licensed jazz then. Its landing and take-off cues were taken out of the transition specs and are listed in the open question.
