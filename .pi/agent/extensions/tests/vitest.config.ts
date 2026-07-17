import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const extensionsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependencies = resolve(extensionsRoot, "agentflow/node_modules/@earendil-works");

export default {
  resolve: {
    alias: {
      "@earendil-works/pi-coding-agent": resolve(dependencies, "pi-coding-agent/dist/index.js"),
      "@earendil-works/pi-tui": resolve(dependencies, "pi-tui/dist/index.js"),
    },
  },
  test: {
    include: ["boxed-editor.test.ts"],
  },
};
