import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import {
  CommandResponseEnvelopeSchema,
  ErrorEnvelopeSchema,
  LIMITS,
  ModelControlResponseEnvelopeSchema,
  PROTOCOL_VERSION,
  type ModelControlRejectionReason,
  type QueueMutationRejectionReason,
} from "@dotfiles/pi-web-ui-client/wire";
import { Check } from "typebox/value";
import type { DaemonConfig } from "../config/schema.ts";
import type { LocalLaunches } from "../host/launches.ts";
import { publicApiFailure } from "./errors.ts";
import { SseConnectionSet } from "./sse.ts";
import { redirectToAppRoot, serveManagedAsset, serveManagedDocument } from "./static.ts";
import {
  assertControlPlaneOutput,
  parseControlCommand,
  parseEmptyRequest,
  parseImageAttachmentCommand,
  parseLaunchRequest,
  parseQueueMutation,
  parseSessionCommand,
} from "./schemas.ts";

const API = "/_pi/api/v1";
const BODY_LIMIT = 256 * 1024;
const IMAGE_COMMAND_BODY_LIMIT =
  Math.ceil((LIMITS.maxImageSourceBytesPerEntry / 3) * 4) + 256 * 1024;
const MAX_CONCURRENT_COMMAND_READERS = 4;
const COMMAND_BODY_TIMEOUT_MS = 15_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const streamSets = new WeakMap<Server, SseConnectionSet>();

export interface LocalApiOptions {
  config: Pick<DaemonConfig, "listener">;
  launches: LocalLaunches;
  daemonId?: string;
}
export interface StartedLocalApi {
  server: Server;
  host: "127.0.0.1" | "::1";
  port: number;
  close(): Promise<void>;
}

function localPeer(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.split("%")[0];
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function safeHost(value: string | undefined): boolean {
  if (
    !value ||
    value.length > 255 ||
    value.includes(",") ||
    value.includes("@") ||
    [...value].some((character) => character.charCodeAt(0) <= 0x20)
  )
    return false;
  const hostname = value.startsWith("[")
    ? value.slice(1, value.indexOf("]"))
    : value.split(":")[0]!;
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    (isIP(hostname) === 6 && hostname === "::1")
  );
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  return origin === `http://${request.headers.host}`;
}

async function jsonBody(
  request: IncomingMessage,
  maxBytes = BODY_LIMIT,
  timeoutMs = 0,
): Promise<unknown> {
  const read = (async () => {
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") throw new TypeError("JSON content type required");
    const declared = Number(request.headers["content-length"] ?? 0);
    if (!Number.isFinite(declared) || declared > maxBytes) throw new RangeError("Body too large");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > maxBytes) throw new RangeError("Body too large");
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  })();
  if (timeoutMs <= 0) return read;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          request.destroy();
          reject(new Error("Request body timed out"));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  assertControlPlaneOutput(body);
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(encoded);
}

function publicErrorMessage(message: string): string {
  const bounded = message.slice(0, LIMITS.maxErrorChars);
  return bounded.length > 0 ? bounded : "Command was rejected";
}

function queueMutationReason(code: string): QueueMutationRejectionReason {
  switch (code) {
    case "stale-item":
    case "not-found":
    case "released":
    case "queue-busy":
    case "ambiguous":
    case "capability-off":
    case "session-changed":
      return code;
    default:
      return "invalid";
  }
}

function modelControlReason(code: string): ModelControlRejectionReason {
  switch (code) {
    case "capability_off":
      return "capability-off";
    case "host_not_ready":
    case "admission_interrupted":
    case "command_epoch_exhausted":
      return "session-changed";
    case "admission_queue_full":
    case "admission_timeout":
    case "admission_limit_exhausted":
    case "message_queue_full":
      return "queue-busy";
    default:
      return "invalid";
  }
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader("allow", allow);
  send(response, 405, { error: { code: "method_not_allowed" } });
}

function acceptsEventStream(value: string | undefined): boolean {
  if (!value) return false;
  return value.split(",").some((item) => {
    const [mediaType, ...parameters] = item.split(";").map((part) => part.trim().toLowerCase());
    if (mediaType !== "text/event-stream") return false;
    const quality = parameters.find((parameter) => parameter.startsWith("q="));
    if (!quality) return true;
    const parsed = Number(quality.slice(2));
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1;
  });
}

