// Prints the beat timetable computed from public/data/route.json (arc length and speeds).
// Usage: npm run timetable

import { readFileSync } from "node:fs";
import { LOOP } from "../src/config";
import { Route, type RouteJson } from "../src/route";

const json = JSON.parse(
  readFileSync(new URL("../public/data/route.json", import.meta.url), "utf8"),
) as RouteJson;
const route = new Route(json);

const mmss = (t: number) => {
  const r = Math.round(t);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
};
const hhmm = (h: number | undefined) =>
  h === undefined ? "" : `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;

console.log(`Route: ${json.points.length} points, ${(route.length / 1000).toFixed(2)} km flown\n`);
console.log("  #  Beat                                   Start   End    Length  Clock");
route.beats.forEach((b, i) => {
  const next = route.beats[i + 1];
  const endS = next ? next.s : route.length;
  const endT = next ? next.time : route.totalTime;
  console.log(
    `${String(b.id).padStart(3)}  ${b.name.padEnd(38)} ${mmss(b.time).padStart(5)}  ${mmss(endT).padStart(5)}  ${String(Math.round(endS - b.s)).padStart(5)} m  ${hhmm(route.clockAt(b.time))}`,
  );
});
console.log("\nCamera keys");
route.shots.forEach((sh) => {
  const beat = route.beatAt(sh.s);
  console.log(`  ${mmss(sh.time).padStart(5)}–${mmss(sh.endTime).padStart(5)}  ${(sh.mode + (sh.target ? ` → ${sh.target}` : "")).padEnd(24)} (beat ${beat?.id ?? "-"})`);
});
console.log(`\nTotal run: ${mmss(route.totalTime)}, then ${LOOP.circle} s circling the Market Hall and a ${LOOP.fadeOut} s fade before the loop`);
