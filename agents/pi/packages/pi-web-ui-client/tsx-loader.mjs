// Node test loader: transpile the TSX rendering modules to Preact's automatic
// JSX runtime on load. `node --test` strips plain TypeScript natively but cannot
// parse JSX, so the client components (`.tsx`) are transformed here with esbuild
// using the same jsx settings as the production Vite build. Plain `.ts` modules
// keep using Node's built-in type stripping.

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".tsx")) {
      const path = fileURLToPath(url);
      const { code } = transformSync(readFileSync(path, "utf8"), {
        loader: "tsx",
        jsx: "automatic",
        jsxImportSource: "preact",
        format: "esm",
        target: "es2022",
        sourcefile: path,
      });
      return { format: "module", source: code, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
