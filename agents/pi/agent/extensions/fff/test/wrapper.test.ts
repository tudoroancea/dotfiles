import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { FFF_RENDERERS } from "../../lib/tools/fff.ts";
import fffRenderers from "../src/index.ts";

/**
 * The vendor's factory only registers things; the native index is built later, from its own
 * `session_start` handler. So loading it against a stub is safe, and it is the only way to see
 * that the proxy really replaces the two render slots and forwards everything else.
 */
function load(mode?: string, multiGrep = false) {
  const tools: ToolDefinition<any, any, any>[] = [];
  const flags: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = {
    registerTool: (tool: ToolDefinition<any, any, any>) => {
      const index = tools.findIndex((registered) => registered.name === tool.name);
      if (index >= 0) tools[index] = tool;
      else tools.push(tool);
    },
    registerFlag: (name: string) => flags.push(name),
    registerCommand: (name: string) => commands.push(name),
    on: (event: string, handler: (event: unknown, ctx: unknown) => void) => {
      events.push(event);
      handlers.set(event, handler);
    },
    getFlag: () => undefined,
    getActiveTools: () => tools.map((tool) => tool.name),
    setActiveTools: (names: string[]) => {
      const active = tools.filter((tool) => names.includes(tool.name));
      tools.splice(0, tools.length, ...active);
    },
    appendEntry: () => {},
  } as unknown as ExtensionAPI;

  // Both are read at factory time, so they are set explicitly rather than inherited: a developer
  // with either exported in their shell would otherwise get a different tool set than CI.
  const previous = { mode: process.env.PI_FFF_MODE, multi: process.env.PI_FFF_MULTIGREP };
  const restore = (name: "PI_FFF_MODE" | "PI_FFF_MULTIGREP", value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("PI_FFF_MODE", mode);
  restore("PI_FFF_MULTIGREP", multiGrep ? "1" : undefined);
  try {
    fffRenderers(pi);
    // Version 0.11 resolves startup configuration after Pi has populated flags.
    // The before-agent hook prepares registrations without building a native index.
    handlers.get("before_agent_start")?.(
      {},
      {
        cwd: "/workspace/project",
        sessionManager: { getEntries: () => [] },
        ui: {
          notify: (message: string) => {
            throw new Error(message);
          },
        },
      },
    );
  } finally {
    restore("PI_FFF_MODE", previous.mode);
    restore("PI_FFF_MULTIGREP", previous.multi);
  }
  return { tools, flags, commands, events };
}

describe("fff wrapper", () => {
  it("replaces both render slots of every tool the vendor registers", () => {
    const { tools } = load();
    expect(tools.map((tool) => tool.name)).toEqual(["ffgrep", "fffind"]);
    for (const tool of tools) {
      const renderer = FFF_RENDERERS.get(tool.name)!;
      expect(tool.renderCall, tool.name).toBe(renderer.renderCall);
      expect(tool.renderResult, tool.name).toBe(renderer.renderResult);
      // The vendor's own execute and schema have to survive: its search is native.
      expect(typeof tool.execute, tool.name).toBe("function");
      expect(tool.parameters, tool.name).toBeDefined();
    }
  });

  it("covers the names `/fff-mode override` switches to", () => {
    const { tools } = load("override");
    expect(tools.map((tool) => tool.name)).toEqual(["grep", "find"]);
    for (const tool of tools)
      expect(tool.renderResult).toBe(FFF_RENDERERS.get(tool.name)!.renderResult);
  });

  it("covers the OR-pattern grep, which only exists behind an env flag", () => {
    expect(load(undefined, true).tools.map((tool) => tool.name)).toEqual([
      "ffgrep",
      "fffind",
      "fff-multi-grep",
    ]);
    expect(load("override", true).tools.map((tool) => tool.name)).toEqual([
      "grep",
      "find",
      "multi_grep",
    ]);
    for (const tool of load(undefined, true).tools)
      expect(tool.renderResult, tool.name).toBe(FFF_RENDERERS.get(tool.name)!.renderResult);
  });

  it("forwards everything that is not a tool registration", () => {
    const { flags, commands, events } = load();
    expect(flags).toEqual([
      "fff-mode",
      "fff-frecency-db",
      "fff-history-db",
      "fff-enable-root-scan",
      "fff-enable-home-scan",
      "fff-follow-symlinks",
      "fff-warn-home-scan",
    ]);
    expect(commands).toEqual(["fff-mode", "fff-health", "fff-rescan"]);
    // Every tool found a renderer, so the wrapper adds no warning handler.
    expect(events).toEqual(["session_start", "before_agent_start", "session_shutdown"]);
  });
});
