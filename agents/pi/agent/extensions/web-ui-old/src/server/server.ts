import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { WebSocket, WebSocketServer } from "ws";
import { LIMITS } from "../shared/limits.js";
import {
  PROTOCOL_VERSION,
  type ClientCommand,
  type CommandResponseMessage,
  type CompletionResultMessage,
  type PongMessage,
  type ProviderMessage,
  type ReadyMessage,
  type ServerMessage,
  type StateUpdateMessage,
} from "../shared/wire.js";
import { bearerCredential, StandaloneAuthentication, type StandalonePrincipal } from "./auth.js";
import { ClientQueue } from "./client-queue.js";
import { mentionCompletions, slashCompletions } from "./completion.js";
import type { WebUiConfig } from "./config.js";
import { parseClientCommand } from "./protocol.js";
import { ProviderRegistry } from "./providers.js";
import { mergeStateUpdates, SessionStateStore } from "./state.js";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export interface WebUiRuntime {
  readonly diagnosticUrl: string;
  readonly canonicalUrl: string;
  readonly generation: string;
  createBootstrapUrl(): string;
  broadcast(type: string, payload: unknown): void;
  reconcile(settled?: boolean): void;
  close(): Promise<void>;
}

export interface StartWebUiServerOptions {
  pi: Pick<ExtensionAPI, "sendUserMessage" | "getActiveTools" | "getCommands">;
  context: ExtensionContext;
  config: WebUiConfig;
  assetRoot: string;
  generation: string;
  autocompleteProvider?: AutocompleteProvider;
  providerRegistry?: ProviderRegistry;
}

function contentSecurityPolicy(config: WebUiConfig): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${config.framing.frameAncestors.join(" ")}`,
  ].join("; ");
}

function securityHeaders(response: ServerResponse, config: WebUiConfig): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", contentSecurityPolicy(config));
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  const frameAncestors = config.framing.frameAncestors;
  if (frameAncestors.length === 1 && frameAncestors[0] === "'none'") {
    response.setHeader("X-Frame-Options", "DENY");
  } else if (frameAncestors.length === 1 && frameAncestors[0] === "'self'") {
    response.setHeader("X-Frame-Options", "SAMEORIGIN");
  }
}

function json(response: ServerResponse, config: WebUiConfig, status: number, value: unknown): void {
  securityHeaders(response, config);
  response.statusCode = status;
  response.setHeader("Content-Type", CONTENT_TYPES[".json"]!);
  response.end(value === undefined ? undefined : JSON.stringify(value));
}

function originAllowed(request: IncomingMessage, origins: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  return origin !== undefined && origins.has(origin);
}

export function listenerOrigin(host: string, port: number): URL {
  const usableHost = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const displayHost = usableHost.includes(":") ? `[${usableHost}]` : usableHost;
  return new URL(`http://${displayHost}:${port}/`);
}

function routeWithinBase(pathname: string, basePath: string): string | undefined {
  if (!pathname.startsWith(basePath)) return undefined;
  return pathname.slice(basePath.length);
}

function serialize(message: ServerMessage): string {
  return JSON.stringify(message);
}

