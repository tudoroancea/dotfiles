import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [preact()],
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
  },
});
