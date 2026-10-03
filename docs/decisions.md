# Decisions

Changes to the design doc and departures from it, with the reason. Newest first.

## 2026-10-03 — The far buildings, built as the world's are

The far field read as a different city. Beyond the world's tiled and slated roofs stood pale, flat-roofed boxes with drawn-on windows, so the edge showed from every high view. Now the far buildings go through the world's own pipeline and wear its surfaces; at the edge the two are hard to tell apart.

**One set of rules** (`tools/lib/cityStyle.ts`)

- build-city's heights, roof kinds, palettes, facade choice, roof coverings and pitches, and its canyon probe moved into a module both builds share. The world's output is byte-identical after the move.
- In the inner districts (the twelve polygons in `tools/osm/districts.geojson`, 73,241 of the far buildings), the rules are exactly the world's.
- In the outer districts:
  - the untagged are more often houses, sheds and halls than blocks of flats;
  - the estates' blocks of flats (14 m and up) and the industrial sheds are flat-roofed, with panel or modern facades;
  - Buda and Pest are split by the river's line.

**The build** (`tools/build-far.ts`, 5–7 minutes)

- **Roofs:** the 120,724 buildings merge into 100,421 blocks, which are roofed from their straight skeletons, as the world's are.
  - 296 blocks got no skeleton; two outlines ran CGAL's WebAssembly heap past its 2 GB and fell back to a skeleton per building.
  - That gives 101,964 pitched roofs, 1,788 mansards, 384 steep roofs and 16,588 flat ones.
- **Firewalls:** wherever a building stands over its neighbour, a firewall runs from the neighbour's roof up to its own, gables included (19,787 buildings).
- **Canyons:** the street walls carry the canyons' baked occlusion, probed at 1.2 m steps.
- **The file, `far/buildings.bin`** (format DFB3):
  - Each building holds its rings, with a party-wall flag and canyon bytes per wall, and an upper mesh of roof and firewall triangles.
  - Coordinates are varints, delta-coded.
  - Roof corners at the eaves refer to the ring's points instead of repeating them.
  - It grew from 3.3 MB to 13.6 MB. The initial download is now 91.5 MB, so the budget rose to 100 MB; the far field streams in after the first frame.

**The runtime**

- **Shader:** the world's building shader, split so the far field shares its fragment code (`patchFarBuildings`). Facade tiles go storey by storey, roof tiles are weathered, firewalls are plaster, and windows come on one by one at dusk.
  - The walls take their coordinates from the perimeter and the building's base.
  - Roofs and firewalls work theirs out from the face's own normal (along the eaves, and up the slope).
