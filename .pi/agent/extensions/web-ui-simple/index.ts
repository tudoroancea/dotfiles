import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// A deliberately tiny, read-only browser companion for the current Pi session.
//
// The whole surface is: a Node loopback HTTP server that serves a static Preact
// app shell and streams a fresh full snapshot of the active branch over SSE.
// There is no wire protocol, no reducer, no pagination — every relevant Pi
// event simply re-broadcasts the current transcript.
// ---------------------------------------------------------------------------

const WEB_ROOT = fileURLToPath(new URL("./web/", import.meta.url));
const COOKIE_NAME = `pi_wus_${randomBytes(6).toString("base64url")}`;
const MAX_AUTH_BODY_BYTES = 4096;
const BROADCAST_DEBOUNCE_MS = 60;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

interface LiveTool {
  toolCallId: string;
  toolName: string;
  content: unknown[];
  details: unknown;
  isError: boolean;
  hasResult: boolean;
}

interface Snapshot {
  header: unknown;
  leafId: string | null;
  sessionName: string | undefined;
  isRunning: boolean;
  entries: unknown[];
}

interface WebUiServer {
  readonly url: string;
  bootstrapUrl(): string;
  broadcast(): void;
  close(): Promise<void>;
}

interface SseClient {
  response: ServerResponse;
  blocked: boolean;
  pending: string | undefined;
}

function normalizeResultContent(raw: unknown): { content: unknown[]; details: unknown } {
  if (raw && typeof raw === "object" && Array.isArray((raw as { content?: unknown }).content)) {
    const record = raw as { content: unknown[]; details?: unknown };
    return { content: record.content, details: record.details };
  }
  if (typeof raw === "string")
    return { content: [{ type: "text", text: raw }], details: undefined };
  if (raw == null) return { content: [], details: undefined };
  return { content: [{ type: "text", text: JSON.stringify(raw) }], details: undefined };
}

