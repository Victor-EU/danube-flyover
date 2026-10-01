# Danube Flyover

A browser-based 3D flight along the Budapest riverfront: a bird from the Japanese Garden on Margaret Island to the Central Market Hall, landing on the Danube to continue as a boat. See [the design doc](<Danube Flyover — Design Doc.md>) and [the decisions log](docs/decisions.md).

This is **M0, the grey box**:

- the real route, flown by an autopilot;
- the bird and the boat, with the 2 s landing and 2.5 s take-off;
- manual control that hands back to the autopilot;
- the flight corridor, altitude floor and river clamps;
- a time-of-day slider driving the sun, the sky and the ambient light.

The city is flat-coloured boxes, and there are no assets.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/, deployable to any static host
npm run timetable  # beat start times computed from public/data/route.json
npm run simulate   # headless autopilot run: beats, mode switches, tracking error
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
- **T** hides the time slider. **`** (backquote) shows the debug panel.

In the browser console, `flyover.jump(n)` moves to the start of beat n, and `flyover.step(seconds)` advances the simulation, which also works in a hidden tab.

## Layout

- `public/data/route.json`: the hand-edited autopilot route (lat/lon points, speeds, modes, beats, sunset-run clock).
- `src/`: one module per job. `route`, `autopilot`, `input`, `controller` (blend and mode state machine), `vehicle`, `camera`, `lighting`, `hud`, and `world/` for the placeholder river, terrain, bridges, city and floor grid.
- `tools/`: offline scripts. M1 adds the OSM, terrain and texture pipeline here.

Placeholder geography is traced from OpenStreetMap, © OpenStreetMap contributors, ODbL.
