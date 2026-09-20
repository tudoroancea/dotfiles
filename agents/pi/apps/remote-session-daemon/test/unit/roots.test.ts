import { mkdtemp, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveApprovedDirectory } from "../../src/config/roots.ts";

describe("approved root resolution", () => {
  it("returns only a canonical, contained, existing trusted directory", async () => {
    const base = await mkdtemp(join(tmpdir(), "roots-"));
    const root = join(base, "root");
    await mkdir(join(root, "project"), { recursive: true });
    const result = await resolveApprovedDirectory(
      [{ alias: "work", path: root }],
      "work",
      "project",
      { isTrusted: () => true },
    );
    expect(result.canonicalCwd).toMatch(/\/root\/project$/);
  });

  it("rejects a directory identity swapped during asynchronous trust", async () => {
    const base = await mkdtemp(join(tmpdir(), "roots-race-"));
    const root = join(base, "root");
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    await expect(
      resolveApprovedDirectory([{ alias: "work", path: root }], "work", "project", {
        async isTrusted() {
          await rename(project, join(root, "retired"));
          await mkdir(project);
          return true;
        },
      }),
    ).rejects.toThrow(/identity changed/);
  });

  it("rejects malformed paths, files, escapes, and absent prior trust", async () => {
    const base = await mkdtemp(join(tmpdir(), "roots-"));
    const root = join(base, "root");
    const outside = join(base, "root-other");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, "file"), "x");
    await symlink(outside, join(root, "escape"));
    const roots = [{ alias: "work", path: root }];
    const trusted = { isTrusted: () => true };
    for (const path of ["", "/tmp", "../root-other", "missing", "file", "escape", "bad\0path"])
      await expect(resolveApprovedDirectory(roots, "work", path, trusted)).rejects.toThrow();
    await expect(
      resolveApprovedDirectory(roots, "work", ".", { isTrusted: () => false }),
    ).rejects.toMatchObject({ code: "not_trusted" });
  });
});