function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name) cookies.set(name, part.slice(index + 1).trim());
  }
  return cookies;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_AUTH_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startServer(getSnapshot: () => Snapshot): Promise<WebUiServer> {
  const sessionToken = randomBytes(32).toString("base64url");
  const basePath = `/${randomBytes(18).toString("base64url")}/`;
  const bootstrapCodes = new Set<string>();
  const clients = new Set<SseClient>();
  let lastSnapshotVersion = "";

  function snapshotVersion(snapshot: Snapshot): string {
    const last = snapshot.entries.at(-1) as { id?: unknown; timestamp?: unknown } | undefined;
    return [
      snapshot.leafId,
      snapshot.entries.length,
      last?.id,
      last?.timestamp,
      snapshot.isRunning,
      snapshot.sessionName,
    ].join("|");
  }

  function snapshotFrame(): string {
    const snapshot = getSnapshot();
    lastSnapshotVersion = snapshotVersion(snapshot);
    return `data: ${JSON.stringify(snapshot)}\n\n`;
  }

  function authenticated(request: IncomingMessage): boolean {
    const cookie = parseCookies(request.headers.cookie).get(COOKIE_NAME);
    return cookie !== undefined && timingSafeEqualString(cookie, sessionToken);
  }

  function sendJson(response: ServerResponse, status: number, value: unknown): void {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(value === undefined ? "" : JSON.stringify(value));
  }

  async function serveStatic(route: string, response: ServerResponse): Promise<void> {
    const relative = route === "" ? "index.html" : route.replace(/^\/+/, "");
    const filePath = normalize(join(WEB_ROOT, relative));
    if (filePath !== WEB_ROOT.replace(/\/$/, "") && !filePath.startsWith(WEB_ROOT)) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    try {
      const content = await readFile(filePath);
      response.statusCode = 200;
      response.setHeader(
        "Content-Type",
        CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      );
      response.setHeader("Cache-Control", "no-store");
      response.end(content);
    } catch {
      sendJson(response, 404, { error: "Not found" });
    }
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "Server error" });
      else response.destroy();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = (request.url ?? "/").split("?")[0];
    if (!pathname.startsWith(basePath)) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    const route = pathname.slice(basePath.length);

    if (request.method === "POST" && route === "auth") {
      let code: unknown;
      try {
        code = JSON.parse(await readBody(request)).code;
      } catch {
        sendJson(response, 400, { error: "Invalid request" });
        return;
      }
      if (typeof code !== "string" || !bootstrapCodes.delete(code)) {
        sendJson(response, 401, { error: "Invalid or expired code" });
        return;
      }
      response.setHeader(
        "Set-Cookie",
        `${COOKIE_NAME}=${sessionToken}; HttpOnly; SameSite=Strict; Path=${basePath}`,
      );
      sendJson(response, 204, undefined);
      return;
    }

    if (request.method === "GET" && route === "events") {
      if (!authenticated(request)) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Connection", "keep-alive");
      const client: SseClient = { response, blocked: false, pending: undefined };
      const remove = () => clients.delete(client);
      response.on("close", remove);
      response.on("error", remove);
      response.on("drain", () => {
        client.blocked = false;
        if (!client.pending) return;
        const pending = client.pending;
        client.pending = undefined;
        writeFrame(client, pending);
      });
      clients.add(client);
      writeFrame(client, snapshotFrame());
      return;
    }

    if (request.method === "GET") {
      await serveStatic(route, response);
      return;
    }

    sendJson(response, 405, { error: "Method not allowed" });
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });

  function writeFrame(client: SseClient, frame: string): void {
    if (client.blocked) {
      client.pending = frame;
      return;
    }
    client.blocked = !client.response.write(frame);
  }

  const freshnessTimer = setInterval(() => {
    if (clients.size === 0) return;
    const snapshot = getSnapshot();
    if (snapshotVersion(snapshot) === lastSnapshotVersion) return;
    lastSnapshotVersion = snapshotVersion(snapshot);
    const frame = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of clients) writeFrame(client, frame);
  }, 500);
  freshnessTimer.unref?.();

  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    url: `${origin}${basePath}`,
    bootstrapUrl() {
      const code = randomBytes(24).toString("base64url");
      bootstrapCodes.add(code);
      return `${origin}${basePath}#code=${code}`;
    },
    broadcast() {
      if (clients.size === 0) return;
      const frame = snapshotFrame();
      for (const client of clients) writeFrame(client, frame);
    },
    async close() {
      clearInterval(freshnessTimer);
      bootstrapCodes.clear();
      for (const client of clients) client.response.end();
      clients.clear();
      await new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        server.closeAllConnections();
      });
    },
  };
}

