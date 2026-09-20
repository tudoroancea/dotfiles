import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Produces one self-contained production bundle under `dist/client/`:
// - `base: "./"` keeps every asset reference relative so the server can mount the
//   app under an arbitrary random base path;
// - fixed (unhashed) output names keep the build deterministic so the committed
//   artifacts can be verified for freshness with a byte comparison;
// - no external/CDN imports remain: Preact, Marked, and DOMPurify are bundled.
export default defineConfig({
  root: fileURLToPath(new URL("./src/web", import.meta.url)),
  base: "./",
  build: {
    outDir: fileURLToPath(new URL("./dist/client", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
