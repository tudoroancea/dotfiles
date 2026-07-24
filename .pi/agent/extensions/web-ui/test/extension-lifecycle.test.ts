import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createCopyRemoteUrlHandler,
  createWebUiExtension,
  type WebUiExtensionDependencies,
} from "../src/index.js";
import type { WebUiRuntime } from "../src/server/server.js";

function fakeRuntime(id: string): WebUiRuntime {
  return {
    diagnosticUrl: `http://127.0.0.1:4000/${id}`,
    canonicalUrl: `https://pi.example/${id}`,
    generation: id,
    createBootstrapUrl: () => `https://pi.example/${id}#bootstrap=secret-${id}`,
    broadcast: vi.fn(),
    close: vi.fn(async () => undefined),
  };
}

function context(mode: ExtensionContext["mode"]): ExtensionContext {
  return {
    mode,
    cwd: "/repo",
    ui: { notify: vi.fn() },
  } as unknown as ExtensionContext;
}

function harness(dependencies: WebUiExtensionDependencies) {
  const handlers = new Map<string, Array<(event: unknown, context: ExtensionContext) => unknown>>();
  const registerCommand = vi.fn();
  const registerEntryRenderer = vi.fn();
  const appendEntry = vi.fn();
  const pi = {
    on: (name: string, handler: (event: unknown, context: ExtensionContext) => unknown) => {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    registerCommand,
    registerEntryRenderer,
    appendEntry,
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  createWebUiExtension(dependencies)(pi);
  return { handlers, registerCommand, registerEntryRenderer, appendEntry };
}

async function emit(
  handlers: Map<string, Array<(event: unknown, context: ExtensionContext) => unknown>>,
  name: string,
  event: unknown,
  eventContext: ExtensionContext,
): Promise<void> {
  await Promise.all((handlers.get(name) ?? []).map((handler) => handler(event, eventContext)));
}

describe("extension lifecycle", () => {
  it("starts only for TUI/RPC, announces without LLM context, and closes on replacement", async () => {
    const tuiRuntime = fakeRuntime("tui");
    const rpcRuntime = fakeRuntime("rpc");
    const startServer = vi.fn().mockResolvedValueOnce(tuiRuntime).mockResolvedValueOnce(rpcRuntime);
    const writeStderr = vi.fn();
    const { handlers, registerCommand, registerEntryRenderer, appendEntry } = harness({
      copy: vi.fn(),
      startServer,
      writeStderr,
      assetRoot: "/assets",
    });

    expect(registerCommand).toHaveBeenCalledWith(
      "copy-remote-url",
      expect.objectContaining({ description: "Copy Remote URL" }),
    );

    await emit(handlers, "session_start", { reason: "startup" }, context("print"));
    await emit(handlers, "session_start", { reason: "startup" }, context("json"));
    expect(startServer).not.toHaveBeenCalled();

    await emit(handlers, "session_start", { reason: "startup" }, context("tui"));
    expect(startServer).toHaveBeenCalledOnce();
    expect(appendEntry).toHaveBeenCalledWith("web-ui-startup", {
      url: tuiRuntime.canonicalUrl,
      generation: tuiRuntime.generation,
    });
    const renderer = registerEntryRenderer.mock.calls[0]![1] as (
      entry: { data: { url: string; generation: string } },
      options: { expanded: boolean },
      theme: { fg: (_color: string, text: string) => string; bold: (text: string) => string },
    ) => unknown;
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    expect(
      renderer({ data: { url: "http://stale/", generation: "stale" } }, { expanded: false }, theme),
    ).toBeUndefined();
    expect(
      renderer(
        { data: { url: tuiRuntime.canonicalUrl, generation: tuiRuntime.generation } },
        { expanded: false },
        theme,
      ),
    ).toBeDefined();
    expect(writeStderr).not.toHaveBeenCalled();

    await emit(handlers, "session_shutdown", { reason: "reload" }, context("tui"));
    expect(tuiRuntime.close).toHaveBeenCalledOnce();

    await emit(handlers, "session_start", { reason: "reload" }, context("rpc"));
    expect(startServer).toHaveBeenCalledTimes(2);
    expect(writeStderr).toHaveBeenCalledWith(`Pi Web UI: ${rpcRuntime.diagnosticUrl}\n`);
    expect(appendEntry).toHaveBeenCalledTimes(1);

    await emit(handlers, "session_shutdown", { reason: "quit" }, context("rpc"));
    expect(rpcRuntime.close).toHaveBeenCalledOnce();
  });

  it("copies a directly usable bootstrap link and reports clipboard failure", async () => {
    const runtime = fakeRuntime("copy");
    const notify = vi.fn();
    const commandContext = { ui: { notify } } as unknown as ExtensionCommandContext;
    const copy = vi.fn(async () => undefined);
    await createCopyRemoteUrlHandler(() => runtime, copy)("", commandContext);
    expect(copy).toHaveBeenCalledWith("https://pi.example/copy#bootstrap=secret-copy");
    expect(notify).toHaveBeenCalledWith("Remote URL copied.", "info");

    copy.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await createCopyRemoteUrlHandler(() => runtime, copy)("", commandContext);
    expect(notify).toHaveBeenLastCalledWith(
      "Could not copy Remote URL: clipboard unavailable",
      "error",
    );

    await createCopyRemoteUrlHandler(() => undefined, copy)("", commandContext);
    expect(notify).toHaveBeenLastCalledWith("Pi Web UI is not running in this mode.", "error");
  });
});
