// three's Basis Universal transcoder, for the KTX2 textures: KTX2Loader loads it by path from
// one folder, so the dev server serves it at basis/ and the build copies it there, from
// node_modules (it isn't committed).

import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

const DIR = new URL("../node_modules/three/examples/jsm/libs/basis/", import.meta.url);
const FILES = ["basis_transcoder.js", "basis_transcoder.wasm"];

export function basisPlugin(): Plugin {
  return {
    name: "flyover-basis",
    configureServer(server) {
      server.middlewares.use("/basis/", (req, res, next) => {
        const file = (req.url ?? "").split("?")[0].replace(/^\//, "");
        if (!FILES.includes(file)) return next();
        res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        res.end(readFileSync(new URL(file, DIR)));
      });
    },
    generateBundle() {
      for (const file of FILES) this.emitFile({ type: "asset", fileName: `basis/${file}`, source: readFileSync(new URL(file, DIR)) });
    },
  };
}
