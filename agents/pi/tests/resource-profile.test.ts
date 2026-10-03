import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const sourceAgentDir = fileURLToPath(new URL("../agent/", import.meta.url));
const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("retained Pi resource profile", () => {
  it.each(["source", "directory-symlink"])(
    "loads the %s profile without loading tests as extensions",
    async (profile) => {
      let agentDir = sourceAgentDir;
      if (profile === "directory-symlink") {
        agentDir = await mkdtemp(resolve(tmpdir(), "pi-linked-resources-"));
        temporaryDirectories.push(agentDir);
        await symlink(
          resolve(sourceAgentDir, "extensions"),
          resolve(agentDir, "extensions"),
          "dir",
        );
        await symlink(
          resolve(sourceAgentDir, "settings.json"),
          resolve(agentDir, "settings.json"),
          "file",
        );
      }
      const settings = JSON.parse(await readFile(resolve(agentDir, "settings.json"), "utf8"));
      const loader = new DefaultResourceLoader({
        cwd: tmpdir(),
        agentDir,
        settingsManager: SettingsManager.inMemory({ ...settings, packages: [] }),
        noContextFiles: true,
      });
      await loader.reload({ resolveProjectTrust: async () => false });
      const { extensions, errors } = loader.getExtensions();
      expect(errors).toEqual([]);
      const paths = extensions.map((extension) => extension.path);
      expect(paths.some((path) => path.includes("/test/") || path.endsWith(".test.ts"))).toBe(
        false,
      );
      for (const retained of [
        "automatic-session-name.ts",
        "background-processes/src/index.ts",
        "copy-regions/index.ts",
        "fff/src/index.ts",
        "notify.ts",
        "working-word.ts",
      ]) {
        expect(
          paths.some((path) => path.endsWith(`/extensions/${retained}`)),
          retained,
        ).toBe(true);
      }
      for (const disabled of [
        "boxed-editor/index.ts",
        "builtin-tool-renderers.ts",
        "custom-header.ts",
      ]) {
        expect(
          paths.some((path) => path.endsWith(`/extensions/${disabled}`)),
          disabled,
        ).toBe(false);
      }
      expect(
        paths.some((path) => /agentflow|web-ui|worktrunk-statusline|herdr-agent-state/.test(path)),
      ).toBe(false);
      expect(settings.theme).toBe("rosepine-dawn/rosepine-moon");
      expect(
        settings.packages.map((source: string | { source: string }) =>
          typeof source === "string" ? source : source.source,
        ),
      ).toEqual([
        "npm:pi-web-access@0.35.0",
        "git:github.com/championswimmer/pi-context-usage@v2.1.0",
      ]);
    },
  );
});
