import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileMarkdownImports,
  MarkdownImportError,
  MarkdownImportResolver,
} from "../../../lib/markdown-imports.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-markdown-imports-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("MarkdownImportResolver", () => {
  it("expands nested relative and absolute imports with source markers", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "nested"));
    await writeFile(
      join(root, "root.md"),
      `Root\n@./nested/one.md\n@${join(root, "absolute.md")}\n`,
    );
    await writeFile(join(root, "nested/one.md"), "One\n@../two.md\n");
    await writeFile(join(root, "two.md"), "Two\n");
    await writeFile(join(root, "absolute.md"), "Absolute\n");

    const result = await compileMarkdownImports({
      rootPath: join(root, "root.md"),
      allowedRoots: [root],
    });

    expect(result.text).toContain("Root");
    expect(result.text).toContain("One");
    expect(result.text).toContain("Two");
    expect(result.text).toContain("Absolute");
    expect(result.text.match(/BEGIN MARKDOWN IMPORT/g)).toHaveLength(3);
    expect(result.text.match(/END MARKDOWN IMPORT/g)).toHaveLength(3);
    expect(result.sources).toHaveLength(3);
  });

  it("ignores import-like text in inline and fenced code and deduplicates canonical files", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "shared.md"), "Shared instruction\n");
    await symlink(join(root, "shared.md"), join(root, "alias.md"));
    await writeFile(
      join(root, "root.md"),
      [
        "`@./inline.md`",
        "```md",
        "```not-a-closing-fence",
        "@./fenced.md",
        "```",
        "@./shared.md",
        "@./alias.md",
        "",
      ].join("\n"),
    );

    const result = await compileMarkdownImports({
      rootPath: join(root, "root.md"),
      allowedRoots: [root],
    });

    expect(result.text).toContain("`@./inline.md`");
    expect(result.text).toContain("@./fenced.md");
    expect(result.text.match(/Shared instruction/g)).toHaveLength(1);
    expect(result.sources).toHaveLength(1);
  });

  it("returns only imported content when the root is already rendered by Pi", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "root.md"), "Ordinary root context\n@./shared.md\n");
    await writeFile(join(root, "shared.md"), "Imported only\n");

    const result = await compileMarkdownImports({
      rootPath: join(root, "root.md"),
      includeRoot: false,
      allowedRoots: [root],
    });

    expect(result.text).not.toContain("Ordinary root context");
    expect(result.text).toContain("Imported only");
  });

  it("detects cycles using canonical paths", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "root.md"), "@./a.md\n");
    await writeFile(join(root, "a.md"), "@./root.md\n");

    await expect(
      compileMarkdownImports({ rootPath: join(root, "root.md"), allowedRoots: [root] }),
    ).rejects.toThrow(/cycle detected/);
  });

  it("enforces depth, individual byte, and aggregate byte limits", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "root.md"), "@./one.md\n");
    await writeFile(join(root, "one.md"), "@./two.md\n");
    await writeFile(join(root, "two.md"), "payload\n");

    await expect(
      compileMarkdownImports({
        rootPath: join(root, "root.md"),
        allowedRoots: [root],
        maxDepth: 1,
      }),
    ).rejects.toThrow(/depth exceeds 1/);
    await expect(
      compileMarkdownImports({
        rootPath: join(root, "root.md"),
        allowedRoots: [root],
        maxImportedFileBytes: 5,
      }),
    ).rejects.toThrow(/byte file limit/);
    await expect(
      compileMarkdownImports({
        rootPath: join(root, "root.md"),
        allowedRoots: [root],
        maxTotalImportedBytes: 15,
      }),
    ).rejects.toThrow(/byte total limit/);
  });

  it("reports missing imports and rejects lexical and symlink escapes", async () => {
    const parent = await temporaryDirectory();
    const root = join(parent, "project");
    await mkdir(root);
    await writeFile(join(parent, "outside.md"), "outside\n");
    await writeFile(join(root, "missing-root.md"), "@./missing.md\n");
    await writeFile(join(root, "escape-root.md"), "@../outside.md\n");
    await symlink(join(parent, "outside.md"), join(root, "outside-link.md"));
    await writeFile(join(root, "symlink-root.md"), "@./outside-link.md\n");

    await expect(
      compileMarkdownImports({ rootPath: join(root, "missing-root.md"), allowedRoots: [root] }),
    ).rejects.toThrow(/Cannot resolve Markdown import/);
    await expect(
      compileMarkdownImports({ rootPath: join(root, "escape-root.md"), allowedRoots: [root] }),
    ).rejects.toThrow(/escapes the allowed roots/);
    await expect(
      compileMarkdownImports({ rootPath: join(root, "symlink-root.md"), allowedRoots: [root] }),
    ).rejects.toThrow(/resolves outside the allowed roots/);

    const trusted = await compileMarkdownImports({
      rootPath: join(root, "escape-root.md"),
      allowedRoots: [root],
      allowOutsideRoots: true,
    });
    expect(trusted.text).toContain("outside");
  });

  it("refreshes cached file contents when metadata changes", async () => {
    const root = await temporaryDirectory();
    const imported = join(root, "shared.md");
    await writeFile(join(root, "root.md"), "@./shared.md\n");
    await writeFile(imported, "first\n");
    const resolver = new MarkdownImportResolver();

    expect(
      (await resolver.compile({ rootPath: join(root, "root.md"), allowedRoots: [root] })).text,
    ).toContain("first");
    await writeFile(imported, "second and longer\n");
    const future = new Date(Date.now() + 2_000);
    await utimes(imported, future, future);
    expect(
      (await resolver.compile({ rootPath: join(root, "root.md"), allowedRoots: [root] })).text,
    ).toContain("second and longer");
  });

  it("uses a typed diagnostic error", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "root.md"), "@./missing.md\n");

    await expect(
      compileMarkdownImports({ rootPath: join(root, "root.md"), allowedRoots: [root] }),
    ).rejects.toBeInstanceOf(MarkdownImportError);
  });
});