export async function startWebUiServer(options: StartWebUiServerOptions): Promise<WebUiRuntime> {
  const { pi, context, config, assetRoot, generation, autocompleteProvider } = options;
  const providers = options.providerRegistry ?? new ProviderRegistry();
  const store = new SessionStateStore(context, generation, pi.getActiveTools());
  const clients = new Map<WebSocket, ClientQueue>();
  const pendingHistory = new WeakSet<ClientQueue>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let coalesceTimer: NodeJS.Timeout | undefined;
  let pendingUpdate: StateUpdateMessage | undefined;
  let promptAdmission = false;
  let diagnosticUrl = new URL(config.basePath, "http://127.0.0.1/");
  let canonicalUrl = new URL(diagnosticUrl);
  let allowedOrigins = new Set<string>();
  let authentication: StandaloneAuthentication;

  const snapshotSerialized = (commandId?: string) => serialize(store.snapshot(commandId));
  const providerUnsubscribe = providers.subscribe((snapshot) => {
    const message: ProviderMessage = {
      type: "provider_update",
      protocolVersion: PROTOCOL_VERSION,
      generation,
      ...snapshot,
    };
    const serialized = serialize(message);
    for (const channel of clients.values()) channel.enqueueProvider(snapshot.provider, serialized);
  });

  function flushUpdate(): void {
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
    const update = pendingUpdate;
    pendingUpdate = undefined;
    if (!update || closed) return;
    const serialized = serialize(update);
    for (const channel of clients.values()) channel.enqueueState(serialized);
  }

  function scheduleUpdate(update: StateUpdateMessage | undefined): void {
    if (!update || closed) return;
    pendingUpdate = pendingUpdate ? mergeStateUpdates(pendingUpdate, update) : update;
    if (coalesceTimer) return;
    coalesceTimer = setTimeout(flushUpdate, LIMITS.stateCoalesceMs);
    coalesceTimer.unref?.();
  }

  function snapshotBarrier(): void {
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
    pendingUpdate = undefined;
    const serialized = snapshotSerialized();
    for (const channel of clients.values()) channel.enqueueSnapshot(serialized);
  }

  function reconcile(settled = false): StateUpdateMessage | undefined {
    return store.reconcile(context, { settled, activeTools: pi.getActiveTools() });
  }

  const server = createServer({ maxHeaderSize: LIMITS.httpHeaderBytes }, (request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) json(response, config, 500, { error: "Internal server error" });
      else response.destroy();
    });
  });
  const websocketPrincipals = new WeakMap<WebSocket, StandalonePrincipal>();
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.incomingWebSocketBytes,
    perMessageDeflate: false,
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? config.basePath, diagnosticUrl);
    const route = routeWithinBase(url.pathname, config.basePath);
    if (route === undefined) {
      json(response, config, 404, { error: "Not found" });
      return;
    }
    if (request.method === "GET" && route === "health") {
      json(response, config, 200, {
        status: "ok",
        protocolVersion: PROTOCOL_VERSION,
        generation,
        isIdle: context.isIdle(),
      });
      return;
    }
    if (request.method === "POST" && route === "api/bootstrap") {
      if (!originAllowed(request, allowedOrigins)) {
        json(response, config, 403, { error: "Origin rejected" });
        return;
      }
      const credential = bearerCredential(request);
      if (!credential || !authentication.exchangeBootstrap(credential)) {
        json(response, config, 401, { error: "Invalid or expired bootstrap credential" });
        return;
      }
      authentication.setSessionCookie(response);
      json(response, config, 204, undefined);
      return;
    }
    if (request.method === "GET" && route === "api/snapshot") {
      const auth = authentication.authenticateHttp(request);
      if (!auth.ok) {
        json(response, config, auth.status, { error: auth.message });
        return;
      }
      const update = reconcile();
      if (update) scheduleUpdate(update);
      flushUpdate();
      json(response, config, 200, store.snapshot());
      return;
    }
    if (request.method !== "GET") {
      json(response, config, 405, { error: "Method not allowed" });
      return;
    }

    let relativePath: string;
    try {
      relativePath = route === "" ? "index.html" : decodeURIComponent(route);
    } catch {
      json(response, config, 404, { error: "Not found" });
      return;
    }
    const root = resolve(assetRoot);
    const filePath = resolve(root, relativePath);
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      json(response, config, 404, { error: "Not found" });
      return;
    }
    try {
      const content = await readFile(filePath);
      securityHeaders(response, config);
      response.statusCode = 200;
      response.setHeader(
        "Content-Type",
        CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      );
      response.end(content);
    } catch {
      json(response, config, 404, { error: "Not found" });
    }
  }

  function rejectUpgrade(
    socket: import("node:stream").Duplex,
    status: number,
    message: string,
  ): void {
    socket.end(
      `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
    );
  }

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? config.basePath, diagnosticUrl);
    if (routeWithinBase(url.pathname, config.basePath) !== "ws") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!originAllowed(request, allowedOrigins)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const auth = authentication.authenticateWebSocket(request);
    if (!auth.ok) {
      rejectUpgrade(socket, auth.status, auth.message);
      return;
    }
    if (clients.size >= LIMITS.connectedClients) {
      rejectUpgrade(socket, 503, "Client limit reached");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketPrincipals.set(websocket, auth.principal);
      websocketServer.emit("connection", websocket, request);
    });
  });

  function sendControl(channel: ClientQueue, message: ServerMessage): void {
    channel.enqueueControl(serialize(message));
  }

  function accepted(channel: ClientQueue, command: ClientCommand): void {
    const message: CommandResponseMessage = {
      type: "command_response",
      protocolVersion: PROTOCOL_VERSION,
      generation,
      commandId: command.commandId,
      command: command.type,
      accepted: true,
    };
    sendControl(channel, message);
  }

  function rejected(
    channel: ClientQueue,
    commandId: string | undefined,
    command: string | undefined,
    error: string,
  ): void {
    const message: CommandResponseMessage = {
      type: "command_response",
      protocolVersion: PROTOCOL_VERSION,
      generation,
      ...(commandId ? { commandId } : {}),
      ...(command ? { command } : {}),
      accepted: false,
      error: error.slice(0, 512),
    };
    sendControl(channel, message);
  }

  function requireCurrentGeneration(command: ClientCommand): void {
    if (
      "generation" in command &&
      command.generation !== undefined &&
      command.generation !== generation
    ) {
      throw new Error("Stale session generation; request a fresh snapshot");
    }
  }

  function handleCommand(
    channel: ClientQueue,
    principal: StandalonePrincipal,
    command: ClientCommand,
    startCompletion: (command: Extract<ClientCommand, { type: "complete" }>) => void,
  ): void {
    requireCurrentGeneration(command);
    if (!authentication.authorize(principal, command)) throw new Error("Command not authorized");
    switch (command.type) {
      case "prompt":
        if (promptAdmission || !context.isIdle()) {
          throw new Error("Pi is busy; choose steer or follow-up explicitly");
        }
        promptAdmission = true;
        try {
          pi.sendUserMessage(command.content);
        } catch (error) {
          promptAdmission = false;
          throw error;
        }
        accepted(channel, command);
        return;
      case "steer":
        if (context.isIdle()) throw new Error("Pi is idle; send a prompt instead");
        pi.sendUserMessage(command.content, { deliverAs: "steer" });
        accepted(channel, command);
        return;
      case "follow_up":
        if (context.isIdle()) throw new Error("Pi is idle; send a prompt instead");
        pi.sendUserMessage(command.content, { deliverAs: "followUp" });
        accepted(channel, command);
        return;
      case "abort":
        context.abort();
        accepted(channel, command);
        return;
      case "snapshot": {
        const update = reconcile();
        if (update) scheduleUpdate(update);
        flushUpdate();
        accepted(channel, command);
        channel.enqueueSnapshot(snapshotSerialized(command.commandId));
        return;
      }
      case "history_page": {
        if (!channel.isOpen()) throw new Error("History connection is closed");
        if (pendingHistory.has(channel)) {
          throw new Error("An earlier history page is still being delivered");
        }
        pendingHistory.add(channel);
        try {
          const serialized = serialize(store.historyPage(command));
          if (!channel.enqueueControl(serialized, () => pendingHistory.delete(channel))) {
            pendingHistory.delete(channel);
            throw new Error("History connection is closed");
          }
        } catch (error) {
          pendingHistory.delete(channel);
          throw error;
        }
        return;
      }
      case "provider_snapshot": {
        const snapshot = providers.snapshot(command.provider);
        if (!snapshot) throw new Error(`Dashboard provider unavailable: ${command.provider}`);
        accepted(channel, command);
        sendControl(channel, {
          type: "provider_snapshot",
          protocolVersion: PROTOCOL_VERSION,
          generation,
          commandId: command.commandId,
          ...snapshot,
        });
        return;
      }
      case "provider_action":
        void providers
          .action(command.provider, command.action, command.payload)
          .then((data) => {
            accepted(channel, command);
            sendControl(channel, {
              type: "provider_action_result",
              protocolVersion: PROTOCOL_VERSION,
              generation,
              provider: command.provider,
              revision: providers.snapshot(command.provider)?.revision ?? 0,
              commandId: command.commandId,
              data,
            });
          })
          .catch((error: unknown) =>
            rejected(
              channel,
              command.commandId,
              command.type,
              error instanceof Error ? error.message : "Provider action failed",
            ),
          );
        return;
      case "complete":
        accepted(channel, command);
        startCompletion(command);
        return;
      case "ping": {
        accepted(channel, command);
        const pong: PongMessage = {
          type: "pong",
          protocolVersion: PROTOCOL_VERSION,
          generation,
          commandId: command.commandId,
        };
        sendControl(channel, pong);
      }
    }
  }

  websocketServer.on("connection", (websocket) => {
    const principal = websocketPrincipals.get(websocket);
    if (!principal) {
      websocket.terminate();
      return;
    }
    let completionController: AbortController | undefined;
    const update = reconcile();
    if (update) scheduleUpdate(update);
    flushUpdate();
    const channel = new ClientQueue(websocket, () => snapshotSerialized());
    clients.set(websocket, channel);
    const ready: ReadyMessage = {
      type: "ready",
      protocolVersion: PROTOCOL_VERSION,
      generation,
      revision: store.revision,
    };
    sendControl(channel, ready);
    channel.enqueueSnapshot();
    for (const snapshot of providers.list()) {
      channel.enqueueProvider(
        snapshot.provider,
        serialize({
          type: "provider_snapshot",
          protocolVersion: PROTOCOL_VERSION,
          generation,
          ...snapshot,
        }),
      );
    }
    websocket.on("message", (data, isBinary) => {
      if (isBinary) {
        rejected(channel, undefined, undefined, "Binary commands are not supported");
        return;
      }
      let command: ClientCommand | undefined;
      try {
        command = parseClientCommand(data.toString());
        handleCommand(channel, principal, command, (completion) => {
          completionController?.abort();
          const controller = new AbortController();
          completionController = controller;
          void (async () => {
            const items =
              completion.completionKind === "slash"
                ? slashCompletions(pi.getCommands(), completion.query)
                : await mentionCompletions(
                    autocompleteProvider,
                    completion.query,
                    controller.signal,
                  );
            if (controller.signal.aborted) return;
            const response: CompletionResultMessage = {
              type: "completion_result",
              protocolVersion: PROTOCOL_VERSION,
              generation,
              commandId: completion.commandId,
              completionKind: completion.completionKind,
              query: completion.query,
              items,
            };
            sendControl(channel, response);
          })();
        });
      } catch (error) {
        rejected(
          channel,
          command?.commandId,
          command?.type,
          error instanceof Error ? error.message : "Command failed",
        );
      }
    });
    websocket.on("error", () => {
      clients.delete(websocket);
      channel.terminate();
    });
    websocket.once("close", () => {
      completionController?.abort();
      clients.delete(websocket);
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (error: Error) => rejectPromise(error);
    server.once("error", onError);
    server.listen(config.port, config.bindHost, () => {
      server.off("error", onError);
      const address = server.address() as AddressInfo;
      const internalOrigin = listenerOrigin(config.bindHost, address.port);
      diagnosticUrl = new URL(config.basePath, internalOrigin);
      canonicalUrl = config.publicUrl ? new URL(config.publicUrl) : new URL(diagnosticUrl);
      allowedOrigins = new Set(config.allowedOrigins);
      allowedOrigins.add(canonicalUrl.origin);
      authentication = new StandaloneAuthentication(
        config.basePath,
        canonicalUrl.protocol === "https:",
      );
      resolvePromise();
    });
  }).catch(async (error) => {
    closed = true;
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
    pendingUpdate = undefined;
    providerUnsubscribe();
    providers.close();
    websocketServer.close();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    throw error;
  });

  const runtime: WebUiRuntime = {
    diagnosticUrl: diagnosticUrl.href,
    canonicalUrl: canonicalUrl.href,
    generation,
    createBootstrapUrl() {
      const url = new URL(canonicalUrl);
      url.hash = `bootstrap=${encodeURIComponent(authentication.issueBootstrap())}`;
      return url.href;
    },
    broadcast(type, payload) {
      if (closed) return;
      let update: StateUpdateMessage | undefined;
      switch (type) {
        case "agent_start":
          promptAdmission = false;
          update = store.agentStart();
          break;
        case "message_start":
          update = store.messageStart((payload as { message?: unknown }).message);
          break;
        case "message_update":
          update = store.messageUpdate((payload as { message?: unknown }).message);
          break;
        case "message_end":
          update = store.messageEnd((payload as { message?: unknown }).message);
          break;
        case "tool_execution_start":
          update = store.toolStart(payload as never);
          break;
        case "tool_execution_update":
          update = store.toolUpdate(payload as never);
          break;
        case "tool_execution_end":
          update = store.toolEnd(payload as never);
          break;
        case "model_select":
        case "thinking_level_select":
          update = store.updateMetadata(context, pi.getActiveTools());
          break;
        case "agent_settled":
          promptAdmission = false;
          store.reconcile(context, { settled: true, activeTools: pi.getActiveTools() });
          snapshotBarrier();
          return;
        case "session_tree":
        case "session_compact":
          store.rotateHistory(context);
          snapshotBarrier();
          return;
        case "session_info_changed":
          store.reconcile(context, { activeTools: pi.getActiveTools() });
          snapshotBarrier();
          return;
        default:
          return;
      }
      scheduleUpdate(update);
    },
    reconcile(settled = false) {
      const update = reconcile(settled);
      if (update) scheduleUpdate(update);
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        providerUnsubscribe();
        providers.close();
        if (coalesceTimer) clearTimeout(coalesceTimer);
        coalesceTimer = undefined;
        pendingUpdate = undefined;
        const serverClosed = new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
          server.closeIdleConnections();
        });
        authentication.clear();
        for (const channel of clients.values()) {
          channel.close(1001, "Session shutting down");
          channel.websocket.terminate();
        }
        clients.clear();
        await new Promise<void>((resolvePromise) => {
          websocketServer.close(() => resolvePromise());
        });
        await serverClosed;
      })();
      return closePromise;
    },
  };

  return runtime;
}
