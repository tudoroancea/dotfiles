// End-to-end tests exercise the committed production assets. Verify freshness
// before the suite without rewriting dist/client and masking a stale artifact.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function globalSetup() {
  const checkBundle = fileURLToPath(new URL("./check-bundle.mjs", import.meta.url));
  execFileSync(process.execPath, [checkBundle], { stdio: "inherit" });
}
