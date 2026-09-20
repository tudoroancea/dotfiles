import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const committedDir = join(appDir, "dist", "client");
const viteBin = join(appDir, "node_modules", "vite", "bin", "vite.js");
const tempOut = mkdtempSync(join(tmpdir(), "pi-managed-ui-bundle-"));

function listFiles(root) {
  const files = new Map();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(relative(root, full), readFileSync(full));
    }
  };
  try {
    walk(root);
  } catch {
    // A missing artifact directory is reported by the comparison below.
  }
  return files;
}

try {
  execFileSync(
    process.execPath,
    [
      viteBin,
      "build",
      "--config",
      "vite.web.config.mjs",
      "--logLevel",
      "error",
      "--outDir",
      tempOut,
      "--emptyOutDir",
    ],
    { cwd: appDir, stdio: "inherit" },
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

  const forbidden = [
    ["esm.sh", "CDN import"],
    ["node_modules", "node_modules path"],
    [appDir, "absolute repository path"],
    ["agent/extensions/web-ui", "extension runtime path"],
    ["../packages/", "repository-relative package import"],
  ];
  for (const [name, content] of fresh) {
    if (!/\.(?:html|css|js)$/.test(name)) continue;
    const text = content.toString("utf8");
    for (const [needle, label] of forbidden) {
      if (text.includes(needle)) problems.push(`${name}: contains ${label}`);
    }
  }

  if (problems.length > 0) {
    console.error("Committed managed browser bundle is out of date:");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("Run `nub run build` in apps/remote-session-daemon and commit dist/client/.");
    process.exitCode = 1;
  } else {
    console.log("Committed managed browser bundle is up to date.");
  }
} finally {
  rmSync(tempOut, { recursive: true, force: true });
}
