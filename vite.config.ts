import { defineConfig } from "vite";

// Relative base so the build runs from any static host or subfolder.
export default defineConfig({
  base: "./",
  build: { target: "es2022", chunkSizeWarningLimit: 1200 },
});
