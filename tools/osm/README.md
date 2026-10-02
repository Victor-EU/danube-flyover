# OpenStreetMap extracts

These GeoJSON files are extracts of OpenStreetMap, fetched with `npm run fetch-osm` (Overpass API) for the world rectangle plus a small margin. Each file records the OSM data timestamp (`osm_base`) and the bounding box, and keeps only the tags the pipeline uses.

**Licence:** © OpenStreetMap contributors. These extracts, and the files derived from them in `public/data/` (`river.json`, `water.glb`, `terrain.bin`, `bridges.json`, `city.glb`, `heroes/*.glb`, `trees.json`, `floor.bin`, `life.json`, and the positions in `landmarks.json`), are made available under the [Open Database Licence (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Any public use must credit "© OpenStreetMap contributors"; see https://www.openstreetmap.org/copyright.

| File | Contents |
| --- | --- |
| `buildings.geojson` | `building=*` ways and multipolygons, with height, levels and roof tags |
| `water.geojson` | water areas (the Danube relations and ponds) and the Danube `waterway=river` line |
| `bridges.geojson` | `man_made=bridge` outlines, bridge road and rail ways, `bridge:support` piers and pylons |
| `landcover.geojson` | parks, gardens, grass, woods, scrub, pitches, squares and pedestrian areas |
| `trees.geojson` | `natural=tree` points and `natural=tree_row` lines |
| `districts.geojson` | Budapest district boundaries (`admin_level=9`) |
| `trams.geojson` | tram tracks, traced into the embankment tram lines (`build-life`) |