export default function webUiSimpleExtension(pi: ExtensionAPI): void {
  let server: WebUiServer | undefined;
  let context: ExtensionContext | undefined;
  let broadcastTimer: NodeJS.Timeout | undefined;

  // Live overlay: streaming assistant message plus in-progress tool executions
  // that are not yet persisted into the branch.
  let liveAssistant: unknown | undefined;
  const liveTools = new Map<string, LiveTool>();

  function buildSnapshot(): Snapshot {
    if (!context) {
      return { header: null, leafId: null, sessionName: undefined, isRunning: false, entries: [] };
    }
    const sm = context.sessionManager;
    const entries: unknown[] = [...sm.getBranch()];

    if (liveAssistant) {
      entries.push({
        type: "message",
        id: "live-assistant",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: liveAssistant,
      });
    }

    const persistedResults = new Set<string>();
    for (const entry of entries) {
      const record = entry as { type?: string; message?: { role?: string; toolCallId?: string } };
      if (
        record.type === "message" &&
        record.message?.role === "toolResult" &&
        record.message.toolCallId
      ) {
        persistedResults.add(record.message.toolCallId);
      }
    }
    for (const tool of liveTools.values()) {
      if (!tool.hasResult || persistedResults.has(tool.toolCallId)) continue;
      entries.push({
        type: "message",
        id: `live-tr-${tool.toolCallId}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        message: {
          role: "toolResult",
          toolCallId: tool.toolCallId,
          toolName: tool.toolName,
          content: tool.content,
          details: tool.details,
          isError: tool.isError,
        },
      });
    }

    return {
      header: sm.getHeader(),
      leafId: sm.getLeafId(),
      sessionName: sm.getSessionName?.(),
      isRunning: !context.isIdle(),
      entries,
    };
  }

  function scheduleBroadcast(): void {
    if (!server || broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      server?.broadcast();
    }, BROADCAST_DEBOUNCE_MS);
    broadcastTimer.unref?.();
  }

  function clearLive(): void {
    liveAssistant = undefined;
    liveTools.clear();
  }

  pi.registerCommand("copy-web-ui-simple-url", {
    description: "Copy an authenticated Pi Web UI (simple) link",
    handler: async (_args: string, commandContext: ExtensionCommandContext): Promise<void> => {
      if (!server) {
        commandContext.ui.notify("Pi Web UI (simple) is not running in this mode.", "error");
        return;
      }
      try {
        await copyToClipboard(server.bootstrapUrl());
        commandContext.ui.notify("Web UI link copied.", "info");
      } catch (error) {
        const reason = error instanceof Error ? error.message : "clipboard unavailable";
        commandContext.ui.notify(`Could not copy Web UI link: ${reason}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    if (server) await server.close();
    clearLive();
    context = ctx;
    server = await startServer(buildSnapshot);
    if (ctx.mode === "tui") {
      ctx.ui.notify(
        `Pi Web UI (simple): ${server.url} — use /copy-web-ui-simple-url for an authenticated link.`,
        "info",
      );
    } else {
      process.stderr.write(`Pi Web UI (simple): ${server.url}\n`);
    }
  });

  pi.on("agent_start", () => scheduleBroadcast());
  pi.on("message_start", (event) => {
    const message = (event as { message?: { role?: string } }).message;
    if (message?.role === "assistant") liveAssistant = message;
    scheduleBroadcast();
  });
  pi.on("message_update", (event) => {
    const message = (event as { message?: { role?: string } }).message;
    if (message?.role === "assistant") liveAssistant = message;
    scheduleBroadcast();
  });
  pi.on("message_end", (event) => {
    const message = (event as { message?: { role?: string } }).message;
    if (message?.role === "assistant") liveAssistant = undefined;
    scheduleBroadcast();
  });

  pi.on("tool_execution_start", (event) => {
    const typed = event as { toolCallId: string; toolName: string };
    liveTools.set(typed.toolCallId, {
      toolCallId: typed.toolCallId,
      toolName: typed.toolName,
      content: [],
      details: undefined,
      isError: false,
      hasResult: false,
    });
    scheduleBroadcast();
  });
  pi.on("tool_execution_update", (event) => {
    const typed = event as { toolCallId: string; toolName: string; partialResult: unknown };
    const { content, details } = normalizeResultContent(typed.partialResult);
    liveTools.set(typed.toolCallId, {
      toolCallId: typed.toolCallId,
      toolName: typed.toolName,
      content,
      details,
      isError: false,
      hasResult: content.length > 0,
    });
    scheduleBroadcast();
  });
  pi.on("tool_execution_end", (event) => {
    const typed = event as {
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };
    const { content, details } = normalizeResultContent(typed.result);
    liveTools.set(typed.toolCallId, {
      toolCallId: typed.toolCallId,
      toolName: typed.toolName,
      content,
      details,
      isError: typed.isError,
      hasResult: true,
    });
    scheduleBroadcast();
  });

  pi.on("agent_settled", () => {
    clearLive();
    scheduleBroadcast();
  });
  pi.on("model_select", () => scheduleBroadcast());
  pi.on("thinking_level_select", () => scheduleBroadcast());
  pi.on("session_tree", () => {
    clearLive();
    scheduleBroadcast();
  });
  pi.on("session_compact", () => {
    clearLive();
    scheduleBroadcast();
  });
  pi.on("session_info_changed", () => scheduleBroadcast());

  pi.on("session_shutdown", async () => {
    const active = server;
    server = undefined;
    context = undefined;
    clearLive();
    if (broadcastTimer) clearTimeout(broadcastTimer);
    broadcastTimer = undefined;
    if (active) await active.close();
  });
}
