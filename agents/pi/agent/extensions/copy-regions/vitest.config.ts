import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const resolvePackage = createRequire(import.meta.url).resolve;

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "preact",
  },
  plugins: [
    {
      name: "copy-regions-transcript-virtualizer",
      enforce: "pre",
      resolveId(id) {
        return id === "@tanstack/react-virtual" ? "\0copy-regions-virtualizer" : undefined;
      },
      load(id) {
        if (id !== "\0copy-regions-virtualizer") return undefined;
        return `export const useWindowVirtualizer = ({ count }) => ({
          getTotalSize: () => count * 96,
          getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
            index, key: index, start: index * 96
          })),
          measureElement() {},
          scrollToIndex() {},
          scrollToOffset() {}
        });`;
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^preact$/, replacement: resolvePackage("preact") },
      { find: /^preact\/hooks$/, replacement: resolvePackage("preact/hooks") },
      { find: /^preact\/compat$/, replacement: resolvePackage("preact/compat") },
      { find: /^preact\/test-utils$/, replacement: resolvePackage("preact/test-utils") },
      { find: /^preact\/jsx-runtime$/, replacement: resolvePackage("preact/jsx-runtime") },
      { find: /^react$/, replacement: resolvePackage("preact/compat") },
      { find: /^react-dom$/, replacement: resolvePackage("preact/compat") },
      { find: /^react-dom\/test-utils$/, replacement: resolvePackage("preact/test-utils") },
      { find: /^react\/jsx-runtime$/, replacement: resolvePackage("preact/jsx-runtime") },
    ],
    preserveSymlinks: true,
  },
});
