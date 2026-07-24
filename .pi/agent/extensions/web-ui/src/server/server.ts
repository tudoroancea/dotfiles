import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WebSocket, WebSocketServer } from "ws";
import { LIMITS } from "../shared/limits.js";
import { bearerCredential, RunAuthentication } from "./auth.js";
import type { WebUiConfig } from "./config.js";
import { parseClientCommand, type ClientCommand } from "./protocol.js";

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

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
  close(): Promise<void>;
}

export interface StartWebUiServerOptions {
  pi: Pick<ExtensionAPI, "sendUserMessage">;
  context: ExtensionContext;
  config: WebUiConfig;
  assetRoot: string;
  generation: string;
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", CSP);
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  securityHeaders(response);
  response.statusCode = status;
  response.setHeader("Content-Type", CONTENT_TYPES[".json"]!);
  response.end(JSON.stringify(value));
}

function originAllowed(request: IncomingMessage, origins: ReadonlySet<string>): boolean {
  const origin = request.headers.origin;
  return origin !== undefined && origins.has(origin);
}

function loopbackUrl(host: string, port: number): URL {
  const displayHost = host === "::1" ? "[::1]" : host === "127.0.0.1" ? host : "127.0.0.1";
  return new URL(`http://${displayHost}:${port}/`);
}

function snapshot(context: ExtensionContext, generation: string) {
  const usage = context.getContextUsage();
  return {
    protocolVersion: 1,
    generation,
    sessionId: context.sessionManager.getSessionId(),
    cwd: context.cwd,
    isIdle: context.isIdle(),
    model: context.model
      ? { provider: context.model.provider, id: context.model.id, name: context.model.name }
      : undefined,
    thinkingLevel: context.thinkingLevel,
    contextUsage: usage
      ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
      : undefined,
  };
}

function commandName(command: ClientCommand): string {
  return command.type;
}

