import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sourcePath = join(root, "agent", "instructions", "general.md");
const targetPath = join(root, "agent", "AGENTS.md");
const begin = "<!-- BEGIN GENERATED: instructions/general.md -->";
const end = "<!-- END GENERATED: instructions/general.md -->";

const [source, target] = await Promise.all([
  readFile(sourcePath, "utf8"),
  readFile(targetPath, "utf8"),
]);
const start = target.indexOf(begin);
const finish = target.indexOf(end);
if (start < 0 || finish < 0 || finish < start) {
  throw new Error(`Missing or invalid generated instruction markers in ${targetPath}`);
}
if (
  target.indexOf(begin, start + begin.length) >= 0 ||
  target.indexOf(end, finish + end.length) >= 0
) {
  throw new Error(`Duplicate generated instruction markers in ${targetPath}`);
}

const body = source.trimEnd();
const generated = `${target.slice(0, start + begin.length)}\n\n${body}\n\n${target.slice(finish)}`;

if (process.argv.includes("--check")) {
  if (generated !== target) {
    console.error("agent/AGENTS.md is out of sync with agent/instructions/general.md");
    console.error("Run: nub run sync:instructions");
    process.exitCode = 1;
  }
} else if (generated !== target) {
  await writeFile(targetPath, generated);
}
