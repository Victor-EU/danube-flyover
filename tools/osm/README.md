# OpenStreetMap extracts

These GeoJSON files are extracts of OpenStreetMap, fetched with `npm run fetch-osm` (Overpass API) for the world rectangle plus a small margin. Each file records the OSM data timestamp (`osm_base`) and the bounding box, and keeps only the tags the pipeline uses.

**Licence:** © OpenStreetMap contributors. These extracts, and the files derived from them in `public/data/` (`river.json`, `water.glb`, `terrain.bin`, `bridges.json`, `city.glb`, `heroes/*.glb`, `trees.json`, `floor.bin`, `life.json`, `roofbits.bin`, `ground/`, and the positions in `landmarks.json`), are made available under the [Open Database Licence (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Any public use must credit "© OpenStreetMap contributors"; see https://www.openstreetmap.org/copyright.

| File | Contents |
| --- | --- |
| `buildings.geojson` | `building=*` ways and multipolygons, with height, levels and roof tags |
| `water.geojson` | water areas (the Danube relations and ponds) and the Danube `waterway=river` line |
| `bridges.geojson` | `man_made=bridge` outlines, bridge road and rail ways, `bridge:support` piers and pylons |
| `landcover.geojson` | parks, gardens, grass, woods, scrub, pitches, squares and pedestrian areas |
| `trees.geojson` | `natural=tree` points and `natural=tree_row` lines |
| `districts.geojson` | Budapest district boundaries (`admin_level=9`) |
| `trams.geojson` | tram tracks, traced into the embankment tram lines (`build-life`) |
| `roads.geojson` | `highway=*` ways (streets, footways, steps, squares), `area:highway` outlines, parking, railways and piers: the ground's streets, pavements and markings |

The far field's extracts, `far/*.geojson.gz`, come from `npm run fetch-osm -- far` over a 26 km box (`FAR.box` in `src/config.ts`, 47.40–47.63 N, 18.88–19.22 E), fetched in tiles and gzipped, with coordinates to 6 decimals (about 10 cm). They and what `build-far` makes from them (`public/data/far/`) are ODbL too.

| File | Contents |
| --- | --- |
| `far/buildings.geojson.gz` | `building=*` ways and multipolygons, with height, levels and roof tags |
| `far/roads.geojson.gz` | streets (service and up), rails, trams and metro |
| `far/landcover.geojson.gz` | land use, parks, woods, scrub, grass, wetland and rock |
| `far/water.geojson.gz` | water areas and the Danube's lines |
| `far/towers.geojson.gz` | towers, masts, chimneys and water towers |
| `far/bridges.geojson.gz` | bridge outlines and bridge road and rail ways |
