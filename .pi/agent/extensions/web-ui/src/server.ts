import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";

const CLIENT_ROOT = fileURLToPath(new URL("./client/", import.meta.url));
const COOKIE_NAME = `pi_wus_${randomBytes(6).toString("base64url")}`;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 32 * 1024;
const MAX_COMPLETION_QUERY_BYTES = 4 * 1024;
const MAX_BOOTSTRAP_CODES = 8;
const BOOTSTRAP_CODE_TTL_MS = 2 * 60 * 1000;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface ThemePalette {
  [name: string]: string;
}

export interface SnapshotTheme {
  auto: boolean;
  light: ThemePalette;
  dark: ThemePalette;
}

export interface SessionMetadata {
  cwd: string;
  home: string;
  contextUsage:
    | { tokens: number | null; contextWindow: number; percent: number | null }
    | undefined;
  sessionCost: number;
  model: { provider: string; id: string; name: string } | undefined;
  thinkingLevel: string | undefined;
}

export interface PendingInput {
  id: string;
  content: string;
  delivery: "steer" | "followUp";
}

export interface Snapshot {
  header: unknown;
  leafId: string | null;
  sessionName: string | undefined;
  isRunning: boolean;
  workingWord: string | undefined;
  theme: SnapshotTheme | undefined;
  systemPrompt: string;
  metadata: SessionMetadata | undefined;
  pendingInputs: PendingInput[];
  entries: unknown[];
}

export type InputDelivery = "immediate" | "steer" | "followUp";

export interface CompletionItem {
  value: string;
  label: string;
  description?: string;
}

export interface StartServerOptions {
  submitInput?: (
    content: string,
    delivery: InputDelivery,
  ) => Promise<{ accepted: boolean; error?: string }>;
  completeMention?: (query: string, signal: AbortSignal) => Promise<CompletionItem[]>;
}

export interface WebUiServer {
  readonly url: string;
  readonly origin: string;
  readonly port: number;
  bootstrapUrl(origin?: string): string;
  broadcast(): void;
  close(): Promise<void>;
}

interface SseClient {
  response: ServerResponse;
  blocked: boolean;
  pending: string | undefined;
}