export async function startWebUiServer(options: StartWebUiServerOptions): Promise<WebUiRuntime> {
  const { pi, context, config, assetRoot, generation } = options;
  const authentication = new RunAuthentication();
  const clients = new Set<WebSocket>();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let diagnosticUrl = new URL("http://127.0.0.1/");
  let canonicalUrl = new URL(diagnosticUrl);
  let allowedOrigins = new Set<string>();

  const server = createServer({ maxHeaderSize: LIMITS.httpHeaderBytes }, (request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) json(response, 500, { error: "Internal server error" });
      else response.destroy();
    });
  });
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.incomingWebSocketBytes,
    perMessageDeflate: false,
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", diagnosticUrl);
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { status: "ok", protocolVersion: 1 });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/bootstrap") {
      if (!originAllowed(request, allowedOrigins)) {
        json(response, 403, { error: "Origin rejected" });
        return;
      }
      const credential = bearerCredential(request);
      if (!credential || !authentication.exchangeBootstrap(credential)) {
        json(response, 401, { error: "Invalid or expired bootstrap credential" });
        return;
      }
      authentication.setSessionCookie(response, canonicalUrl.protocol === "https:");
      json(response, 204, undefined);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/snapshot") {
      if (!authentication.authenticate(request)) {
        json(response, 401, { error: "Authentication required" });
        return;
      }
      json(response, 200, snapshot(context, generation));
      return;
    }
    if (request.method !== "GET") {
      json(response, 405, { error: "Method not allowed" });
      return;
    }

    const relativePath =
      url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const root = resolve(assetRoot);
    const filePath = resolve(root, relativePath);
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      json(response, 404, { error: "Not found" });
      return;
    }
    try {
      const content = await readFile(filePath);
      securityHeaders(response);
      response.statusCode = 200;
      response.setHeader(
        "Content-Type",
        CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      );
      response.end(content);
    } catch {
      json(response, 404, { error: "Not found" });
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
    const url = new URL(request.url ?? "/", diagnosticUrl);
    if (url.pathname !== "/ws") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!originAllowed(request, allowedOrigins)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (!authentication.authenticate(request)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    if (clients.size >= LIMITS.connectedClients) {
      rejectUpgrade(socket, 503, "Client limit reached");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  function send(websocket: WebSocket, value: unknown): void {
    if (websocket.readyState !== WebSocket.OPEN) return;
    const serialized = JSON.stringify(value);
    if (
      Buffer.byteLength(serialized) > LIMITS.outboundMessageBytes ||
      websocket.bufferedAmount + Buffer.byteLength(serialized) > LIMITS.outboundBytesPerClient
    ) {
      websocket.close(1013, "Client is too slow");
      return;
    }
    websocket.send(serialized);
  }

  function sendSnapshot(websocket: WebSocket, commandId?: string): void {
    send(websocket, {
      type: "snapshot",
      ...(commandId ? { commandId } : {}),
      snapshot: snapshot(context, generation),
    });
  }

  function accepted(websocket: WebSocket, command: ClientCommand): void {
    send(websocket, {
      type: "command_response",
      commandId: command.commandId,
      command: commandName(command),
      accepted: true,
    });
  }

  function rejected(
    websocket: WebSocket,
    commandId: string | undefined,
    command: string | undefined,
    error: string,
  ): void {
    send(websocket, {
      type: "command_response",
      ...(commandId ? { commandId } : {}),
      ...(command ? { command } : {}),
      accepted: false,
      error,
    });
  }

  function handleCommand(websocket: WebSocket, command: ClientCommand): void {
    switch (command.type) {
      case "prompt":
        if (!context.isIdle()) throw new Error("Pi is busy; choose steer or follow-up explicitly");
        pi.sendUserMessage(command.content);
        accepted(websocket, command);
        return;
      case "steer":
        if (context.isIdle()) throw new Error("Pi is idle; send a prompt instead");
        pi.sendUserMessage(command.content, { deliverAs: "steer" });
        accepted(websocket, command);
        return;
      case "follow_up":
        if (context.isIdle()) throw new Error("Pi is idle; send a prompt instead");
        pi.sendUserMessage(command.content, { deliverAs: "followUp" });
        accepted(websocket, command);
        return;
      case "abort":
        context.abort();
        accepted(websocket, command);
        return;
      case "snapshot":
        accepted(websocket, command);
        sendSnapshot(websocket, command.commandId);
        return;
      case "ping":
        accepted(websocket, command);
        send(websocket, { type: "pong", commandId: command.commandId });
    }
  }

  websocketServer.on("connection", (websocket) => {
    clients.add(websocket);
    send(websocket, { type: "ready", protocolVersion: 1, generation });
    sendSnapshot(websocket);
    websocket.on("message", (data, isBinary) => {
      if (isBinary) {
        rejected(websocket, undefined, undefined, "Binary commands are not supported");
        return;
      }
      let command: ClientCommand | undefined;
      try {
        command = parseClientCommand(data.toString());
        handleCommand(websocket, command);
      } catch (error) {
        rejected(
          websocket,
          command?.commandId,
          command?.type,
          error instanceof Error ? error.message : "Command failed",
        );
      }
    });
    websocket.on("error", () => {
      clients.delete(websocket);
      websocket.terminate();
    });
    websocket.once("close", () => clients.delete(websocket));
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (error: Error) => rejectPromise(error);
    server.once("error", onError);
    server.listen(config.port, config.host, () => {
      server.off("error", onError);
      const address = server.address() as AddressInfo;
      diagnosticUrl = loopbackUrl(config.host, address.port);
      canonicalUrl = config.remoteUrl ? new URL(config.remoteUrl) : new URL(diagnosticUrl);
      allowedOrigins = new Set([diagnosticUrl.origin, canonicalUrl.origin]);
      resolvePromise();
    });
  }).catch(async (error) => {
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
      let message: unknown = { type: "event", event: type, payload };
      try {
        const bytes = Buffer.byteLength(JSON.stringify(message));
        if (bytes > LIMITS.outboundMessageBytes) {
          message = { type: "resync_required", reason: "Event exceeded the transport limit" };
        }
      } catch {
        message = { type: "resync_required", reason: "Event was not serializable" };
      }
      for (const client of clients) send(client, message);
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        authentication.clear();
        for (const client of clients) {
          client.close(1001, "Session shutting down");
          client.terminate();
        }
        clients.clear();
        await new Promise<void>((resolvePromise) => {
          websocketServer.close(() => resolvePromise());
        });
        await new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
          server.closeIdleConnections();
        });
      })();
      return closePromise;
    },
  };

  return runtime;
}