export function createLocalApiServer(options: LocalApiOptions): Server {
  const streams = new SseConnectionSet();
  const readerState = { active: 0 };
  const server = createServer(async (request, response) => {
    try {
      if (!localPeer(request.socket.remoteAddress))
        return send(response, 403, { error: { code: "local_only" } });
      if (!safeHost(request.headers.host))
        return send(response, 400, { error: { code: "unsafe_host" } });
      const url = new URL(request.url ?? "/", "http://local.invalid");
      if (url.pathname.startsWith(API) && url.search !== "")
        return send(response, 400, { error: { code: "unexpected_query" } });
      const method = request.method ?? "";
      if (method !== "GET" && method !== "POST") return methodNotAllowed(response, "GET, POST");
      if (method === "POST" && !sameOrigin(request))
        return send(response, 403, { error: { code: "cross_origin" } });

      if (url.pathname === `${API}/host`) {
        if (method !== "GET") return methodNotAllowed(response, "GET");
        return send(response, 200, {
          kind: "pi-local-session-host",
          apiVersion: 1,
          daemonId: options.daemonId ?? "local",
        });
      }
      if (url.pathname === `${API}/roots`) {
        if (method !== "GET") return methodNotAllowed(response, "GET");
        return send(response, 200, { roots: options.launches.rootSummaries() });
      }
      if (url.pathname === `${API}/sessions`) {
        if (method === "GET")
          return send(response, 200, { launches: options.launches.registry.list() });
        const body = parseLaunchRequest(await jsonBody(request));
        return send(response, 201, { launch: await options.launches.create(body) });
      }
      const match = url.pathname.match(
        new RegExp(`^${API}/sessions/([^/]+)(/stop|/reopen|/command|/commands|/events)?$`),
      );
      if (match && ID.test(match[1]!)) {
        const launchId = match[1]!;
        if (match[2] === "/stop") {
          if (method !== "POST") return methodNotAllowed(response, "POST");
          parseEmptyRequest(await jsonBody(request));
          return send(response, 200, { launch: await options.launches.registry.stop(launchId) });
        }
        if (match[2] === "/reopen") {
          if (method !== "POST") return methodNotAllowed(response, "POST");
          parseEmptyRequest(await jsonBody(request));
          return send(response, 200, { launch: await options.launches.registry.reopen(launchId) });
        }
        if (match[2] === "/commands") {
          if (method !== "GET") return methodNotAllowed(response, "GET");
          return send(response, 200, options.launches.registry.commands(launchId));
        }
        if (match[2] === "/events") {
          if (method !== "GET") return methodNotAllowed(response, "GET");
          if (!acceptsEventStream(request.headers.accept))
            return send(response, 406, { error: { code: "event_stream_required" } });
          if (!sameOrigin(request)) return send(response, 403, { error: { code: "cross_origin" } });
          const admission = streams.acquire(launchId);
          if (!admission) return send(response, 503, { error: { code: "event_stream_capacity" } });
          try {
            const attachment = options.launches.registry.projection(launchId);
            response.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-store",
              connection: "keep-alive",
              "referrer-policy": "no-referrer",
              "x-content-type-options": "nosniff",
              "x-frame-options": "DENY",
            });
            admission.open(attachment, response);
          } catch (error) {
            admission.release();
            if (response.headersSent) {
              response.destroy();
              return;
            }
            throw error;
          }
          return;
        }
        if (match[2] === "/command") {
          if (method !== "POST") return methodNotAllowed(response, "POST");
          if (readerState.active >= MAX_CONCURRENT_COMMAND_READERS)
            return send(response, 503, { error: { code: "command_reader_capacity" } });
          readerState.active += 1;
          let body: unknown;
          try {
            body = await jsonBody(request, IMAGE_COMMAND_BODY_LIMIT, COMMAND_BODY_TIMEOUT_MS);
          } finally {
            readerState.active -= 1;
          }
          const kind =
            body && typeof body === "object" && !Array.isArray(body)
              ? (body as Record<string, unknown>).type
              : undefined;
          if (kind === "image-command") {
            const input = parseImageAttachmentCommand(body);
            const result = await options.launches.registry.command(
              launchId,
              input.generation,
              input.commandEpoch,
              {
                type:
                  input.delivery === "immediate"
                    ? "prompt"
                    : input.delivery === "steer"
                      ? "steer"
                      : "follow_up",
                commandId: input.commandId,
                text: input.content,
                images: input.attachments.map((image) => ({
                  data: image.data,
                  mimeType: image.mimeType,
                  width: image.width,
                  height: image.height,
                  byteLength: image.byteLength,
                })),
              },
            );
            if (result.status === "ambiguous") {
              const output = {
                version: PROTOCOL_VERSION,
                type: "error" as const,
                generation: input.generation,
                commandId: input.commandId,
                code: "ADMISSION_AMBIGUOUS",
                message: publicErrorMessage(result.message),
                recoverable: false,
              };
              if (!Check(ErrorEnvelopeSchema, output))
                throw new Error("Invalid shared error envelope");
              return send(response, 409, output);
            }
            const output = {
              version: PROTOCOL_VERSION,
              type: "command-response" as const,
              commandId: input.commandId,
              generation: input.generation,
              commandEpoch: input.commandEpoch,
              accepted:
                result.status === "accepted" ||
                result.status === "queued" ||
                result.status === "handled",
              ...(result.status === "rejected"
                ? { error: publicErrorMessage(result.message) }
                : {}),
            };
            if (!Check(CommandResponseEnvelopeSchema, output))
              throw new Error("Invalid shared image command response");
            return send(response, 200, output);
          }
          if (kind === "queue-edit" || kind === "queue-remove") {
            const input = parseQueueMutation(body);
            const result = await options.launches.registry.command(
              launchId,
              input.generation,
              input.commandEpoch,
              input.type === "queue-edit"
                ? {
                    type: "queue_edit",
                    commandId: input.commandId,
                    itemId: input.itemId,
                    expectedItemVersion: input.expectedItemVersion,
                    text: input.content,
                  }
                : {
                    type: "queue_remove",
                    commandId: input.commandId,
                    itemId: input.itemId,
                    expectedItemVersion: input.expectedItemVersion,
                  },
            );
            if (result.status === "ambiguous") {
              const output = {
                version: PROTOCOL_VERSION,
                type: "error" as const,
                generation: input.generation,
                commandId: input.commandId,
                code: "ADMISSION_AMBIGUOUS",
                message: publicErrorMessage(result.message),
                recoverable: false,
              };
              if (!Check(ErrorEnvelopeSchema, output))
                throw new Error("Invalid shared error envelope");
              return send(response, 409, output);
            }
            const output = {
              version: PROTOCOL_VERSION,
              type: "command-response" as const,
              commandId: input.commandId,
              generation: input.generation,
              commandEpoch: input.commandEpoch,
              accepted:
                result.status === "accepted" ||
                result.status === "queued" ||
                result.status === "handled",
              ...(result.status === "rejected"
                ? {
                    error: publicErrorMessage(result.message),
                    reason: queueMutationReason(result.code),
                  }
                : {}),
            };
            if (!Check(CommandResponseEnvelopeSchema, output))
              throw new Error("Invalid shared queue mutation response");
            return send(response, 200, output);
          }
          if (kind === "command") {
            const input = parseSessionCommand(body);
            const result = await options.launches.registry.command(
              launchId,
              input.generation,
              input.commandEpoch,
              {
                type:
                  input.delivery === "immediate"
                    ? "prompt"
                    : input.delivery === "steer"
                      ? "steer"
                      : "follow_up",
                commandId: input.commandId,
                text: input.content,
              },
            );
            if (result.status === "ambiguous") {
              const output = {
                version: PROTOCOL_VERSION,
                type: "error" as const,
                generation: input.generation,
                commandId: input.commandId,
                code: "ADMISSION_AMBIGUOUS",
                message: publicErrorMessage(result.message),
                recoverable: false,
              };
              if (!Check(ErrorEnvelopeSchema, output))
                throw new Error("Invalid shared error envelope");
              return send(response, 409, output);
            }
            const output = {
              version: PROTOCOL_VERSION,
              type: "command-response" as const,
              commandId: input.commandId,
              generation: input.generation,
              commandEpoch: input.commandEpoch,
              accepted:
                result.status === "accepted" ||
                result.status === "queued" ||
                result.status === "handled",
              ...(result.status === "rejected"
                ? { error: publicErrorMessage(result.message) }
                : {}),
            };
            if (!Check(CommandResponseEnvelopeSchema, output))
              throw new Error("Invalid shared command response envelope");
            return send(response, 200, output);
          }
          const input = parseControlCommand(body);
          const result = await options.launches.registry.command(
            launchId,
            input.generation,
            input.commandEpoch,
            input.command,
          );
          if (kind === "set-model" || kind === "set-thinking") {
            if (result.status === "ambiguous") {
              const output = {
                version: PROTOCOL_VERSION,
                type: "error" as const,
                generation: input.generation,
                commandId: input.command.commandId,
                code: "ADMISSION_AMBIGUOUS",
                message: publicErrorMessage(result.message),
                recoverable: false,
              };
              if (!Check(ErrorEnvelopeSchema, output))
                throw new Error("Invalid shared model control error envelope");
              return send(response, 409, output);
            }
            const output = {
              version: PROTOCOL_VERSION,
              type: "command-response" as const,
              commandId: input.command.commandId,
              generation: input.generation,
              commandEpoch: input.commandEpoch,
              accepted: result.status !== "rejected",
              ...(result.status === "rejected"
                ? {
                    error: publicErrorMessage(result.message),
                    reason: modelControlReason(result.code),
                  }
                : {}),
            };
            if (!Check(ModelControlResponseEnvelopeSchema, output))
              throw new Error("Invalid shared model control response");
            return send(response, 200, output);
          }
          return send(response, result.status === "ambiguous" ? 409 : 200, {
            generation: input.generation,
            commandEpoch: input.commandEpoch,
            admission: result,
          });
        }
        if (method !== "GET") return methodNotAllowed(response, "GET");
        return send(response, 200, { launch: options.launches.registry.detail(launchId) });
      }
      if (url.pathname === "/_pi") {
        if (method !== "GET") return methodNotAllowed(response, "GET");
        if (url.search !== "") return send(response, 400, { error: { code: "unexpected_query" } });
        redirectToAppRoot(response);
        return;
      }
      if (
        url.pathname === "/_pi/" ||
        /^\/_pi\/sessions\/[A-Za-z0-9_-]{1,128}\/?$/.test(url.pathname)
      ) {
        if (method !== "GET") return methodNotAllowed(response, "GET");
        if (url.search !== "") return send(response, 400, { error: { code: "unexpected_query" } });
        if (await serveManagedDocument(response)) return;
        return send(response, 404, { error: { code: "not_found" } });
      }
      const asset = url.pathname.match(/^\/_pi\/assets\/([^/]+)$/);
      if (asset) {
        if (method !== "GET") return methodNotAllowed(response, "GET");
        if (url.search !== "") return send(response, 400, { error: { code: "unexpected_query" } });
        if (await serveManagedAsset(asset[1]!, response)) return;
      }
      return send(response, 404, { error: { code: "not_found" } });
    } catch (error) {
      if (error instanceof RangeError && error.message === "Body too large")
        return send(response, 413, { error: { code: "body_too_large" } });
      const failure = publicApiFailure(error);
      return send(response, failure.status, failure.body);
    }
  });
  streamSets.set(server, streams);
  const nativeClose = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    streams.close();
    return nativeClose(callback);
  }) as Server["close"];
  server.once("close", () => streams.close());
  return server;
}

export async function startLocalApi(options: LocalApiOptions): Promise<StartedLocalApi> {
  const server = createLocalApiServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.config.listener.port, options.config.listener.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local API did not bind TCP");
  let closePromise: Promise<void> | undefined;
  return {
    server,
    host: options.config.listener.host,
    port: address.port,
    close: () => {
      streamSets.get(server)?.close();
      closePromise ??= server.listening
        ? new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          )
        : Promise.resolve();
      return closePromise;
    },
  };
}