interface BootstrapCode {
  expiresAt: number;
  timer: NodeJS.Timeout;
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
    if (size > MAX_REQUEST_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

export async function startServer(
  getSnapshot: () => Snapshot,
  options: StartServerOptions = {},
): Promise<WebUiServer> {
  const sessionToken = randomBytes(32).toString("base64url");
  const basePath = `/${randomBytes(18).toString("base64url")}/`;
  const bootstrapCodes = new Map<string, BootstrapCode>();
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
      snapshot.workingWord,
      snapshot.sessionName,
      snapshot.systemPrompt,
      JSON.stringify(snapshot.theme),
      JSON.stringify(snapshot.metadata),
      JSON.stringify(snapshot.pendingInputs),
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
    const filePath = normalize(join(CLIENT_ROOT, relative));
    if (filePath !== CLIENT_ROOT.replace(/\/$/, "") && !filePath.startsWith(CLIENT_ROOT)) {
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
      const bootstrapCode = typeof code === "string" ? bootstrapCodes.get(code) : undefined;
      if (typeof code !== "string" || !bootstrapCode || bootstrapCode.expiresAt <= Date.now()) {
        if (typeof code === "string" && bootstrapCode) {
          clearTimeout(bootstrapCode.timer);
          bootstrapCodes.delete(code);
        }
        sendJson(response, 401, { error: "Invalid or expired code" });
        return;
      }
      clearTimeout(bootstrapCode.timer);
      bootstrapCodes.delete(code);
      response.setHeader(
        "Set-Cookie",
        `${COOKIE_NAME}=${sessionToken}; HttpOnly; SameSite=Strict; Path=${basePath}`,
      );
      sendJson(response, 204, undefined);
      return;
    }

    if (request.method === "POST" && route === "input") {
      if (!authenticated(request)) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: "Cross-origin requests are not allowed" });
        return;
      }
      if (!options.submitInput) {
        sendJson(response, 503, { accepted: false, error: "Input is unavailable" });
        return;
      }
      let value: { content?: unknown; delivery?: unknown };
      try {
        value = JSON.parse(await readBody(request)) as typeof value;
      } catch {
        sendJson(response, 400, { accepted: false, error: "Invalid request" });
        return;
      }
      const content = typeof value.content === "string" ? value.content : "";
      const delivery = value.delivery;
      if (!content.trim() || Buffer.byteLength(content) > MAX_INPUT_BYTES) {
        sendJson(response, 400, { accepted: false, error: "Message is empty or too large" });
        return;
      }
      if (delivery !== "immediate" && delivery !== "steer" && delivery !== "followUp") {
        sendJson(response, 400, { accepted: false, error: "Invalid delivery mode" });
        return;
      }
      try {
        const result = await options.submitInput(content, delivery);
        sendJson(response, result.accepted ? 202 : 409, result);
      } catch (error) {
        sendJson(response, 500, {
          accepted: false,
          error: error instanceof Error ? error.message.slice(0, 512) : "Message failed",
        });
      }
      return;
    }

    if (request.method === "POST" && route === "complete") {
      if (!authenticated(request)) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (!sameOrigin(request)) {
        sendJson(response, 403, { error: "Cross-origin requests are not allowed" });
        return;
      }
      if (!options.completeMention) {
        sendJson(response, 200, { items: [] });
        return;
      }
      let query: unknown;
      try {
        query = (JSON.parse(await readBody(request)) as { query?: unknown }).query;
      } catch {
        sendJson(response, 400, { error: "Invalid request" });
        return;
      }
      if (typeof query !== "string" || Buffer.byteLength(query) > MAX_COMPLETION_QUERY_BYTES) {
        sendJson(response, 400, { error: "Invalid completion query" });
        return;
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      const close = () => {
        if (!response.writableEnded) abort();
      };
      request.once("aborted", abort);
      response.once("close", close);
      const items = await options.completeMention(query, controller.signal);
      request.off("aborted", abort);
      response.off("close", close);
      if (!controller.signal.aborted && !response.destroyed) {
        sendJson(response, 200, { items: items.slice(0, 20) });
      }
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
    origin,
    port,
    bootstrapUrl(publicOrigin = origin) {
      const now = Date.now();
      for (const [code, bootstrapCode] of bootstrapCodes) {
        if (bootstrapCode.expiresAt > now) continue;
        clearTimeout(bootstrapCode.timer);
        bootstrapCodes.delete(code);
      }
      while (bootstrapCodes.size >= MAX_BOOTSTRAP_CODES) {
        const oldestCode = bootstrapCodes.keys().next().value;
        if (oldestCode === undefined) break;
        clearTimeout(bootstrapCodes.get(oldestCode)?.timer);
        bootstrapCodes.delete(oldestCode);
      }
      const code = randomBytes(24).toString("base64url");
      const expiryTimer = setTimeout(() => bootstrapCodes.delete(code), BOOTSTRAP_CODE_TTL_MS);
      expiryTimer.unref?.();
      bootstrapCodes.set(code, { expiresAt: now + BOOTSTRAP_CODE_TTL_MS, timer: expiryTimer });
      return `${publicOrigin}${basePath}#code=${code}`;
    },
    broadcast() {
      if (clients.size === 0) return;
      const frame = snapshotFrame();
      for (const client of clients) writeFrame(client, frame);
    },
    async close() {
      clearInterval(freshnessTimer);
      for (const bootstrapCode of bootstrapCodes.values()) clearTimeout(bootstrapCode.timer);
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

export async function fallbackFileCompletions(
  cwd: string,
  query: string,
  signal: AbortSignal,
): Promise<CompletionItem[]> {
  const quoted = query.startsWith('@"');
  const rawQuery = query.replace(/^@"?/, "").replace(/"$/, "").toLowerCase();
  const queue = [""];
  const entries: Array<{ path: string; directory: boolean; score: number }> = [];
  const ignored = new Set([".git", "node_modules"]);
  while (queue.length && entries.length < 5000 && !signal.aborted) {
    const relativeDir = queue.shift()!;
    let children;
    try {
      children = await readdir(join(cwd, relativeDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (ignored.has(child.name)) continue;
      const path = relativeDir ? `${relativeDir}/${child.name}` : child.name;
      const directory = child.isDirectory();
      if (directory) queue.push(path);
      const lower = path.toLowerCase();
      let queryIndex = 0;
      for (const character of lower) {
        if (character === rawQuery[queryIndex]) queryIndex += 1;
      }
      if (!rawQuery || queryIndex === rawQuery.length) {
        entries.push({
          path,
          directory,
          score: rawQuery ? (lower.includes(rawQuery) ? 2 : 1) : 1,
        });
      }
      if (entries.length >= 5000) break;
    }
  }
  return entries
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 20)
    .map((entry) => {
      const path = `${entry.path}${entry.directory ? "/" : ""}`;
      const needsQuotes = quoted || path.includes(" ");
      return {
        value: needsQuotes ? `@"${path}"` : `@${path}`,
        label: `${entry.path.split("/").at(-1)}${entry.directory ? "/" : ""}`,
        description: entry.path,
      };
    });
}

export async function mentionCompletions(
  provider: AutocompleteProvider,
  query: string,
  signal: AbortSignal,
): Promise<CompletionItem[]> {
  if (signal.aborted) return [];
  try {
    const token = query.startsWith("@") ? query : `@${query}`;
    const result = await provider.getSuggestions([token], 0, token.length, { signal });
    if (!result || signal.aborted) return [];
    return result.items.slice(0, 20).map((item) => ({
      value: String(item.value).slice(0, 1024),
      label: String(item.label).slice(0, 512),
      ...(item.description ? { description: String(item.description).slice(0, 1024) } : {}),
    }));
  } catch {
    return [];
  }
}
