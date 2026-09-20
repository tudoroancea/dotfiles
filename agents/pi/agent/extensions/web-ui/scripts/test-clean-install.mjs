import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = fileURLToPath(new URL("..", import.meta.url));
const rootDir = fileURLToPath(new URL("../../../..", import.meta.url));
const tempRoot = mkdtempSync(join(tmpdir(), "pi-web-ui-clean-install-"));
function copy(relativePath) {
  const source = join(rootDir, relativePath);
  if (!existsSync(source)) return;
  const destination = join(tempRoot, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    filter: (path) =>
      !path.includes(`${join("", "node_modules")}`) &&
      !path.includes(`${join("", "playwright-report")}`) &&
      !path.includes(`${join("", "test-results")}`),
  });
}

try {
  copy("package.json");
  copy("nub.lock");
  copy(".npmrc");
  copy(relative(rootDir, extensionDir));
  copy("agent/extensions/lib/session-cost.ts");
  copy("packages/pi-web-ui-client");

  // The frozen lockfile records every workspace importer. Copy the other manifests
  // without their implementation so Nub can reconstruct the same workspace graph.
  const manifestPaths = execFileSync("git", ["ls-files"], {
    cwd: rootDir,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter((path) => path.endsWith("/package.json"));
  for (const manifestPath of manifestPaths) {
    if (
      manifestPath === "package.json" ||
      manifestPath.startsWith("agent/extensions/web-ui/") ||
      manifestPath.startsWith("packages/pi-web-ui-client/")
    )
      continue;
    copy(manifestPath);
  }

  execFileSync("nub", ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"], {
    cwd: tempRoot,
    stdio: "inherit",
  });
  execFileSync("nub", ["run", "--filter", "@dotfiles/pi-web-ui-client", "typecheck"], {
    cwd: tempRoot,
    stdio: "inherit",
  });
  execFileSync("nub", ["run", "--filter", "@dotfiles/pi-web-ui-client", "test"], {
    cwd: tempRoot,
    stdio: "inherit",
  });
  execFileSync("nub", ["run", "--filter", "pi-web-ui", "build:check"], {
    cwd: tempRoot,
    stdio: "inherit",
  });
  console.log("Clean offline workspace install and deployment checks passed.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
