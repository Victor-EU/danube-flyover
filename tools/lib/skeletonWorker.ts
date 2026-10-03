// A worker for tools/lib/roofs.ts: builds straight skeletons for batches of outlines.

import { parentPort } from "node:worker_threads";
import type { Polygon } from "./geom";
import { initSkeleton, skeletonFaces } from "./roofs";

await initSkeleton();
parentPort!.on("message", (outlines: Polygon[]) => parentPort!.postMessage(outlines.map((o) => skeletonFaces(o))));
parentPort!.postMessage("ready");
