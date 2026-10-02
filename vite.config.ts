import { defineConfig } from "vite";
import { basisPlugin } from "./tools/basisPlugin.ts";
import { capturePlugin } from "./tools/capturePlugin.ts";

// Relative base so the build runs from any static host or subfolder.
export default defineConfig({
  base: "./",
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
  plugins: [capturePlugin(), basisPlugin()],
});
