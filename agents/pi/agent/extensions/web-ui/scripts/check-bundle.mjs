// Artifact freshness gate.
//
// The production browser bundle under `dist/client/` is committed so deployment
// never depends on an undocumented manual build. This script rebuilds into a
// temporary directory and byte-compares it against the committed artifacts; a
// mismatch means the committed bundle is stale and `nub run build` must be re-run.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = fileURLToPath(new URL("..", import.meta.url));
const committedDir = join(extensionDir, "dist", "client");
const viteBin = join(extensionDir, "node_modules", "vite", "bin", "vite.js");
const tempOut = mkdtempSync(join(tmpdir(), "pi-web-ui-bundle-"));

function listFiles(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(relative(root, full), readFileSync(full));
    }
  };
  try {
    walk(root);
  } catch {
    // Missing directory yields an empty map, reported as a difference below.
  }
  return files;
}

try {
  execFileSync(
    process.execPath,
    [viteBin, "build", "--logLevel", "error", "--outDir", tempOut, "--emptyOutDir"],
    { cwd: extensionDir, stdio: "inherit" },
  );

  const fresh = listFiles(tempOut);
  const committed = listFiles(committedDir);
  const problems = [];

  for (const [name, content] of fresh) {
    if (!committed.has(name)) problems.push(`missing committed asset: ${name}`);
    else if (!committed.get(name).equals(content)) problems.push(`stale committed asset: ${name}`);
  }
  for (const name of committed.keys()) {
    if (!fresh.has(name)) problems.push(`unexpected committed asset: ${name}`);
  }

  const forbiddenRuntimeReferences = [
    ["esm.sh", "CDN import"],
    ["node_modules", "node_modules path"],
    [extensionDir, "absolute repository path"],
    ["../packages/", "repository-relative package import"],
  ];
  for (const [name, content] of fresh) {
    if (!/\.(?:html|css|js)$/.test(name)) continue;
    const text = content.toString("utf8");
    for (const [needle, label] of forbiddenRuntimeReferences) {
      if (text.includes(needle)) problems.push(`${name}: contains ${label}`);
    }
  }

  if (problems.length > 0) {
    console.error("Committed browser bundle is out of date:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("Run `nub run build` and commit dist/client/.");
    process.exitCode = 1;
  } else {
    console.log("Committed browser bundle is up to date.");
  }
} finally {
  rmSync(tempOut, { recursive: true, force: true });
}
