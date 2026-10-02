// Dev server only: POST /__capture?name=<file> saves the request body (a frame the page
// grabbed from its canvas) to tools/out/captures/. Used to check renders and to put together
// the autopilot recording (tools/record.ts) without a screen recorder.

import { mkdirSync, writeFileSync } from "node:fs";
import type { Plugin } from "vite";

const OUT = new URL("./out/captures/", import.meta.url);

export function capturePlugin(): Plugin {
  return {
    name: "flyover-capture",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__capture", (req, res) => {
        const name = new URL(req.url ?? "", "http://x").searchParams.get("name") ?? "";
        if (req.method !== "POST" || !/^[\w.-]+\.(jpg|png|webp)$/.test(name)) {
          res.statusCode = 400;
          res.end("POST /__capture?name=<file>.jpg");
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          mkdirSync(OUT, { recursive: true });
          writeFileSync(new URL(name, OUT), Buffer.concat(chunks));
          res.end("ok");
        });
      });
    },
  };
}
