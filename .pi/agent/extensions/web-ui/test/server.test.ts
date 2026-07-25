import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { readWebUiConfig } from "../src/server/config.js";
import { ProviderRegistry } from "../src/server/providers.js";
import { startWebUiServer, type WebUiRuntime } from "../src/server/server.js";
import { LIMITS } from "../src/shared/limits.js";
import { PROTOCOL_VERSION } from "../src/shared/wire.js";

const temporaryDirectories: string[] = [];
const runtimes: WebUiRuntime[] = [];

const controller = () => ({
  sendUserMessage: vi.fn(),
  getActiveTools: () => [],
  getCommands: () => [],
});
const configuration = (port = 0) => ({ ...readWebUiConfig({}), port });

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function assets(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-ui-test-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "index.html"), "<!doctype html><title>test</title>");
  return directory;
}

function context() {
  let idle = true;
  let branch: unknown[] = [];
  const abort = vi.fn();
  const value = {
    mode: "tui",
    cwd: "/repo",
    model: undefined,
    thinkingLevel: "medium",
    sessionManager: {
      getSessionId: () => "session-test",
      getBranch: () => branch,
      getLeafId: () => (branch.at(-1) as { id?: string } | undefined)?.id ?? null,
    },
    isIdle: () => idle,
    getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
    abort,
  } as unknown as ExtensionContext;
  return {
    value,
    abort,
    setIdle: (next: boolean) => (idle = next),
    setBranch: (next: unknown[]) => (branch = next),
  };
}

function openWebSocket(url: string, cookie: string, origin: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const websocket = new WebSocket(url, { headers: { Cookie: cookie }, origin });
    websocket.once("open", () => resolve(websocket));
    websocket.once("error", reject);
  });
}

function nextMessage(websocket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const listener = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (message.type !== type) return;
      websocket.off("message", listener);
      resolve(message);
    };
    websocket.on("message", listener);
  });
}

interface ReceivedMessage {
  value: Record<string, unknown>;
  serialized: string;
}

function messageInbox(websocket: WebSocket) {
  const queued: ReceivedMessage[] = [];
  const waiters: Array<{
    predicate: (message: Record<string, unknown>) => boolean;
    resolve: (message: ReceivedMessage) => void;
  }> = [];
  websocket.on("message", (data) => {
    const serialized = data.toString();
    const received = {
      value: JSON.parse(serialized) as Record<string, unknown>,
      serialized,
    };
    const waiterIndex = waiters.findIndex(({ predicate }) => predicate(received.value));
    if (waiterIndex < 0) queued.push(received);
    else waiters.splice(waiterIndex, 1)[0]!.resolve(received);
  });
  return {
    queued,
    next(predicate: (message: Record<string, unknown>) => boolean): Promise<ReceivedMessage> {
      const index = queued.findIndex(({ value }) => predicate(value));
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]!);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
}

function persistedEntry(index: number, text = `entry ${index}`) {
  return {
    type: "message",
    id: `server-entry-${index}`,
    parentId: index === 0 ? null : `server-entry-${index - 1}`,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: index },
  };
}

