import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { readWebUiConfig } from "../src/server/config.js";
import { startWebUiServer, type WebUiRuntime } from "../src/server/server.js";

const temporaryDirectories: string[] = [];
const runtimes: WebUiRuntime[] = [];

const controller = () => ({ sendUserMessage: vi.fn(), getActiveTools: () => [] });
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
      getLeafId: () => null,
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
      protocolVersion: 2,
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
      pi: { sendUserMessage, getActiveTools: () => [] },
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
