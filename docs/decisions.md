# Decisions

Changes to the design doc and departures from it, with the reason. Newest first.

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
