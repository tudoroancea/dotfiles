import { createServer } from "node:net";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startConfiguredDaemon } from "../../src/cli.ts";

const temporaryRoots: string[] = [];
const repositoryRoot = (() => {
  const cwd = resolve(process.cwd());
  const index = cwd.indexOf("/.workrtees/");
  return index < 0 ? resolve(cwd, "../..") : cwd.slice(0, index);
})();
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

describe("executable daemon composition", () => {
  it("starts and stops a credential-free real SDK host from validated config", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-composition-"));
    temporaryRoots.push(root);
    const project = join(root, "project");
    const sessions = join(root, "sessions");
    await mkdir(project);
    const configPath = join(root, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        listener: { host: "127.0.0.1", port: await unusedPort() },
        approvedRoots: [{ alias: "work", path: root }],
        trustedProjects: [project],
        roleMappings: [],
        persistencePath: sessions,
        tailscaleVersions: { minimum: "1.70.0", maximumExclusive: "2.0.0" },
      }),
    );
    const daemon = await startConfiguredDaemon(configPath, { repositoryRoot });
    try {
      const launch = await daemon.launches.create({ rootAlias: "work", relativePath: "project" });
      expect(launch).toMatchObject({ lifecycle: "ready", ready: true });
      expect(await readdir(sessions)).toContain(launch.launchId);
      await daemon.registry.unload(launch.launchId);
      const reopened = await daemon.registry.reopen(launch.launchId);
      expect(reopened).toMatchObject({
        launchId: launch.launchId,
        lifecycle: "ready",
        ready: true,
      });
      expect(reopened.generation).not.toBe(launch.generation);
      await daemon.registry.stop(launch.launchId);
      expect(daemon.registry.detail(launch.launchId).lifecycle).toBe("stopped");
    } finally {
      await daemon.stop();
    }
  }, 30_000);
});