- **Geometry:** flat-shaded, with 19-byte vertices: 16-bit positions per tile, colour bytes, layer, seed and heights. It comes in chunks of up to 65,536 vertices, 106 MB of geometry in all.
- **Cost on the M3:** 0–1.7 ms in the flyover's own views, and 1.1–2.3 ms in a high overview of Pest.
- **By day:** the window lighting is skipped while the sun is above +6.5°, when none can be lit (in the world's buildings too).
- **Colours:** stored linear, as glTF's are; raw sRGB bytes had made the far field pale.

**A regression found on the way.** The realism pass (46ab8a7) changed the quads' index order, which wound the world's walls, gables, parapets, fascias and cornice tops inward:

- The near walls were culled, so you looked through them at the inside of the far walls.
- Those walls were lit as if they faced the other way, so sunlit walls came out dark and shaded ones bright.

Each quad now winds itself to face along its declared normal, and the far meshes do the same.

**What stays simple:**

- The far buildings have no chimneys, cornices or parapets as geometry; the shader's cornice band stands in for them.
- They take no shadows. Neither do the world's own blocks beyond the 600 m shadow box.
- A block cut by the world's edge is roofed separately on each side, so its roof dips at the edge.

## 2026-10-03 — The far field

The world ended a few hundred metres back from the banks, in a flat beige plain: high views showed the edge, and the Buda hills weren't there. With the user's go-ahead, two more downloads fill it with the real city.

**The data**

- **OpenStreetMap**, over a 26 km box (47.40–47.63 N, 18.88–19.22 E), from Overpass in 27 tiled queries, about 40 MB over the wire:
  - 292,711 buildings, 73,808 streets and rails, 17,789 land areas;
  - the water, 1,067 towers, masts and chimneys, and 2,018 bridge ways.
  - It's committed gzipped in `tools/osm/far/` (17 MB), with coordinates to 10 cm.
- **Copernicus GLO-30**, the same AWS tiles plus N47 E018 for the hills west of 19° E:
  - the box at 30 m, and a 50 km window at 120 m for the Pilis and the hills beyond;
  - 2.5 MB in `tools/dem/`.

**The build** (`tools/build-far.ts`, 8 s)

- **Terrain:**
  - The surface model has its buildings taken out: footprints dilated a sample, and the trees in streets, parks and gardens, where they stand 2.5 m clear of a 200 m opening. These are filled in from around them, starting from that opening.
  - The woods keep their canopy, the river gets its bed, and everything blends into the world's own terrain over 600 m, running 2 m under it inside.
  - Two grids: 40 m over the box, 160 m over the 50 km square.
- **Ground:** painted at 6 m and halved to a 2048² texture (12.5 m). It has:
  - land use, biggest first;
  - the woods in autumn colours by noise at three scales;
  - streets and rails by class;
  - every roof.
  - Alpha is the street light, so the WebP has to keep the colour under alpha 0 (`exact`); without it the encoder smeared the woods into stripes.
- **Buildings:**
  - 121,560 outside the world: all within 6 km of it, and the tall or big ones beyond. The rest are only roofs in the ground.
  - Heights come from the tags, or from rules like the world's.
  - Party walls are dropped where OSM's neighbours share nodes and stand within 3 m of each other's height.
  - Small rectangular houses get hipped roofs.
  - Each is written as a footprint (3.3 MB), not as geometry.
- **Water, bridges and towers:**
  - the water beyond the world, plus the river beyond the box from the wide grid;
  - 48 bridge decks on piers, ramping to the banks, with their lamps;
  - 548 towers, masts and chimneys, the tall ones banded red and white, with 353 aviation lights.

**The runtime** (`src/world/far.ts`)

- **Loading:** it streams in after the first frame (7 MB), compiles off the frame, then replaces the apron and frame.
- **Terrain:** chunks at 40, 80 or 160 m by their distance from the world (160 and 320 m in the wide square), with skirts.
- **Buildings:**
  - A worker extrudes them per 1 km tile, sharing vertices between walls and roof.
  - The material is flat-shaded from screen derivatives, and tells roof from wall by slope.
  - Windows are drawn by storey and bay, faded to their average where they're smaller than a pixel. A third of them are lit at random after dusk, with shopfronts below.
  - Tiles are drawn within `QUALITY.far`: 12, 7 or 3.5 km.
- **Layer and shadows:** all of it is on `LAYER.far`, out of the reflection, with no shadows.
- **Cost:** 1–3 ms a frame on the M3 (4.3M triangles in the busiest view).
- **Haze:** thinned by about a third, so the hills 7 km west show through by day.

**What stays simple:** the far buildings are boxes with flat or hipped roofs, without the world's cornices, chimneys or photographed facades. Up close at the world's edge the change shows; from the glider's usual kilometre and more it reads as the city.

## 2026-10-03 — The wake, simulated

The wake was three foam ribbons on a flat river: no waves, nothing when the boat turned or stopped. Now the water around the boat is simulated, and everything a wake does comes out of the waves themselves.

**The waves: linear deep-water theory on the GPU** (`src/world/wake.ts`, `src/world/fft.ts`)

- **The square:** 512 × 512 cells of 0.5 m (256 m), following the boat on a leash: it moves, by whole cells, only when the boat strays 69 m from its centre. So after a turn, the boat runs back over its old wake.
- **Each frame:**
  - In space, the hulls press on the water, and splashes punch craters. A band at the square's edges absorbs what leaves it, and the land, the piers and the moored craft take what reaches them.
  - An FFT turns it into waves, and each wave advances by its own phase, ω = √(g|k|). That dispersion is what makes a moving hull's waves into a Kelvin wake.
  - The inverse FFT also gives the horizontal displacement that sharpens crests and flattens troughs.
- **The FFT:** Stockham radix-8 passes, one output per fragment, so a 512² transform is six passes. The whole step costs about 0.7 ms on the M3.
- **Why not a cheaper sim:** iWave's truncated kernel, or a plain wave equation, gets dispersion wrong for the 10–90 m waves that make the V, which then comes out the wrong shape.
- **What comes out without being asked for:**
  - At 11 m/s the runabout's V is about 12° either side, narrower than Kelvin's 19.5°, as a planing hull's is.
  - The slow tour boats make the textbook pattern: transverse waves plus feathered divergent ones.
  - Turns leave curved wakes; waves run on after the boat stops; wakes cross each other.
  - Behind the transom there's a hollow, then a hump 10 m back.
- **The current:** the square lives in the water's frame, drifting 0.6 m/s downstream, so the waves, the foam and (inside the square) the ripples all drift together.

**The hulls**

- **The runabout:** an Aquarama-class 2.5 t. Afloat, its pressure follows the draft. Planing, it's a planing plate's: peaked at the spray root, nothing at the transom, highest along the keel, on the aft 3.4 m.
- **Getting the hole right:** a broad, smooth pressure dug a hole deeper than the hull draws (the boat hovered over it). The plate's profile makes 20–25 cm crests for a 30 cm depression.
- **The wash boils:** the water behind the transom heaves at random, which fills the V with short waves.
- **The tour boats** are 32 m hulls drawing 0.8 m. Every hull eases in over 2.5 s as it enters the square, so nothing starts with a ring.

**The surface**

- **A displaced patch:** rings around the camera, from 12 cm out to 100 m, are moved by the waves (mip-sampled by ring spacing). Inside the runabout's waterline the water stays under its V bottom.
- **The river:** it gives way to the patch inside the square and reads the same slopes and foam. Across the square's absorbing edge its own ripples crossfade, keeping their strength, so there's no seam.
- **Foam:**
  - Sources: the hull's wash, the spray sheets beside it and its bow wave; crests folding or steeper than 0.42; waves meeting the quays.
  - It spreads, and ages from white water (2.5 s) into lace (25 s).
  - It's drawn from a texture painted once on the GPU: froth pocked with bubbles, and marbled lace filaments. Where foam is thin only the brightest filaments show; far off, the average. A Voronoi lace looked like cracked ice.
  - Churned water glows pale jade underneath, and its ripples are smoothed: the glassy scar.
- **The planar reflection** breaks up over the waves, and foam doesn't mirror.
- **Spray:** sheets of fine droplets peel off the bow at speed, and a mist hangs over the wash.

**The boat rides the waves**

- **A probe:** five heights under the hull are read back asynchronously, a few frames late. Their high-passed mean, fore-and-aft slope and athwartships slope move the boat through a damped spring. The high pass keeps its own trim out.
- **Crossing its own wake** in a tight turn, the boat heaves 9 cm and pitches a few degrees.

**Tiers:** high runs 512² and medium 256² (128 m). Low, and any browser without float render targets, keep the old foam trail, splash ring and foam V's. A tour boat's foam V fades out while the square simulates its water.

## 2026-10-03 — The realism pass

After using it, the brief changed: the boat was too simple, the city looked like a Lego build, and the aim is now a Budapest close to reality, whatever the download. A second $20 for the image API came with it (a $28.46 cap in all), and the 25 MB budget went.

**The approach: our own city, not Google's**

- Google's Photorealistic 3D Tiles would be the closest to reality, but they need a billing API key at runtime, Google's attribution on screen, and no caching. Their daylight is baked in, so golden hour and night would be colour grading only.
- So the self-contained route was taken: no runtime map API, full time of day. It's built from the same open data, made far richer.

**The boat: a 1960s mahogany runabout** (`src/riva.ts`)

- **The hull:** 7 m, lofted from 48 stations: a V bottom, a chine and flared topsides under a rising sheer, with tumblehome and a raked, curved transom.
- **The wood:** a cambered varnished deck with pale caulking seams, mahogany planking with its grain, painted on canvases at load. The varnish is a clearcoat that reflects the sky.
- **The fittings:** pleated cream leather benches with turquoise piping, a dashboard with gauges, a wheel, and a chrome-framed curved windscreen. Also chrome rubbing strakes, cleats, a boarding ladder and twin exhausts, a sun pad over the engine hatch, navigation lights, and the Hungarian flag streaming from a staff.
- **The camera** sits further back to frame it: 7.5 m behind and 2 m up, and 6.5 m and 1.5 m under the bridges.

**Roofs from straight skeletons** (`tools/lib/roofs.ts`)

- **Blocks:** buildings that touch are merged into blocks, and each block's straight skeleton gives the roof planes. That's CGAL's, through the `straight-skeleton` package's WebAssembly build, which takes 32-bit floats, so each outline goes in about its own corner.
- **Why blocks:** a roof runs on across the party walls and slopes only to the street and the courtyards, as Budapest's do.
- **Profiles:**
  - pitched, at 34–43° with the cap at 4.2–5.8 m, chosen per block so neighbours share a roofline; deep wings get a flat top;
  - mansard, from `roof:levels` or `roof:shape`;
  - steep, for churches;
  - flat, for modern buildings and anything over 34 m.
- **Robustness:** outlines are cleaned of near-duplicate and collinear points and checked for self-crossings first. CGAL asserts on a bad ring and leaves its module broken. A merged outline that fails falls back to each building's own skeleton.
- **Speed:** CGAL's exact construction takes 10–20 ms for a few dozen corners, so the skeletons run in worker threads on every core: 11 s for 7,446 blocks, against 85–170 s on one.
- **Eaves:** buildings stand to their eaves, where OSM's `height` is to the top. Untagged ones get 15–21 m (five or six storeys), and small untagged footprints (kiosks, pavilions) 3.5–11 m.

**The rest of the city's geometry**

- **Firewalls:** where a party wall rises above its neighbour, it's a blank firewall, carried up to the roof's section.
- **Cornices and parapets:** cornices with a soffit and fascia run along the street and courtyard sides, mitred at the corners. Flat roofs get a parapet with a coping, and rooftop units.
- **Chimneys:** 55,000 of them near the ridges, with 2,900 rooftop units. They go to `roofbits.bin` and are instanced per 320 m tile, drawn within 700 m, out of the reflection and the shadow map.
- **Tiles:** the city is now one mesh per 320 m tile, so frustum and shadow culling work: 1.6M building triangles.
- **Baked street-canyon occlusion:** each street wall looks out along its normal for the first building across the street and how high its eaves stand. The shader turns the angle to that skyline into ambient occlusion on the indirect light, so narrow streets and courtyards darken toward the ground.
- **GTAO was tried and dropped:** three's GTAOPass came out black on every wall at city scale.

**The ground** (`tools/build-ground.ts`, `src/world/ground.ts`)

- **A new OSM extract,** `roads.geojson`: streets, footways, crossings, car parks, railways and piers.
- **A 1 m mask over the world** (13 MB), its channels:
  - the carriageways' signed distance, union of capsules with filleted junctions, so kerbs stay crisp at any distance;
  - lawns;
  - unpaved paths;
  - setts (Castle Hill).
- **Ground occlusion** at 2 m, from the buildings' and landmarks' skylines in 12 directions.
- **Markings as geometry draped on the terrain:** 15,800 lane dashes (the centre line solid on the big two-way roads, kept clear of 8,800 junctions), 746 zebras, and 79 km of tram rails.
- **The terrain's shader paints the photographed surfaces:** asphalt with a darker gutter, the kerb, paving slabs, setts, lawn, gravel, and the woods' litter off the paving. Irregular surfaces blend a second, rotated sample, so the tiling doesn't show.
- **At night** the street lamps' pools light the carriageways and pavements.

**Trees** (`tools/build-trees.ts`, `src/world/trees.ts`)

- **Nine species:** plane, chestnut, linden, maple, poplar, willow, oak, robinia and pine.
- **Planting:** by OSM genus or leaf type where tagged. Otherwise by setting, with neighbours tending to share a species:
  - street rows: plane, linden, chestnut, maple and robinia;
  - the banks: willow and poplar;
  - Margaret Island: plane and poplar;
  - the hill woods: oak, robinia and pine.
- **Growth:** each species grows three shapes procedurally. The trunk and limbs reach toward a noisy ellipsoid crown, and the branches come off the limbs.
- **Leaf cards:** they cluster round the branch ends and fill the crown's shell. Their normals lean out from the crown's centre, so a crown shades as a volume.
- **Leaf clusters:** drawn as SVG per species (palmate, heart-shaped, compound, lobed, pinnate, needles), with a random value per leaf. Each tree turns its own share of leaves through yellow, orange and rust.
- **Detail levels:** three, at 1,200–2,100, 190–290 and 36–80 triangles, re-sorted by distance and frustum five times a second. The wind sways the crowns.
- Mipmaps would average the cut-out away, so the alpha threshold falls with the mip level.

**The river's craft** (`src/ships.ts`)

- **Sightseeing boats:** the two that ply the river are now 32 m boats with a glazed saloon, an open top deck with benches and a wheelhouse.
- **Moored cruise ships:** 15 river-cruise hotel ships, 105–135 m, with three decks of windows, a sun deck with awnings and loungers, and the bridge forward. They lie at the real landing pontoons (OSM `man_made=pier`), mostly along the Pest bank.
- **Pontoons:** 66 steel pontoons with shelters and ramps.
- **At night** their panes light one by one. The ships and pontoons are in the glider's floor.

**Traffic** (`src/world/traffic.ts`)

- **Parked cars:** 53,000 along the side streets' kerbs.
- **Moving traffic:** 1,400 cars wander the main roads' graph, keeping right and turning at random at junctions, with head and tail lamps after dusk.
- **Bodies:** five types lofted in code, each with its own paint, drawn within 650 m of the camera.

**Photographic textures and cards**

- **The prompts:** they now ask for photographs of the real materials, with no style sheet attached.
- **New layers:** plaster (for the firewalls and trim), and the five ground surfaces. These are levelled to calibrated brightness, asphalt dark and paving pale.
- **The cards:** re-rendered from the new scene, then turned into photographs of the real place, keeping the composition.
- **Cost:** 81 answers (64 for the textures, seam repairs included, and 17 cards) for $4.63, run six at a time. That's $13.09 spent of the $28.46 cap.

**Smaller changes**

- The moon is half a degree across, as it is.
- The glider is smooth-shaded and reflects the sky.
- The wake starts at the runabout's transom.
- A cars share was added to the quality tiers: medium draws 60%, low none.

**Downloads**

- About 60 MB for the first frame and 73 MB with the full-size textures and the cards: `city.glb` 30 MB, the ground mask 13 MB.
- The simulator's budgets are now 70 and 90 MB, to catch an accidental blow-up rather than to constrain.

## 2026-10-02 — Full-size skies, the last simple heroes, and the 2048² layers left out

The gaps after KTX2: the design's 4096 × 2048 skies and 2048² hero textures, the heroes M4 left simple, and a recording from before the glider.

**Skies at 4096 × 2048**

- **The masters are painted at 4096 × 2048**, the same painting sampled finer, about 10 s each. The first frame's WebP is the master scaled to 2048 × 1024 (still about 30 KB each).
- **The full-size set gains a UASTC KTX2 file per sky,** with RDO and zstd and no mipmaps, like the WebP: 2.4 MB for the four (dawn 780 KB, day 584 KB, golden 922 KB, night 156 KB). On the golden sky:
  - ETC1S was 159 KB but 40.6 dB, with errors up to 52 in blue that band the gradients;
  - UASTC with RDO is 54.3 dB;
  - without RDO it was 63.6 dB but 1.2 MB, not worth the extra 300 KB.
- **On the M3 they transcode to ASTC** (BC7 or ETC2 elsewhere), a byte a pixel: 32 MB on the GPU, the same as the half-size WebP skies decoded to RGBA. The debug panel reads `KTX2 1024², ETC2; skies 4096 × 2048, ASTC; 59 MB`.
- **They swap in with the layers,** through uniforms the dome shares with the texture set. Both sets now wrap round the compass, so the filter blends across u = 0/1 instead of clamping at the seam.
- **Close up, the thin cloud wisps are visibly sharper,** and the clear gradients show no banding.
- The download is 20.7 MB with the full-size set and the cards, within the 25 MB. `pack-textures` takes about 3 minutes.

**The 2048² hero layers are left at 1024²**

- **The design's 2048² was one texture per hero.** The heroes use tiling layers instead (see M4 heroes), so a 1024² layer over 4–15 m of wall is already 70–256 px per metre. The glider's camera (70° tall, on a 1600 px screen) resolves the gothic layer's 100 px per metre only within about 11 m, closer than the floor lets it fly.
- **The image API prices by output tokens, which scale with pixels.** A 2048² answer would cost about four times a 1024² one, about $0.22. With each day layer's seam repaints that's about 32 requests, roughly $7; the earlier estimate of $1.20–1.50 used the 1024² price. Sizes over 2560 × 1440 are also experimental for the API.
- **The hero layers are 3.4 MB at 1024²**, so the download would grow by about 10 MB, to about 31 MB, over the 25 MB budget.
- Not done, and nothing spent: it would need a decision to spend and a bigger download budget.

**The last simple heroes**

- **New in the kit:**
  - `Facade`, a wall's plane for the features set on it;
  - `portal`, an arched doorway or window standing out of the wall, with its reveals and a band round it;
  - `rose`;
  - `statue` (the palace portico's figure, which now uses it, its model unchanged byte for byte);
  - `band` for plinths, string courses and cornices;
  - `parapet`;
  - `dormer`.
- **Matthias Church** (186 → 1,148 triangles):
  - buttresses with pinnacles along the nave at the lancet layer's bay lines and round the apse;
  - the west portal under a rose window, and the south porch over the Mary portal;
  - diagonal buttresses at the tower's foot, crockets up its spire and a band at the spire's foot;
  - finials on the great roof's gables.
- **The Central Market Hall** (150 → 1,332):
  - stone bands: the plinth, a course between the two rows of arched windows, and the cornice;
  - pilasters along the long walls;
  - the main gate and two side doors, under the great arched window in the gable;
  - on the towers, belfry arches, a gablet on each face of the spire, corner pinnacles, and taller spires.
- **The Academy, Gresham Palace and the Vigadó** share one builder: walls with a plinth, a string course, a cornice and a parapet, with the mansard behind it. Bays stand out of the fronts and rise a storey over the cornice under their own crown, with arched doorways and dormers.
  - The Academy (1,246): corner pavilions with the six scholars' statues, two on each of three corners; the main hall's bay on the Danube front; and the entrance bay on Roosevelt tér with three arched doors.
  - Gresham Palace (662): the arched gateway to its arcade, under a curved gable with a great window, and a pavilion at each end.
  - The Vigadó (1,339): the arcade of five arches, the crenellated attic between two domed turrets, and a pavilion at each end.
- They follow the buildings in broad strokes from reference; the ornament stays in the texture layers. The 16 hero files are 1.1 MB. The floor grid is rebuilt, with 3,669 hero cells.

**The 30 s recording** is redone with all of the above: `tools/out/timelapse.webp`, 300 frames, 6.7 MB.

## 2026-10-02 — KTX2 textures

The last item M3 and M4 left: KTX2/Basis compression, and the full-size set.

- **The encoder** is `ktx2-encoder` (MIT, a dev dependency), Basis Universal v2.5 built to WebAssembly: `basisu` and `toktx` aren't on this machine. `tools/lib/ktx2.ts` drives the encoder directly.
- **ETC1S at quality 255, with mipmaps.**
  - A 1024² facade is 215 KB. UASTC (with RDO and zstd) was 808 KB, too much to download 40 of.
  - At full size, ETC1S beats the half-size WebP the app showed. Against the master, a facade measures 33.7 dB PSNR, where the WebP stretched back up was 23.0 dB, and a lit layer 41.6 dB against 37.6 dB.
- **A file per layer, stacked into the array textures at load.** The encoder caps a file at 12 Mpix, which is less than the dozen 1024² surface layers. This way a changed master also re-encodes only its own file.
- **What's full size:** the facade, roof, quay and hero layers, at their masters' 1024². The design's 2048² heroes would need bigger masters.
  - 40 files, 7.2 MB, about 2 minutes to encode.
  - The encoding is deterministic, so an unchanged master writes the same file.
- **Left as WebP:**
  - the skies: their masters are the WebP's own 2048 × 1024, and on their gradients ETC1S was worse (39.5 dB against 45.8 dB);
  - the water's 512² normal map.
- **Loading:**
  - The first frame draws with the WebP set, as before.
  - Then the KTX2 files load and three's KTX2Loader transcodes them in workers. It finds its transcoder (0.58 MB) through `import.meta.url`, which Vite resolves in the dev server and copies into the build's `assets/`. (A plugin first served it at `basis/` as well, which shipped it twice.)
  - The layers are stacked, uploaded and swapped in all at once, through uniforms the materials share. The WebP set is then released.
  - It stays on the WebP when the GPU takes no compressed format, since RGBA at full size would be four times the memory, or when anything fails (tried with one file missing).
  - `?textures=webp` keeps the WebP, to compare. Recordings (`?record=`) wait for the full-size set.
- **On the M3:**
  - ETC1S transcodes to ETC2, natively: 27 MB on the GPU, where the WebP set was 62 MB decoded.
  - Fetching, transcoding and uploading took 0.77 s locally. Uploading the 12 surface layers (8 MB) took 9–16 ms; BC7 would be twice the memory and took 22–61 ms.
  - A fixed view renders about 1 ms faster with it: 15–21 ms against 16–22 ms, at 2560 × 1600.
  - Close up, the facades' ornament and the quay's stone are sharper, and no block artefacts show.
- **Budgets:** `npm run simulate` now checks them.
  - The first-frame set is 9.7 MB, inside its 12 MB.
  - With the full-size textures and the cards it's 18.1 MB, inside the 25 MB initial download. The music stays outside it.
  - The bundle grew by 61 KB for the loader.

## 2026-10-02 — Hero detail

M4 left three heroes simple: "the palace's long front repeats one bay, the Elisabeth Bridge's pylons are plain portals, and the lions are blocks."

- **Buda Castle.** The footprint already has the river front's two projecting wings and its centre, but the whole palace stood at one height under one mansard.
  - The wings now rise a storey above the cornice, the facade's next row of windows, and each has its own hipped roof.
  - The mansard is lower (a 4.4 m rise, from 6.5 m), so the wings and the dome stand out of it.
  - The centre under the dome is a portico: six giant columns on a balcony over the lower storeys, then an entablature, and an attic with a statue over each column.
  - Both are found from the footprint (its walls facing the river), not placed by hand.
  - 869 → 1,401 triangles.
- **The Chain Bridge lions** are couchant now:
  - the body, haunches, mane, face, outstretched forelegs and tail;
  - on a plinth with a base, a die and a cornice.
  - They're lofted with a new kit primitive (`loft`: elliptical sections along a path, capped at both ends).
  - **Smooth stone:** the API's plain layer has joints, which ran across the carving, so the lions take their texture from one point inside a single block.
  - They face the same way as before. 8,234 → 9,706 triangles for the bridge.
- **The Elisabeth Bridge's pylons:**
  - a segmental arch under the top crossbeam;
  - a saddle on each leg where the cable runs over (a plate and a rounded cover);
  - stone footings where the legs meet the ground.
  - 6,636 → 7,012 triangles.
- **Unchanged elsewhere:** `tube` now builds its rings with the same code as `loft`, and the other heroes' files are byte-identical. The floor grid changed over the palace (the wings' roofs and the statues), the city and the trees didn't, and `npm run simulate` passes.
- **The three cards were repainted** from new renders of the new models: $0.18, which makes $8.46 of the $20 in all. The palace and the Chain Bridge left `FIRST_RUN` for the current prompt, and all three kept their render's sky.
  - The other 14 renders were put back as they were. Every new render differs a little, as the trams, boats and gulls move, and a changed render would be asked again.

## 2026-10-02 — The reflection's draw set

The doc's "reflection passes draw a reduced set", left over from M3 and M4.

- **A coarse terrain stands in for the full one in the reflection.** The pass already left out the water, its streaks, the trees and the labels. Of what was left, the terrain was two thirds: 0.42 M of the pass's 0.50–0.75 M triangles, drawn whole in every reflected frame.
  - The coarse one takes every 4th sample (40 m), with the same material: 27 k triangles. Each vertex averages its block's colour and street glow, so the streets don't alias at night. The river bed is left out of a bank's average, so the banks don't darken.
  - Layers: the full terrain has its own (`LAYER.terrain`), which the reflection leaves out, and the coarse one is on `MIRROR_ONLY`, which only the reflection draws. Any camera that draws the scene enables `LAYER.terrain` (the cards' recorder does).
- **Result over a whole run:** the reflection pass is 0.11–0.35 M triangles, at the same 19–43 draw calls. On the M3 at 1024 × 768 (half of 2048 × 1536), the pass went from 1.35–1.7 ms to 1.1–1.5 ms. That's measured by batching 30 passes between syncs; ANGLE's Metal timer queries gave numbers that didn't add up. A weaker GPU, which spends more on vertices, should gain more.
- **The look is unchanged:** at four frames between golden hour and night, under 0.15% of pixels differ by more than 12 levels, all on the reflected quay line.
- **Left as they are:** the buildings, about 0.15 M triangles in the pass on average. Inland Pest is mostly hidden behind the riverfront in the reflection, but its meshes are by district, so leaving it out would mean splitting the city by distance from the river for a small gain.

## 2026-10-02 — The image-API set

The committed textures and card illustrations now come from OpenAI's image API, `gpt-image-2.5-sunburst` at "high", using your key. The set is 71 answers. With the trials and redos below, 129 were paid for: $8.46 of the $20 budget, $6.65 for the textures and $1.81 for the cards. The last three cards were repainted when their heroes gained detail (see the entry above). The procedural set is still the default for a run without a key. The site credits the API set as AI-generated (About, under Images).

- **What was made:** the style sheet, eight facades with lit twins, four roofs, the quay, thirteen hero layers (six with lit twins) and seventeen card illustrations.
- **Layout guides.** The model doesn't keep to a grid it's only told about.
  - The first facade came back with three uneven storeys, the ground floor taking 40% of the height. The shader maps one storey to each quarter of the tile, so it couldn't use that.
  - So each texture repaints its procedural twin, drawn to the exact grid, given as the first image; the style sheet goes second. The guided facades all have four equal storeys and four bays.
  - **Unguided surfaces can come back as something else entirely.** The quay, the hero tiles and the slate roof came back as the style sheet's riverside scene, and the flat roof as a building plan.
  - Only the tile and copper roofs stay unguided. Their unguided answers were the better ones; guided, their seam repairs went wrong.
- **Neutral colour.** Every day texture is tinted at runtime: the city's by building, the heroes' by face. The model paints in colour, for example cream plaster when asked for near-white. So each texture is scaled channel by channel until its brighter half averages what its procedural twin's does. The tints and the lighting then work as they were tuned.
- **Seams.**
  - An axis is repaired only where its seam stands out: more than 1.25 × the typical difference between neighbouring pixels, plus 2. Most guided answers already tile, because their guide does, and a repair can only add a band that doesn't line up. The quay's first repair left a strip of ghost joints.
  - Each repair is checked against what it replaced. One that strays (the sheet metal's band came back as a strip of the city) is asked once more with a plainer prompt. The check rejects a repair that differs by more than 2.4 × its band's own contrast, or shifts a channel's mean by more than 40.
  - The printed seam error now sits beside the typical difference between neighbouring pixels. A hard edge in the pattern can land on the border; on the secession facade that read as a seam of 35.
- **Lit twins:** night − 0.85 × day, minus a floor of 8. The floor clears the faint wall glow the secession facade had left, which would have shown as pale rectangles around its lit windows.
- **Cache and cost.**
  - Answers are cached by a hash of the whole request, so a changed prompt or guide asks again instead of reusing a stale answer.
  - `spent.json` totals every answer across runs, and `--budget` stops a run before a request could go over.
  - Measured costs: $0.04 for the style sheet, which sends no images; $0.054–0.075 for an answer with reference images; $0.06 for a card. The dry-run estimate was about 30% high.
  - The cache, `assets/raw/api/` (252 MB), isn't committed. Keep a copy: without it, a rerun pays again and paints different images. The app only needs `public/data/`.
- **Cards:** the renders were recorded again with the new textures before the repaint, so each illustration starts from what the flyover now shows. The repaint keeps the render's viewpoint and composition, and paints in the detail, autumn trees and light.
  - **Skies.** The first run opened each card's prompt with the textures' rules, "no sky colour, no time of day", and 10 of the 17 came back with plain cream paper for a sky. Those rules now live in `surface.txt`, which only the textures and the style sheet get, with their text unchanged, so their cached answers still match. The 10 were asked again with the style alone and `card_sky.txt` ($0.60), and all kept their render's sky. The other 7 kept theirs the first time. They kept the first run's prompt (`FIRST_RUN` in `tools/cards.ts`), so their answers stayed in the cache. Two of them, the palace and the Chain Bridge, have since been repainted the current way.
- **Size:** detail compresses less. `public/data/tex/` grew from 0.66 MB to 1.85 MB, and the cards from 0.27 MB to 1.07 MB. The cards load as each one comes in. Without them and the music, the first-frame set is 9.6 MB, inside the 12 MB.

## 2026-10-02 — Glider, autumn, text cards and the image API

Four open questions closed.

- **The image API will make the textures and the card illustrations,** with a key you supply. (They were made the same day: see the entry above.)
  - **Model:** `gpt-image-2.5-sunburst`, the precise one of OpenAI's current pair, best at keeping to a reference. M3's code named `gpt-image-1`, which shuts down on 2026-10-23.
  - **Terms:** OpenAI's Services Agreement gives the customer ownership of the output, so it can go in a public build and repository. The site will credit it as AI-generated, since the terms forbid passing it off as human-made. The outputs' C2PA credentials don't survive our re-encoding, and keeping them isn't required.
  - **The key** goes in a git-ignored `.env.local` and is read only by `tools/`. The runtime never sees it.
  - **What it makes:**
    - the style sheet;
    - the eight facades and their lit twins;
    - four roofs and the quay;
    - the thirteen hero layers, at their tiles' own aspect, with lit twins for the six window layers (new prompts in `tools/prompts/hero_*.txt`);
    - the seventeen card illustrations.
  - **Seams:** the API can't make a tile, so each day texture has its seams repainted. It is shifted by half so the seams meet in the middle, a masked edit repaints a band over them, and only that band is blended back. Shifts are by whole bays and storeys, so the windows keep the grid the night lighting lights them by; facades shift only sideways, keeping their ground floor at the bottom.
  - **Cards:** each card is a repaint of its scene render, so the picture keeps the flyover's own composition and hour. The render goes in first and the style sheet second.
  - **Cost:** `--dry` lists 84 requests, an estimated $7.70 at "high" (67 for textures, 17 for cards). A real run totals the cost from the tokens each answer reports. Every answer is kept in `assets/raw/api/` and reused, so a rerun or a crash never pays twice.

- **The vehicle is a glider.** It replaces the bird of M0–M4.
  - The model is a white low-poly sailplane in code (`src/vehicleMesh.ts`): a slim pod with a dark canopy, a tail boom, 7.4 m of tapered wing with dihedral and winglets, red tips and a red T-tail. Navigation lights (red to port, green to starboard) brighten at night for the bloom to catch.
  - It still lands on the Danube and carries on as the boat, swapped behind the splash.
  - **It can't hover, so the opening hold glides.** The two seconds before the tour now carry it straight on over the Japanese Garden instead of holding it still in the air. Route timings are unchanged. Paused, it circles, as the bird did.
  - Flight limits, camera offsets and the route are unchanged.
  - The code says glider throughout: the mode is `GLIDER`, `route.json`'s legs are `"glider"`, the config is `GLIDER` and the floor query `gliderMin`. The gulls are still birds.
- **Autumn.** The sun is set for 1 October, and now the trees match.
  - Three quarters of the crowns have turned, in a weighted mix of linden and maple gold, orange, rust and oak brown; a quarter are still green. The mix drifts slowly across the city, so neighbouring trees turn together.
  - The parks' grass is a tired olive, the woods' floor is leaf litter, and the sports pitches stay greener.
  - The card illustrations were re-rendered in autumn.
- **Text cards only in V1.** No voice-over, so the beat durations stand.

## 2026-10-02 — Music

- **Music only, no sound effects.** The landing and take-off cues from the open question were built first: wind as the bird and water lapping, hull hiss and a distant city as the boat, all synthesised from noise and crossfaded over the transitions, with a splash at touchdown and spray and wingbeats at lift-off. Listening to them, we dropped them: the jazz carries the flyover better on its own.
- **Four jazz tracks by Kevin MacLeod (incompetech.com), CC BY 4.0:** "Bossa Antigua" and "Backbay Lounge" by day, "Smooth Lovin" and "Night in Venice" by night.
  - Chosen from a licence-checked search of CC0, CC BY and public-domain jazz. MacLeod's 2017 jazz set is the best-recorded music whose licence allows hosting the files in a public build, and it downloads directly.
  - The search turned down: anything NC or ND; Pixabay, YouTube Audio Library and Bensound terms; tracks marked as AI-generated; and public-domain recordings. Recordings that are public domain in both the US and the EU are pre-1926 78s, decades before cool jazz.
  - Sascha Ende's piano trios (also CC BY 4.0, ende.app) were the best night candidates but need an account to download.
  - The credit follows incompetech's format: title, "Kevin MacLeod (incompetech.com)", the licence with its link, and a note that the tracks are trimmed, levelled and re-encoded, since CC BY asks for changes to be indicated. It is in the About overlay.
- **`npm run audio` (tools/audio.ts) prepares them.** The originals are downloaded by hand into `tools/out/audio/` and not committed. The tool:
  - trims the silence at the ends;
  - measures the loudness (BS.1770, K-weighted and gated);
  - writes the gain and the length into `audio.json`;
  - encodes AAC at 128 kb/s with macOS's afconvert, with the MP4 header times zeroed so a rerun reproduces the files.
  - The target is -19.5 LUFS, the loudest that the most quietly mastered track reaches with its peaks at -1 dB. "Night in Venice" is mastered 8 dB hotter than the rest and plays at a gain of 0.4.
  - 16.4 MB for 17 minutes.
- **The music streams on demand and is off until turned on**, from the speaker button in the bar or M. Browsers block sound until the page has been interacted with, and the tour runs without input. The choice is remembered, and when it's on, the first click or key of a later visit starts the music. Nothing is fetched before then, so the 16.4 MB sits outside the initial download.
- **Two media elements crossfade over 6 s into the next track.** Each next track is the light's next, and each light's tracks take turns. A hands-off pass hears "Bossa Antigua" at golden hour, then "Smooth Lovin" from 4:35 (after dusk) and "Night in Venice", which carries over into the next pass. That pass then has "Backbay Lounge" at golden hour, so all four play within two passes (checked by `npm run simulate`).
  - The volume is a Web Audio gain (iOS ignores a media element's own volume), with a safety limiter.
  - The music pauses with a hidden tab, since the tour stops there too.
- **The About overlay's Settings gain a music volume.**

## 2026-10-02 — M4 heroes

**Hero models**

- **The heroes are modelled in code, not in Blender or by an image-to-3D tool.** This closes the open question.
  - A small modelling kit (`tools/heroes/kit.ts`) builds faceted walls, caps, prisms, spires, domes (lathes), hipped, gabled and mansard roofs, beams and tubes, and `npm run build-heroes` writes one meshopt-compressed glb per landmark to `public/data/heroes/`.
  - Why: neither tool is available here, and a model in code is deterministic, reviewable and rebuilt in seconds. It also sits exactly on its OSM footprint, and the bridges on the same decks, towers and cable curves the runtime queries and hangs its lights on. Any one file can still be replaced by a hand-made model.
- **Each building stands on its real footprint.** The walls go down to the lowest ground under it (the hill falls away to the river), and the window layers fit a whole number of bays and storeys to every wall, so no window is cut by a corner. Mansard roofs inset the footprint, falling back to a smaller inset where it would fold over.
- **The ten heroes, in the design's order:**
  - Parliament: the river wing, central block and east wing from OSM, four storeys of tracery windows, steep red roofs, the river pavilion, two chamber blocks and the end pavilions with spired corner turrets, a pinnacle on every buttress, and the 16-sided drum with its ribbed dome, lantern and spire, 100 m up (96 m real; the doc allows 15%).
  - Chain Bridge: the two triumphal-arch towers on their cutwater piers, two chains a side on the runtime's curves (the bulbs sit on them), hangers every 5.5 m, the railings, anchorages and four lions.
  - Margaret Bridge: six steel arches under the deck between the piers, bending at the island spur, with sculpted pylons over each pier.
  - Fisherman's Bastion: plain walls down the hillside, the cloisters' arches along the top, merlons, and the seven turrets with their conical roofs.
  - Matthias Church: one great Zsolnay roof over nave and aisles, the chancel and apse, the 80 m Matthias tower and the Béla tower.
  - Buda Castle: the palace on its footprint with a copper mansard, and the colonnaded drum and dome over the river front.
  - Elisabeth Bridge: white portal pylons, the main cables and hangers.
  - Liberty Statue: the stepped base, the 26 m pedestal, the figure holding the palm frond across, and the two figures at its foot.
  - Gellért Hotel: the secession front with its domes, the big one over the baths' corner.
  - Liberty Bridge: the green truss on the runtime's top-chord curve, the portals over the piers and the four masts with their turul birds.
  - Central Market Hall: brick walls, the Zsolnay gable roof with a glazed ridge, and the two front towers.
- **The other landmarks are modelled with the same kit, so no placeholder block is left:** the Academy, Gresham Palace and the Vigadó (facade, cornice and mansard on their footprints), the Citadella's walls, and the Shoes on the Danube (sixty pairs along the quay edge). The Japanese Garden has no model: it is the island's terrain, ponds and trees.
- **Sizes:** 16 files, 1.0 MB. The largest is the Margaret Bridge at 13,270 triangles, then Parliament at 10,113; every one is under the 20k budget.

**Hero textures**

- **Thirteen 512² layers in a second array texture,** at the WebP fallback size like the facades: six window layers with lit twins (Parliament's tracery, the palace, secession, the Market Hall's brick, lancets whose glass glows red, blue and gold at night, and the Bastion's arcades), and seven materials (ashlar, roof tiles, Zsolnay tiles, copper, iron, plain and metal). 243 KB.
- They tile, rather than the design's 2048² texture per hero, because the models repeat their parts. Most are near-white detail tinted per face; the brick, the Zsolnay tiles and the stained glass carry their own colour. Roughness is set per layer, so the glazed tiles and the metal shine.
- **Night:** the heroes take the M3 floodlight patch, scaled per face (roofs and domes take less), and their windows come on one by one between +2° and −11°, with a third never lit. The strengths were retuned for the real models: Parliament 1.44 → 1.15, the palace 1.17 → 1.0.

**Pipeline and data**

- **`build-heroes` is step 5, before `build-city`.** It writes `tools/out/heroes.json`: the 5 m cells each hero stands on, at its triangles' tops. `build-floor` raises those cells, so the bird can't fly through a spire, and the city and the trees keep clear of them.
- **`landmarks.json` drops `placeholder`** for `model`, `height` (the aim point is half way up, the label above it), `base`, `text` (the card's paragraph) and `illustration`. `osm` also lists the Citadella's fort.
- **The four hero bridges come from bridges.json through the runtime's own `Bridges`:** the deck slab, `cables()`, `towers()` and `deckLamps()`. The runtime then skips their meshes but keeps their queries and lights. The Árpád Bridge, not a hero, is still M1's blocks. Bridge sights still aim at the deck.
- **`build-life` (step 8) traces the embankment tram lines** from the OSM tram ways, which carry no line numbers, as the longest run of track alongside each main bank. That gives 2.0 km on Pest (tram 2) and 3.0 km on Buda (trams 19 and 41), in `life.json`.

**Effects and ambient life**

- **The boat's wake:** a churned trail behind the stern and two arms spreading at about 19°, over the last 100 m. The foam breaks up into patches as it ages and fades over 14 s.
- **The landing splash** (a ring and 120 droplets at 0.6 s) and **the take-off spray** (90 droplets and a ring at 0.3 s), at the times in the transition specs.
- **Ambient life is in V1, kept simple.** This closes the open question.
  - Two tour boats loop down the east side of the river and up the west, from below Margaret Bridge to above Liberty Bridge.
  - Six yellow trams run on the two tram lines.
  - 35 gulls circle in five flocks over the river, and roost at night.
  - The boats' and trams' windows light up at night.
  - The low tier leaves all of it out. In all it adds 9 draw calls.

**Quality tiers**

- **`quality.json` holds three tiers:**

  | Setting | high | medium | low |
  | --- | --- | --- | --- |
  | Pixel-ratio cap | 2 | 1.5 | 1 |
  | Shadow map | 2048 | 1024 | off |
  | Planar reflections | on | on | off |
  | Bloom | on | on | off |
  | MSAA | 4 | 2 | 0 |
  | Trees | 100% | 60% | 35% |
  | Anisotropy | 8 | 4 | 2 |
  | Ambient life | on | on | off |

- **The start tier is high on desktop and medium on touch devices.** The design's 2 s probe then runs in the opening hover, and steps down a tier (twice at most) while the median frame takes over 22 ms. `?quality=low|medium|high` fixes the tier, and the About overlay has a selector.
- **Changing tiers recompiles nothing:**
  - shadows go off by the shadow's intensity, with a tiny map rendered once;
  - MSAA changes by reallocating the targets;
  - trees change by instance count, with the instances shuffled so a share thins every park evenly.
  - The program count is 40 from the first frame through dusk, the jumps and every tier change.

**Mobile pass**

- **Portrait:** the vertical field of view opens until at least 46° shows across (95° at most), so the bird and the orbit target stay in frame on a phone held upright.
- **Touch:** dragging up and down climbs or dives as the bird and sets the speed as the boat, so a touch screen can take off. The hint uses touch wording on touch screens.
- **No WebGL2:** the message is shown over a still of golden hour over Parliament (`public/fallback.webp`), rendered by the app.

**Cards**

- **The opened card shows an illustration and a paragraph.**
  - The illustrations are renders of the scene: `?record=cards` takes each landmark from a set viewpoint and hour (the bridges and the riverfront at night, the hills by day, Parliament at golden hour). `npm run cards` gives them a painted finish and writes 720 × 450 WebP, 272 KB for all 17.
  - They stand in for the design's image-API illustrations, which need a key. They also match the world, and contain no third-party imagery or text.
- **The paragraphs are our own,** 50–70 words each, in the new `text` field.

**Code and checks**

- **New modules:** `effects`, `quality` and `world/heroes`. New tools: `build-heroes`, `build-life` and `cards`, with the models in `tools/heroes/`.
- **Shader patches stack** (the heroes take `hero` and `floodlit`), with declarations inserted in order. `NIGHT_GLSL` and `HASH_GLSL` are guarded against double inclusion.
- **`npm run simulate` has 34 checks:** M3's 28, plus every model built, no placeholder left, every card's text and picture, the floor over the heroes (dome 106 m, statue 162 m), the quality tiers, and the two tram lines on land.
- **Measured on the production build** at 1280 × 720 (2560 × 1440 drawn) on an Apple M3:
  - 51–131 draw calls and 1.1–2.6 M triangles over all passes at the beat starts. That is fewer calls than M3's 85–194, since each hero is one mesh where a placeholder was several.
  - Median frame times:

    | Tier | Chain Bridge at night | Parliament at golden hour |
    | --- | --- | --- |
    | High | 17 ms | 24 ms |
    | Medium | 15 ms | 16 ms |
    | Low | 8.3 ms (the 120 Hz cap) | 8.3 ms |

    So the probe would settle this machine at this size on medium.
  - No console errors. `public/data/` is 8.4 MB and `dist/` 9.6 MB.
- **The 30 s recording:** `tools/out/timelapse.webp` (7.2 MB, not committed).

**Not done yet**

- KTX2 and the full-size texture set (as in M3).
- The image-API textures and illustrations (they need a key, and the API-terms question is still open).
- Audio, parked until after M4: it is next.
- The heroes are right in layout and silhouette, but simple in detail. The palace's long front repeats one bay, the Elisabeth Bridge's pylons are plain portals, and the lions are blocks.
- A reduced draw set for the reflection pass (as in M3).
- The vehicle question is still open (the bird is kept).

## 2026-10-02 — M3 lighting

**Textures and the style sheet**

- **The texture set is procedural, not generated by the image API.** No API key was available, and an offline, deterministic set has no licence question (the doc's open question on the API terms).
  - `npm run gen-textures` paints everything into `assets/raw/` (lossless PNG, not committed: it is reproducible); `npm run pack-textures` makes what the app loads, `public/data/tex/` (411 KB). `npm run textures` runs both.
  - The facades and roofs are SVG, rasterised by sharp (librsvg); the skies and the water normal map are painted per pixel.
  - The design's API path is written but **untested**: `gen-textures -- --api` with `OPENAI_API_KEY` set generates the style sheet once (then it's locked), and every facade, roof and quay texture with the sheet attached, writing a 2 × 2 tiled copy of each to `assets/raw/check/` for the seam check. Prompts are in `tools/prompts/`. The lit facades are generated from the day ones and reduced to what the night adds. The water normal map and the skies stay procedural.
- **The style sheet is `docs/style-sheet.webp`:** a riverside street at golden hour and the same street at night, built from the textures themselves, with the palette as swatches. The palettes it shows are locked in `tools/textures/` (facade, roof and sky colours).
- **WebP at the doc's fallback sizes for now:** 512² surface layers and 2048 × 1024 skies, about 62 MB once decoded. KTX2/Basis needs an encoder this machine doesn't have (`basisu` or `toktx`); it can come with the full-size set.
- **Eight facade styles** (Pest eclectic, Pest classicist, secession, Buda baroque, Castle District, modern, prefab panel, villa), chosen in `build-city` by building type, district and height, plus four roof kinds (tile, slate, copper, flat).
  - Each is one tile of 4 bays by 4 storeys (3.4 m each): the bottom row is the ground floor, and the three above repeat up the building, so a 9-storey block keeps one ground floor.
  - Facades and roofs are near-white detail tinted by the building's own colour (`tintGain` 1.22), so one style covers a district without every block matching.
  - The 8 facades and 4 roofs are one array texture (and the 8 lit layers a second), so the merged district meshes still draw in one call each.
- **`_lit` textures are emissive layers:** black wherever nothing glows. The doc's "same facade, windows glowing" pair would make the walls glow too; the API path subtracts the day facade to get there.
- **`city.glb` gains `_FACADE`** (layer and wall height) and loses the baked wall-foot darkening: the shader does the ambient occlusion from the height above the base, and a cornice line at the roof. It got smaller: 6.1 → 5.3 MB.

**Sky, sun and moon**

- **The sky is three's Preetham model (its shader copied into `src/sky.ts`, its own clouds off) mixed with the painted panoramas,** which carry the clouds and most of the colour (55% of the mix by day).
  - Dawn (mornings) or golden hour (evenings) blend into day between 14° and 4° of sun elevation; the night panorama crossfades in between −6° and −12°, as the doc says.
  - **Blue hour has no panorama of its own:** Preetham's sky goes black a degree or two below the horizon, so the painted sky carries it, dimmed and tinted blue between 0.5° and −6°.
  - **A soft knee on the Preetham sky:** near a low sun its Mie glow reached about 50 (linear) and blew out a third of the frame and all the fog.
  - Stars (twinkling, hidden by clouds) and a moon disc are drawn in the shader.
- **The hemisphere and fog colours are sampled from the dome by a CPU twin of the shader's blend** (24 directions for the sky colour, the haze under the horizon for the ground, a ring at 1.5° for the fog), so they follow the sky without a read-back. The hemisphere takes their hue; its strength is still a curve. Each fog sample is capped so the sun's side doesn't wash the haze out.
- **The moon** rises in the east-south-east (azimuth 124°) from 6° at sunset to 36°, at the doc's 0.15. The sun's curves are unchanged.

**Night**

- **Windows come on one by one:** each between +3° and −12° (the building shifted by up to ±3°, as the doc says), half the upper-floor windows never, and nearly every shopfront. The design's ramp is the share of windows lit rather than a dimmer.
- **Light groups:**
  - Floodlit, as emissive light on the placeholder blocks (from the water side where there is one, brightest at the foot, pooling between pilasters every 4 m so a block reads as lit stone): Parliament, Buda Castle, the Bastion, Matthias Church, the Liberty Statue, the Citadella, and also the Academy, Gresham, Vigadó, Gellért Hotel and Market Hall. M4's heroes will use the same patch with window masks.
  - The Chain Bridge's string lights along both chains (182 bulbs), its towers and chains floodlit gold.
  - Deck lamps every 22 m on the Liberty, Elisabeth, Margaret and Árpád Bridges (the last two are additions), and the Liberty and Elisabeth structures lit.
  - Embankment lamps every 30 m on both banks from Margaret Bridge to Liberty Bridge.
  - In all, 480 lamps and 182 bulbs are one draw call of sprites, never thinner than 3 px.
- **Streets glow at night:** the terrain's street and square classes and the quay promenades get a faint warm emissive, and wall feet a wash of street light.
- **The point-light pool:** three lights move between about 600 anchors (lamps, bulbs, deck lamps, and a light over the water in front of each floodlit landmark), picked 4 times a second by distance to the camera's focus, weighted toward the bigger groups. A light fades out before it moves. The boat's lamp is the fourth, on a mast ahead of the cabin; it lit the cabin roof white from 0.85 m.

**Water**

- **The river is MeshStandardMaterial with additions,** not a separate shader, so it keeps three's sun, moon, point lights, shadows and fog.
  - Three layers of the normal map at different scales and angles, two of them drifting downstream at 0.6 m/s along the river mesh's flow UVs.
  - The sky dome rendered to a 128² cube (re-rendered when the sun moves 0.1°) is its environment map; reflections are tinted teal, since the river has almost no colour of its own.
  - **At night the direct highlights are capped**, so the moon and the lamps make a glitter path instead of a white blob; a low sun's path may still burn.
- **Planar reflections** within 380–420 m of Parliament and the Chain Bridge, faded out by 600–650 m and above 120 m altitude, at half resolution: a mirror camera with an oblique near plane, leaving out the water, the trees and the labels. That pass is 23–65 draw calls and 0.5–0.7 M triangles.
- **Streaks are laid out by viewing angle,** from under half to twice the depression angle of the light's mirror image, brightest at the image and as wide as the light looks from the eye: a column of even width on screen, which is what a light on rippled water looks like. There are 621, one draw call. Inside the planar zones they dim, since the reflection shows the lights itself.

**Rendering**

- **Bloom and tone mapping** go through three's EffectComposer: a half-float scene target, UnrealBloomPass, and the OutputPass's ACES at the doc's exposure curve. MSAA is 4 samples, or 2 on high-density screens (a 4-sample half-float target at 2560 × 1440 is about 118 MB).
- **The bloom threshold is 0.9 at night (strength 0.6), as in the doc, but rises to 3.4 by day:** the threshold applies before the exposure, and at 0.9 every sunlit wall bloomed.
- **Every program is compiled before the first frame,** for the HDR target, with hidden objects shown for the compile (the boat in flight, the night sprites by day). The count stays at 29 through the whole run, so neither the first landing nor dusk compiles anything.
- **Layers:** the water (and its streaks), the trees and the labels have their own layers, so the reflection can leave them out.
- `QUALITY` in `config.ts` holds shadow size, reflections, bloom and MSAA until M4's `quality.json` tiers.
- Measured at 1280 × 720 (2560 × 1440 drawn) on an Apple M3: 15–19 ms per frame with the simulation, 85–194 draw calls and 1.2–2.5 M triangles over all passes (the main pass about 80 calls).

**Code and checks**

- **New modules:**
  - `sky` (the dome, its blend, the environment cube, the CPU twin);
  - `post` (bloom and tone mapping);
  - `textures` (loads `tex/`);
  - `world/surfaces` (facade, quay, terrain and floodlight shader patches);
  - `world/water`;
  - `world/nightLights` (groups, sprites, streaks, the pool);
  - `world/night` (the shared ramp and uniforms);
  - `world/shaderPatch` (onBeforeCompile helper).
- **`npm run simulate` has 28 checks:** M2's 23, plus the night ramp, golden hour over Parliament (17:55–18:09, sun 4.0° to 1.5°, city lights barely on), full night under the Chain Bridge (19:31, −12.2°), and the sky's blend weights.
- **The 30 s recording:** there is no screen recorder or ffmpeg here, so the dev server takes frames (`?record=timelapse` posts them to `/__capture`, dev only) and `npm run record` makes an animated WebP. `tools/out/timelapse.webp` is the whole run in 30 s, one frame every 1.9 s of tour (not committed: 5.8 MB). `?record=beat6` records 30 s from a beat in real time.

**Not done yet**

- KTX2 compression, and the full-size (1024² and 4096 × 2048) set.
- The image-API textures and a generated style sheet, which need an API key (and the doc's open question on the API's terms).
- Quality tiers (M4), and a reduced draw set for the reflection pass (the trees are already left out).
- Placeholders still look like what they are at night: lit blocks. The heroes (M4) bring window masks and real silhouettes.

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