async function authenticatedSocket(runtime: WebUiRuntime): Promise<WebSocket> {
  const link = new URL(runtime.createBootstrapUrl());
  const credential = new URLSearchParams(link.hash.slice(1)).get("bootstrap")!;
  const origin = new URL(runtime.diagnosticUrl).origin;
  const exchange = await fetch(new URL("api/bootstrap", runtime.diagnosticUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}`, Origin: origin },
  });
  const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
  const websocketUrl = new URL("ws", runtime.diagnosticUrl);
  websocketUrl.protocol = "ws:";
  return openWebSocket(websocketUrl.href, cookie, origin);
}

describe("web UI server", () => {
  it("serves hardened assets and a non-secret health endpoint", async () => {
    const session = context();
    const runtime = await startWebUiServer({
      pi: controller(),
      context: session.value,
      config: configuration(),
      assetRoot: await assets(),
      generation: "generation-1",
    });
    runtimes.push(runtime);

    const health = await fetch(new URL("health", runtime.diagnosticUrl));
    expect(await health.json()).toEqual({
      status: "ok",
      protocolVersion: PROTOCOL_VERSION,
      generation: "generation-1",
      isIdle: true,
    });
    expect(
      JSON.stringify(await (await fetch(new URL("health", runtime.diagnosticUrl))).json()),
    ).not.toContain("bootstrap");

    const page = await fetch(runtime.diagnosticUrl);
    expect(await page.text()).toContain("<title>test</title>");
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("connect-src 'self' ws: wss:");
    expect(page.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps legacy frame headers consistent with a configured framing policy", async () => {
    const config = configuration();
    const runtime = await startWebUiServer({
      pi: controller(),
      context: context().value,
      config: { ...config, framing: { frameAncestors: ["'self'"] } },
      assetRoot: await assets(),
      generation: "framing-generation",
    });
    runtimes.push(runtime);
    const page = await fetch(runtime.diagnosticUrl);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(page.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("exchanges a single-use fragment credential and accepts authenticated commands", async () => {
    const session = context();
    const sendUserMessage = vi.fn();
    const runtime = await startWebUiServer({
      pi: { sendUserMessage, getActiveTools: () => [], getCommands: () => [] },
      context: session.value,
      config: configuration(),
      assetRoot: await assets(),
      generation: "generation-2",
    });
    runtimes.push(runtime);

    const link = new URL(runtime.createBootstrapUrl());
    const credential = new URLSearchParams(link.hash.slice(1)).get("bootstrap")!;
    expect(link.search).toBe("");
    const exchange = await fetch(new URL("api/bootstrap", runtime.diagnosticUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        Origin: new URL(runtime.diagnosticUrl).origin,
      },
    });
    expect(exchange.status).toBe(204);
    const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;

    const replay = await fetch(new URL("api/bootstrap", runtime.diagnosticUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        Origin: new URL(runtime.diagnosticUrl).origin,
      },
    });
    expect(replay.status).toBe(401);

    const websocketUrl = new URL("ws", runtime.diagnosticUrl);
    websocketUrl.protocol = "ws:";
    const websocket = await openWebSocket(
      websocketUrl.href,
      cookie,
      new URL(runtime.diagnosticUrl).origin,
    );

    const pong = nextMessage(websocket, "pong");
    websocket.send(JSON.stringify({ type: "ping", commandId: "ping-1" }));
    expect(await pong).toMatchObject({ commandId: "ping-1" });

    const staleResponse = nextMessage(websocket, "command_response");
    websocket.send(
      JSON.stringify({
        type: "prompt",
        commandId: "stale-prompt",
        generation: "old-generation",
        content: "do not run",
      }),
    );
    expect(await staleResponse).toMatchObject({
      commandId: "stale-prompt",
      accepted: false,
      error: expect.stringContaining("Stale session generation"),
    });
    expect(sendUserMessage).not.toHaveBeenCalled();

    const promptResponse = nextMessage(websocket, "command_response");
    websocket.send(
      JSON.stringify({
        type: "prompt",
        commandId: "prompt-1",
        generation: "generation-2",
        content: "hello",
      }),
    );
    expect(await promptResponse).toMatchObject({ commandId: "prompt-1", accepted: true });
    expect(sendUserMessage).toHaveBeenCalledWith("hello");

    const reservedPrompt = nextMessage(websocket, "command_response");
    websocket.send(
      JSON.stringify({
        type: "prompt",
        commandId: "prompt-reserved",
        generation: "generation-2",
        content: "second controller prompt",
      }),
    );
    expect(await reservedPrompt).toMatchObject({
      commandId: "prompt-reserved",
      accepted: false,
      error: expect.stringContaining("Pi is busy"),
    });
    expect(sendUserMessage).toHaveBeenCalledTimes(1);

    session.setIdle(false);
    const steerResponse = nextMessage(websocket, "command_response");
    websocket.send(
      JSON.stringify({
        type: "steer",
        commandId: "steer-1",
        generation: "generation-2",
        content: "focus",
      }),
    );
    expect(await steerResponse).toMatchObject({ commandId: "steer-1", accepted: true });
    expect(sendUserMessage).toHaveBeenCalledWith("focus", { deliverAs: "steer" });

    const followUpResponse = nextMessage(websocket, "command_response");
    websocket.send(
      JSON.stringify({
        type: "follow_up",
        commandId: "follow-1",
        generation: "generation-2",
        content: "then summarize",
      }),
    );
    expect(await followUpResponse).toMatchObject({ commandId: "follow-1", accepted: true });
    expect(sendUserMessage).toHaveBeenCalledWith("then summarize", { deliverAs: "followUp" });

    const busyPromptResponse = nextMessage(websocket, "command_response");
    websocket.send(
      JSON.stringify({
        type: "prompt",
        commandId: "prompt-2",
        generation: "generation-2",
        content: "guess",
      }),
    );
    expect(await busyPromptResponse).toMatchObject({
      commandId: "prompt-2",
      accepted: false,
      error: expect.stringContaining("choose steer or follow-up"),
    });

    const snapshotMessage = nextMessage(websocket, "snapshot");
    websocket.send(JSON.stringify({ type: "snapshot", commandId: "snapshot-1" }));
    expect(await snapshotMessage).toMatchObject({
      commandId: "snapshot-1",
      generation: "generation-2",
      state: { persisted: { sessionId: "session-test" } },
    });

    const abortResponse = nextMessage(websocket, "command_response");
    websocket.send(
      JSON.stringify({ type: "abort", commandId: "abort-1", generation: "generation-2" }),
    );
    expect(await abortResponse).toMatchObject({ commandId: "abort-1", accepted: true });
    expect(session.abort).toHaveBeenCalledOnce();

    const coalescedUpdate = nextMessage(websocket, "state_update");
    runtime.broadcast("tool_execution_start", {
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "printf test" },
    });
    runtime.broadcast("tool_execution_update", {
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "printf test" },
      partialResult: { content: [{ type: "text", text: "first" }] },
    });
    runtime.broadcast("tool_execution_update", {
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "printf test" },
      partialResult: { content: [{ type: "text", text: "first\nsecond" }] },
    });
    expect(await coalescedUpdate).toMatchObject({
      baseRevision: 1,
      revision: 4,
      patch: {
        live: {
          tools: [
            {
              toolCallId: "tool-1",
              result: { content: [{ text: "first\nsecond" }] },
            },
          ],
        },
      },
    });

    const settlement = nextMessage(websocket, "snapshot");
    session.setIdle(true);
    runtime.broadcast("agent_settled", {});
    expect(await settlement).toMatchObject({ generation: "generation-2", revision: 5 });

    const closed = new Promise<void>((resolve) => websocket.once("close", () => resolve()));
    websocket.send("x".repeat(65 * 1024));
    await closed;
    const health = await fetch(new URL("health", runtime.diagnosticUrl));
    expect(health.status).toBe(200);
  });

  it("serves the complete authenticated application beneath a non-root public path", async () => {
    const config = readWebUiConfig({
      PI_WEB_UI_PUBLIC_URL: "https://machine.ts.net/_pi/s/launch-id/",
    });
    const runtime = await startWebUiServer({
      pi: controller(),
      context: context().value,
      config,
      assetRoot: fileURLToPath(new URL("../dist/web/", import.meta.url)),
      generation: "base-path-generation",
    });
    runtimes.push(runtime);
    expect(runtime.canonicalUrl).toBe("https://machine.ts.net/_pi/s/launch-id/");
    expect(new URL(runtime.diagnosticUrl).pathname).toBe("/_pi/s/launch-id/");

    const page = await fetch(runtime.diagnosticUrl);
    const html = await page.text();
    const asset = html.match(/(?:src|href)="(\.\/assets\/[^"]+)"/)?.[1];
    expect(asset).toBeDefined();
    expect((await fetch(new URL(asset!, runtime.diagnosticUrl))).status).toBe(200);
    expect((await fetch(new URL("/", runtime.diagnosticUrl))).status).toBe(404);

    const link = new URL(runtime.createBootstrapUrl());
    const credential = new URLSearchParams(link.hash.slice(1)).get("bootstrap")!;
    const exchange = await fetch(new URL("api/bootstrap", runtime.diagnosticUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        Origin: "https://machine.ts.net",
        "X-Forwarded-User": "spoofed",
        "Tailscale-User-Login": "spoofed@example.com",
      },
    });
    expect(exchange.status).toBe(204);
    expect(exchange.headers.get("set-cookie")).toContain("Path=/_pi/s/launch-id/; Secure");
    const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;

    const spoofed = await fetch(new URL("api/snapshot", runtime.diagnosticUrl), {
      headers: {
        "X-Forwarded-User": "spoofed",
        "Tailscale-User-Login": "spoofed@example.com",
      },
    });
    expect(spoofed.status).toBe(401);

    const websocketUrl = new URL("ws", runtime.diagnosticUrl);
    websocketUrl.protocol = "ws:";
    const websocket = await openWebSocket(websocketUrl.href, cookie, "https://machine.ts.net");
    const pong = nextMessage(websocket, "pong");
    websocket.send(JSON.stringify({ type: "ping", commandId: "base-path-ping" }));
    expect(await pong).toMatchObject({ commandId: "base-path-ping" });
  });

  it("keeps concurrent loopback sessions authenticated with distinct cookies", async () => {
    const first = await startWebUiServer({
      pi: controller(),
      context: context().value,
      config: configuration(),
      assetRoot: await assets(),
      generation: "concurrent-1",
    });
    const second = await startWebUiServer({
      pi: controller(),
      context: context().value,
      config: configuration(),
      assetRoot: await assets(),
      generation: "concurrent-2",
    });
    runtimes.push(first, second);

    const cookies: string[] = [];
    for (const runtime of [first, second]) {
      const link = new URL(runtime.createBootstrapUrl());
      const credential = new URLSearchParams(link.hash.slice(1)).get("bootstrap")!;
      const response = await fetch(new URL("api/bootstrap", runtime.diagnosticUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential}`,
          Origin: new URL(runtime.diagnosticUrl).origin,
        },
      });
      cookies.push(response.headers.get("set-cookie")!.split(";", 1)[0]!);
    }
    expect(cookies[0]!.split("=", 1)[0]).not.toBe(cookies[1]!.split("=", 1)[0]);
    for (const runtime of [first, second]) {
      const response = await fetch(new URL("api/snapshot", runtime.diagnosticUrl), {
        headers: { Cookie: cookies.join("; ") },
      });
      expect(response.status).toBe(200);
    }
  });

  it("globally reconciles persisted state when another client reconnects", async () => {
    const session = context();
    const runtime = await startWebUiServer({
      pi: controller(),
      context: session.value,
      config: configuration(),
      assetRoot: await assets(),
      generation: "reconcile-generation",
    });
    runtimes.push(runtime);
    const link = new URL(runtime.createBootstrapUrl());
    const credential = new URLSearchParams(link.hash.slice(1)).get("bootstrap")!;
    const exchange = await fetch(new URL("api/bootstrap", runtime.diagnosticUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        Origin: new URL(runtime.diagnosticUrl).origin,
      },
    });
    const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
    const websocketUrl = new URL("ws", runtime.diagnosticUrl);
    websocketUrl.protocol = "ws:";
    const first = await openWebSocket(
      websocketUrl.href,
      cookie,
      new URL(runtime.diagnosticUrl).origin,
    );

    session.setBranch([
      {
        type: "message",
        id: "persisted-user",
        parentId: null,
        timestamp: "2026-07-24T12:00:00.000Z",
        message: { role: "user", content: "reconnected", timestamp: 1 },
      },
    ]);
    const reconciliation = nextMessage(first, "state_update");
    const second = await openWebSocket(
      websocketUrl.href,
      cookie,
      new URL(runtime.diagnosticUrl).origin,
    );
    expect(await reconciliation).toMatchObject({
      baseRevision: 0,
      revision: 1,
      patch: { persisted: { entries: [{ id: "persisted-user" }] } },
    });
    second.close();
  });

  it("pages large history privately without revisions, gaps, duplicates, or lineage leaks", async () => {
    const source = Array.from({ length: 251 }, (_, index) =>
      persistedEntry(index, `entry ${index} ${'🙂\\"'.repeat(200)}`),
    );
    const session = context();
    session.setBranch(source);
    const runtime = await startWebUiServer({
      pi: controller(),
      context: session.value,
      config: configuration(),
      assetRoot: await assets(),
      generation: "history-server-generation",
    });
    runtimes.push(runtime);

    const requesterSocket = await authenticatedSocket(runtime);
    const requester = messageInbox(requesterSocket);
    const peerSocket = await authenticatedSocket(runtime);
    const peer = messageInbox(peerSocket);
    const initial = (await requester.next((message) => message.type === "snapshot")).value as {
      revision: number;
      state: {
        persisted: {
          historyGeneration: string;
          entries: Array<{ id: string }>;
          hasOlder: boolean;
          olderCursor: string;
        };
      };
    };
    await peer.next((message) => message.type === "snapshot");
    expect(initial.state.persisted.entries).toHaveLength(LIMITS.historyPageEntries);
    expect(initial.state.persisted.hasOlder).toBe(true);

    const firstRequest = {
      type: "history_page",
      commandId: "history-page-1",
      generation: "history-server-generation",
      historyGeneration: initial.state.persisted.historyGeneration,
      cursor: initial.state.persisted.olderCursor,
    };
    requesterSocket.send(JSON.stringify(firstRequest));
    const firstPage = await requester.next(
      (message) => message.type === "history_page" && message.commandId === "history-page-1",
    );
    expect(Buffer.byteLength(firstPage.serialized)).toBeLessThanOrEqual(LIMITS.historyPageBytes);
    expect(firstPage.value.revision).toBe(initial.revision);
    expect(requester.queued).not.toContainEqual(
      expect.objectContaining({ value: expect.objectContaining({ commandId: "history-page-1" }) }),
    );

    requesterSocket.send(JSON.stringify(firstRequest));
    const retry = await requester.next(
      (message) => message.type === "history_page" && message.commandId === "history-page-1",
    );
    expect(retry.serialized).toBe(firstPage.serialized);

    const chunks = [initial.state.persisted.entries];
    let page = firstPage.value as {
      entries: Array<{ id: string }>;
      hasOlder: boolean;
      olderCursor?: string;
    };
    chunks.unshift(page.entries);
    let requestIndex = 2;
    while (page.hasOlder) {
      const commandId = `history-page-${requestIndex++}`;
      requesterSocket.send(
        JSON.stringify({
          ...firstRequest,
          commandId,
          cursor: page.olderCursor,
        }),
      );
      const received = await requester.next(
        (message) => message.type === "history_page" && message.commandId === commandId,
      );
      expect(Buffer.byteLength(received.serialized)).toBeLessThanOrEqual(LIMITS.historyPageBytes);
      expect(received.value.revision).toBe(initial.revision);
      page = received.value as typeof page;
      chunks.unshift(page.entries);
    }
    const retrievedIds = chunks.flat().map(({ id }) => id);
    expect(retrievedIds).toEqual(source.map((item) => item.id));
    expect(new Set(retrievedIds).size).toBe(source.length);

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      peer.queued.some(({ value }) =>
        typeof value.commandId === "string" ? value.commandId.startsWith("history-page-") : false,
      ),
    ).toBe(false);

    session.setBranch([...source, persistedEntry(251)]);
    const appendUpdate = requester.next((message) => message.type === "state_update");
    runtime.reconcile();
    const appendPersisted = (await appendUpdate).value as {
      revision: number;
      patch: { persisted: { historyGeneration: string } };
    };
    expect(appendPersisted.patch.persisted.historyGeneration).toBe(
      initial.state.persisted.historyGeneration,
    );
    requesterSocket.send(JSON.stringify({ ...firstRequest, commandId: "history-after-append" }));
    const afterAppend = await requester.next(
      (message) => message.type === "history_page" && message.commandId === "history-after-append",
    );
    expect(afterAppend.value).toMatchObject({
      revision: appendPersisted.revision,
      historyGeneration: initial.state.persisted.historyGeneration,
      entries: firstPage.value.entries,
      olderCursor: firstPage.value.olderCursor,
    });

    const cursor = initial.state.persisted.olderCursor;
    const tamperedCursor = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    requesterSocket.send(
      JSON.stringify({
        ...firstRequest,
        commandId: "history-tampered",
        cursor: tamperedCursor,
      }),
    );
    const tampered = await requester.next(
      (message) => message.type === "command_response" && message.commandId === "history-tampered",
    );
    expect(tampered.value).toMatchObject({
      accepted: false,
      command: "history_page",
      error: expect.stringContaining("fresh snapshot"),
    });
    expect(tampered.value).not.toHaveProperty("historyGeneration");
    expect(tampered.serialized).not.toContain(cursor);
    expect(Buffer.byteLength(tampered.serialized)).toBeLessThanOrEqual(LIMITS.historyPageBytes);

    session.setBranch(source.slice(0, 180));
    const resetUpdate = requester.next((message) => message.type === "state_update");
    runtime.reconcile();
    const resetGeneration = (
      (await resetUpdate).value as { patch: { persisted: { historyGeneration: string } } }
    ).patch.persisted.historyGeneration;
    expect(resetGeneration).not.toBe(initial.state.persisted.historyGeneration);

    const forcedSnapshot = requester.next((message) => message.type === "snapshot");
    runtime.broadcast("session_tree", {});
    const forced = (await forcedSnapshot).value as {
      revision: number;
      state: { persisted: { historyGeneration: string } };
    };
    expect(forced.state.persisted.historyGeneration).not.toBe(resetGeneration);

    requesterSocket.send(JSON.stringify({ ...firstRequest, commandId: "history-stale" }));
    const stale = await requester.next(
      (message) => message.type === "command_response" && message.commandId === "history-stale",
    );
    expect(stale.value).toMatchObject({
      accepted: false,
      command: "history_page",
      error: expect.stringContaining("fresh snapshot"),
    });
    expect(stale.value).not.toHaveProperty("historyGeneration");
    expect(stale.value).not.toHaveProperty("cursor");
    expect(stale.serialized).not.toContain(initial.state.persisted.historyGeneration);
    expect(Buffer.byteLength(stale.serialized)).toBeLessThanOrEqual(LIMITS.historyPageBytes);

    requesterSocket.send(
      JSON.stringify({
        ...firstRequest,
        commandId: "history-wrong-session-generation",
        generation: "stale-session-generation",
      }),
    );
    expect(
      (
        await requester.next(
          (message) =>
            message.type === "command_response" &&
            message.commandId === "history-wrong-session-generation",
        )
      ).value,
    ).toMatchObject({ accepted: false, error: expect.stringContaining("fresh snapshot") });
  });

  it("releases a fixed port for a fresh replacement runtime", async () => {
    const first = await startWebUiServer({
      pi: controller(),
      context: context().value,
      config: configuration(),
      assetRoot: await assets(),
      generation: "replacement-1",
    });
    const port = Number(new URL(first.diagnosticUrl).port);
    await first.close();

    const replacement = await startWebUiServer({
      pi: controller(),
      context: context().value,
      config: configuration(port),
      assetRoot: await assets(),
      generation: "replacement-2",
    });
    runtimes.push(replacement);
    expect((await fetch(new URL("health", replacement.diagnosticUrl))).status).toBe(200);
  });

  it("cleans provider subscriptions after partial startup failure", async () => {
    const blocker = createNetServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("missing blocker address");
    const unsubscribe = vi.fn();
    const providers = new ProviderRegistry();
    providers.register({
      id: "agentflow",
      getSnapshot: () => [],
      subscribe: () => unsubscribe,
      action: async () => [],
    });
    await expect(
      startWebUiServer({
        pi: controller(),
        context: context().value,
        config: configuration(address.port),
        assetRoot: await assets(),
        generation: "failed-start",
        providerRegistry: providers,
      }),
    ).rejects.toThrow();
    expect(unsubscribe).toHaveBeenCalledOnce();
    await new Promise<void>((resolve, reject) =>
      blocker.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("rejects invalid origins and closes idempotently", async () => {
    const session = context();
    const runtime = await startWebUiServer({
      pi: controller(),
      context: session.value,
      config: configuration(),
      assetRoot: await assets(),
      generation: "generation-3",
    });
    runtimes.push(runtime);

    const link = new URL(runtime.createBootstrapUrl());
    const credential = new URLSearchParams(link.hash.slice(1)).get("bootstrap")!;
    const rejected = await fetch(new URL("api/bootstrap", runtime.diagnosticUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, Origin: "https://evil.example" },
    });
    expect(rejected.status).toBe(403);

    const exchange = await fetch(new URL("api/bootstrap", runtime.diagnosticUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        Origin: new URL(runtime.diagnosticUrl).origin,
      },
    });
    const cookie = exchange.headers.get("set-cookie")!.split(";", 1)[0]!;
    const websocketUrl = new URL("ws", runtime.diagnosticUrl);
    websocketUrl.protocol = "ws:";
    const invalidOriginStatus = await new Promise<number>((resolve, reject) => {
      const websocket = new WebSocket(websocketUrl, {
        headers: { Cookie: cookie },
        origin: "https://evil.example",
      });
      websocket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      websocket.once("error", reject);
    });
    expect(invalidOriginStatus).toBe(403);

    await Promise.all([runtime.close(), runtime.close()]);
    runtimes.splice(runtimes.indexOf(runtime), 1);
    await expect(fetch(new URL("health", runtime.diagnosticUrl))).rejects.toThrow();
  });
});
