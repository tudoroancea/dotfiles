import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownContextImports } from "../../markdown-context-imports.ts";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{
  cwd: string;
  contextPath: string;
  importedPath: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-context-imports-"));
  temporaryDirectories.push(cwd);
  const contextPath = join(cwd, "AGENTS.md");
  const importedPath = join(cwd, "general.md");
  await writeFile(contextPath, "Project context\n@./general.md\n");
  await writeFile(importedPath, "Shared agency instruction\n");
  return { cwd, contextPath, importedPath };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

function load() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const pi = {
    on: vi.fn((event: string, handler: (...args: any[]) => unknown) =>
      handlers.set(event, handler),
    ),
  };
  markdownContextImports(pi as never);
  return { handlers, pi };
}

describe("markdown context import extension", () => {
  it.each(["tui", "rpc", "print", "json"])(
    "appends only imported context in %s mode without UI or Herdr events",
    async (mode) => {
      const { cwd, contextPath } = await fixture();
      const { handlers, pi } = load();
      const beforeStart = handlers.get("before_agent_start")!;
      const result = (await beforeStart(
        {
          systemPrompt: "Base prompt\n\nProject context\n@./general.md",
          systemPromptOptions: {
            cwd,
            contextFiles: [
              {
                path: contextPath,
                content: "Project context\n@./general.md\n",
              },
            ],
          },
        },
        { mode },
      )) as { systemPrompt: string };

      expect(result.systemPrompt.match(/Shared agency instruction/g)).toHaveLength(1);
      expect(result.systemPrompt.match(/Project context/g)).toHaveLength(1);
      expect(result.systemPrompt).toContain("BEGIN MARKDOWN IMPORT");
      expect(pi.on).toHaveBeenCalledTimes(2);
      expect(Object.keys(pi)).toEqual(["on"]);
    },
  );

  it("invalidates an expansion when an imported dependency changes", async () => {
    const { cwd, contextPath, importedPath } = await fixture();
    const { handlers } = load();
    const beforeStart = handlers.get("before_agent_start")!;
    const event = {
      systemPrompt: "Base",
      systemPromptOptions: {
        cwd,
        contextFiles: [
          {
            path: contextPath,
            content: "Project context\n@./general.md\n",
          },
        ],
      },
    };

    expect(((await beforeStart(event)) as { systemPrompt: string }).systemPrompt).toContain(
      "Shared agency instruction",
    );
    await writeFile(importedPath, "Updated shared instruction with a new size\n");
    const future = new Date(Date.now() + 2_000);
    await utimes(importedPath, future, future);
    expect(((await beforeStart(event)) as { systemPrompt: string }).systemPrompt).toContain(
      "Updated shared instruction with a new size",
    );
  });

  it("clears caches on reload and surfaces import diagnostics", async () => {
    const { cwd, contextPath } = await fixture();
    const { handlers } = load();
    const beforeStart = handlers.get("before_agent_start")!;
    const sessionStart = handlers.get("session_start")!;
    await sessionStart({ reason: "reload" });
    await writeFile(contextPath, "@./missing.md\n");

    await expect(
      beforeStart({
        systemPrompt: "Base",
        systemPromptOptions: {
          cwd,
          contextFiles: [{ path: contextPath, content: "@./missing.md\n" }],
        },
      }),
    ).rejects.toThrow(/Cannot resolve Markdown import/);
  });

  it("does nothing when loaded context files contain no imports", async () => {
    const { cwd, contextPath } = await fixture();
    const { handlers } = load();
    const result = await handlers.get("before_agent_start")!({
      systemPrompt: "Base",
      systemPromptOptions: {
        cwd,
        contextFiles: [{ path: contextPath, content: "Plain context\n" }],
      },
    });

    expect(result).toBeUndefined();
  });
});
