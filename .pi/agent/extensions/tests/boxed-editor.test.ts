import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import boxedEditorExtension, { composeActivityFooter } from "../boxed-editor.ts";

const plainText = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

const statuses = new Map([
  ["warnings", "◇ warnings 2 · /reviews"],
  ["background-processes", "■ /background-tasks 1"],
  ["agentflow", "◆ /agentflow 2 · 3/5 tasks"],
]);

describe("boxed editor activity footer", () => {
  it.each([
    [40, "  ◆ /agentflow 2 · 3/5 tasks  ■ /backgr…"],
    [80, "  ◆ /agentflow 2 · 3/5 tasks  ■ /background-tasks 1  ◇ warnings 2 · /reviews"],
    [120, "  ◆ /agentflow 2 · 3/5 tasks  ■ /background-tasks 1  ◇ warnings 2 · /reviews"],
  ])("composes one predictably bounded line at %i columns", (width, expected) => {
    const lines = composeActivityFooter(statuses, width);

    expect(lines.map(plainText)).toEqual([expected]);
    expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(width);
  });

  it("sanitizes statuses and omits the line when there is no activity", () => {
    expect(
      composeActivityFooter(new Map([["agentflow", "  ◆ /agentflow\n2\tactive  "]]), 40),
    ).toEqual(["  ◆ /agentflow 2 active"]);
    expect(composeActivityFooter(new Map(), 80)).toEqual([]);
  });

  it("guards Boxed Editor as the only enabled footer owner", () => {
    const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const extensionRoot = resolve(agentRoot, "extensions");
    const sources = readdirSync(extensionRoot, { recursive: true, withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".ts") &&
          !entry.name.includes(".test.") &&
          !entry.parentPath.includes("node_modules"),
      )
      .map((entry) => resolve(entry.parentPath, entry.name))
      .filter((path) => /\.setFooter\s*\(/u.test(readFileSync(path, "utf8")));
    const settings = JSON.parse(readFileSync(resolve(agentRoot, "settings.json"), "utf8")) as {
      extensions?: string[];
    };
    const disabled = new Set(
      (settings.extensions ?? [])
        .filter((entry) => entry.startsWith("-"))
        .map((entry) => entry.slice(1)),
    );
    const owners = sources.map((path) => relative(agentRoot, path)).sort();
    const enabledOwners = owners.filter((path) => !disabled.has(path));

    expect(owners).toEqual(["extensions/boxed-editor.ts", "extensions/worktrunk-statusline.ts"]);
    expect(enabledOwners).toEqual(["extensions/boxed-editor.ts"]);
  });

  it("installs the status compositor and clears it on shutdown", () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const footerUpdates: unknown[] = [];
    const pi = {
      on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler),
      getThinkingLevel: () => "high",
    };
    boxedEditorExtension(pi as never);
    const context = {
      mode: "tui",
      cwd: "/parent/project",
      model: { provider: "parent-provider", id: "parent-model", contextWindow: 200_000 },
      getContextUsage: () => ({ percent: 42, contextWindow: 200_000 }),
      sessionManager: { getBranch: () => [] },
      ui: {
        theme: {},
        setEditorComponent: vi.fn(),
        setFooter: (footer: unknown) => footerUpdates.push(footer),
      },
    };

    handlers.get("session_start")!({}, context);
    const footerFactory = footerUpdates[0] as (
      tui: { requestRender(): void },
      theme: { fg(_role: string, text: string): string },
      footerData: { getExtensionStatuses(): ReadonlyMap<string, string> },
    ) => { render(width: number): string[] };
    const footer = footerFactory(
      { requestRender() {} },
      { fg: (_role, text) => text },
      { getExtensionStatuses: () => statuses },
    );
    const output = footer.render(120);

    expect(output).toEqual([composeActivityFooter(statuses, 120)[0]]);
    expect(output[0]).not.toMatch(/parent-model|parent-provider|42%|200\.0k|\/parent\/project|\$/);

    handlers.get("session_shutdown")!({}, context);
    expect(footerUpdates).toHaveLength(2);
    expect(footerUpdates[1]).toBeUndefined();
  });
});
