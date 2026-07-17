import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const testsRoot = dirname(fileURLToPath(import.meta.url));
const extensionsRoot = resolve(testsRoot, "..");
const dependencies = resolve(extensionsRoot, "agentflow/node_modules/@earendil-works");

export default {
  root: testsRoot,
  resolve: {
    alias: {
      "@earendil-works/pi-coding-agent": resolve(dependencies, "pi-coding-agent/dist/index.js"),
      "@earendil-works/pi-tui": resolve(dependencies, "pi-tui/dist/index.js"),
      "@mariozechner/pi-coding-agent": resolve(dependencies, "pi-coding-agent/dist/index.js"),
      "@mariozechner/pi-tui": resolve(dependencies, "pi-tui/dist/index.js"),
      typebox: resolve(extensionsRoot, "agentflow/node_modules/typebox"),
    },
  },
  test: {
    include: ["*.test.ts"],
  },
};
