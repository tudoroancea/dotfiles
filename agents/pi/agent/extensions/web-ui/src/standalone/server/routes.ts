import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Check } from "typebox/value";
import {
  CompletionQuerySchema,
  HistoryRequestSchema,
  ImageAttachmentCommandSchema,
  inspectRasterImage,
  ModelControlCommandSchema,
  ModelControlRejectionReasonSchema,
  ModelControlResponseEnvelopeSchema,
  isImageAttachmentCommandPreflightValid,
  decodeCompletionResponse,
  SessionCommandSchema,
  QueueMutationCommandSchema,
  type CommandAcceptance,
  type CommandResponseEnvelope,
  type ImageAttachmentCapability,
  type ImageAttachmentCommand,
  type ImageOmissionReason,
  type ModelControlCommand,
  type ModelControlRejectionReason,
  type ModelControlResponseEnvelope,
  type OutboundCommand,
  type QueueMutationCommand,
} from "@dotfiles/pi-web-ui-client/wire";
import {
  applySecurityHeaders,
  MAX_COMPLETION_QUERY_BYTES,
  MAX_CONCURRENT_IMAGE_COMMAND_BODIES,
  IMAGE_COMMAND_BODY_TIMEOUT_MS,
  MAX_IMAGE_COMMAND_BODY_BYTES,
  MAX_INPUT_BYTES,
  MAX_RETAINED_IMAGE_ADMISSION_BYTES,
} from "../config.js";
import { readBody, SessionAuthentication } from "./auth.js";
import { sendJson } from "./http.js";
import { OperationJournal } from "./journal.js";
import { JournalSse } from "./sse.js";
import { serveStatic } from "./static.js";
import type { StartServerOptions } from "./types.js";

const MAX_SETTLED_COMMAND_IDS = 4096;
const MAX_IN_FLIGHT_COMMAND_IDS = 128;
const COMMAND_ADMISSION_DEADLINE_MS = 30_000;

interface CachedCommand {
  fingerprint: string;
  status: number;
  response: CommandResponseEnvelope;
}

export interface RouteHandlerDependencies {
  basePath: string;
  authentication: SessionAuthentication;
  journal: OperationJournal;
  options: StartServerOptions;
  sse: JournalSse;
}

export interface RouteHandler {
  (request: IncomingMessage, response: ServerResponse): Promise<void>;
  close(): Promise<void>;
}

interface InFlightCommand {
  fingerprint: string;
  controller: AbortController;
  result: Promise<CachedCommand>;
  handedOff?: boolean;
}

export function createRouteHandler({
  basePath,
  authentication,
  journal,
  options,
  sse,
}: RouteHandlerDependencies): RouteHandler {
  const commandCache = new Map<string, CachedCommand>();
  const inFlightCommands = new Map<string, InFlightCommand>();
  const admissionTasks = new Map<
    Promise<CommandAcceptance>,
    { imageBytes: number; released: boolean }
  >();
  let cacheEpoch = journal.commandEpoch;
  let activeImageBodies = 0;
  let activeImageAdmissions = 0;
  let retainedImageAdmissionBytes = 0;
  let modelControlLane = Promise.resolve();

  const runInModelControlLane = async <T>(
    task: () => Promise<T>,
    controller: AbortController,
    deadlineMs: number,
    isHandedOff: () => boolean,
  ): Promise<
    { completed: true; value: T } | { completed: false; reason: "queue-busy" | "session-changed" }
  > => {
    const predecessor = modelControlLane;
    let release!: () => void;
    modelControlLane = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = predecessor
      .then(async () => {
        if (controller.signal.aborted)
          return { completed: false as const, reason: "session-changed" as const };
        return { completed: true as const, value: await task() };
      })
      .finally(release);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const cancelled = new Promise<{
      completed: false;
      reason: "queue-busy" | "session-changed";
    }>((resolve) => {
      deadline = setTimeout(() => {
        if (isHandedOff()) return;
        resolve({ completed: false, reason: "queue-busy" });
        controller.abort();
      }, deadlineMs);
      deadline.unref?.();
      abort = () => {
        if (!isHandedOff()) resolve({ completed: false, reason: "session-changed" });
      };
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([queued, cancelled]);
    } finally {
      if (deadline) clearTimeout(deadline);
      if (abort) controller.signal.removeEventListener("abort", abort);
    }
  };

  const rotate = () => {
    for (const command of inFlightCommands.values()) {
      if (!command.handedOff) command.controller.abort();
    }
    inFlightCommands.clear();
    commandCache.clear();
    cacheEpoch = journal.commandEpoch;
  };
  const releaseAdmission = (
    task: Promise<CommandAcceptance>,
    reservation: { imageBytes: number; released: boolean },
  ) => {
    if (reservation.released) return;
    reservation.released = true;
    admissionTasks.delete(task);
    if (reservation.imageBytes > 0) {
      activeImageAdmissions = Math.max(0, activeImageAdmissions - 1);
      retainedImageAdmissionBytes = Math.max(
        0,
        retainedImageAdmissionBytes - reservation.imageBytes,
      );
    }
  };
  const unsubscribe = journal.subscribe((envelope, reason) => {
    if (envelope.type === "reset" && envelope.snapshot.commandEpoch !== cacheEpoch) {
      options.onCommandEpochReset?.(`Journal reset: ${reason}`);
      rotate();
    }
  });

  const handle: RouteHandler = async (request, response) => {
    applySecurityHeaders(response);
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname;
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
      if (!authentication.exchange(code, response)) {
        sendJson(response, 401, { error: "Invalid or expired code" });
        return;
      }
      sendJson(response, 204, undefined);
      return;
    }

    if (request.method === "POST" && (route === "input" || route === "input-image")) {
      if (!authorizeMutation(request, response, authentication)) return;
      const imageRoute = route === "input-image";
      if (imageRoute && activeImageBodies >= MAX_CONCURRENT_IMAGE_COMMAND_BODIES) {
        sendJson(response, 503, { error: "Image command reader is busy" });
        return;
      }
      let value: unknown;
      let rawBody: string;
      if (imageRoute) activeImageBodies += 1;
      try {
        rawBody = await readBody(
          request,
          imageRoute ? MAX_IMAGE_COMMAND_BODY_BYTES : undefined,
          imageRoute ? IMAGE_COMMAND_BODY_TIMEOUT_MS : undefined,
        );
        value = JSON.parse(rawBody);
      } catch {
        if (!response.destroyed) sendJson(response, 400, { error: "Invalid request" });
        return;
      } finally {
        if (imageRoute) activeImageBodies -= 1;
      }
      if (
        (!imageRoute &&
          (!Check(SessionCommandSchema, value) ||
            !value.content.trim() ||
            Buffer.byteLength(value.content) > MAX_INPUT_BYTES)) ||
        (imageRoute &&
          (!Check(ImageAttachmentCommandSchema, value) ||
            Buffer.byteLength(value.content) > MAX_INPUT_BYTES))
      ) {
        sendJson(response, 400, { error: "Invalid command" });
        return;
      }
      const command = value as OutboundCommand;
      if (cacheEpoch !== journal.commandEpoch) rotate();
      if (
        command.generation !== journal.generation ||
        command.commandEpoch !== journal.commandEpoch
      ) {
        sendJson(
          response,
          409,
          commandResponse(
            command.commandId,
            command.generation,
            command.commandEpoch,
            false,
            "Session command epoch is stale",
          ),
        );
        return;
      }

      const cacheKey = `${command.commandEpoch}\0${command.commandId}`;
      const fingerprint = createHash("sha256").update(rawBody).digest("base64url");
      const cached = commandCache.get(cacheKey);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          sendJson(
            response,
            409,
            commandResponse(
              command.commandId,
              command.generation,
              command.commandEpoch,
              false,
              "Command ID was reused with different content",
            ),
          );
        } else {
          sendJson(response, cached.status, cached.response);
        }
        return;
      }

      const inFlight = inFlightCommands.get(cacheKey);
      if (inFlight) {
        if (inFlight.fingerprint !== fingerprint) {
          sendJson(
            response,
            409,
            commandResponse(
              command.commandId,
              command.generation,
              command.commandEpoch,
              false,
              "Command ID was reused with different content",
            ),
          );
        } else {
          const completed = await inFlight.result;
          sendJson(response, completed.status, completed.response);
        }
        return;
      }

      if (imageRoute) {
        const rejection = validateImageCommand(
          command as ImageAttachmentCommand,
          journal.imageAttachmentCapability,
        );
        if (rejection) {
          sendJson(
            response,
            409,
            commandResponse(
              command.commandId,
              command.generation,
              command.commandEpoch,
              false,
              `Image attachment rejected: ${rejection}`,
            ),
          );
          return;
        }
      }

      const imageBodyBytes = imageRoute ? Buffer.byteLength(rawBody) : 0;
      if (
        (imageRoute &&
          (activeImageAdmissions >= MAX_CONCURRENT_IMAGE_COMMAND_BODIES ||
            retainedImageAdmissionBytes + imageBodyBytes > MAX_RETAINED_IMAGE_ADMISSION_BYTES)) ||
        inFlightCommands.size >= MAX_IN_FLIGHT_COMMAND_IDS ||
        admissionTasks.size >= MAX_IN_FLIGHT_COMMAND_IDS
      ) {
        sendJson(
          response,
          503,
          commandResponse(
            command.commandId,
            command.generation,
            command.commandEpoch,
            false,
            "Command replay window is busy; retry shortly",
          ),
        );
        return;
      }

      if (commandCache.size >= MAX_SETTLED_COMMAND_IDS) {
        if (inFlightCommands.size === 0) {
          const previousEpoch = journal.commandEpoch;
          options.onCommandEpochReset?.("Command replay window rotated");
          journal.forceReset("command replay window rotated");
          if (journal.commandEpoch !== previousEpoch) {
            sendJson(
              response,
              409,
              commandResponse(
                command.commandId,
                command.generation,
                command.commandEpoch,
                false,
                "Session command epoch changed; retry after the session refreshes",
              ),
            );
            return;
          }
        }
        sendJson(
          response,
          503,
          commandResponse(
            command.commandId,
            command.generation,
            command.commandEpoch,
            false,
            "Command replay window is busy; retry shortly",
          ),
        );
        return;
      }

      const controller = new AbortController();
      const execution = executeCommand(
        command,
        fingerprint,
        journal,
        options,
        controller,
        COMMAND_ADMISSION_DEADLINE_MS,
        (task) => {
          const reservation = { imageBytes: imageBodyBytes, released: false };
          admissionTasks.set(task, reservation);
          if (imageBodyBytes > 0) {
            activeImageAdmissions += 1;
            retainedImageAdmissionBytes += imageBodyBytes;
          }
          void task.finally(() => releaseAdmission(task, reservation)).catch(() => undefined);
        },
      );
      inFlightCommands.set(cacheKey, { fingerprint, controller, result: execution });
      const completed = await execution.finally(() => {
        inFlightCommands.delete(cacheKey);
      });
      if (command.commandEpoch === journal.commandEpoch) commandCache.set(cacheKey, completed);
      sendJson(response, completed.status, completed.response);
      return;
    }

    if (request.method === "POST" && route === "queue") {
      if (!authorizeMutation(request, response, authentication)) return;
      let value: unknown;
      let rawBody: string;
      try {
        rawBody = await readBody(request);
        value = JSON.parse(rawBody);
      } catch {
        if (!response.destroyed) sendJson(response, 400, { error: "Invalid request" });
        return;
      }
      if (
        !Check(QueueMutationCommandSchema, value) ||
        Buffer.byteLength(rawBody) > MAX_INPUT_BYTES + 4 * 1024
      ) {
        sendJson(response, 400, { error: "Invalid queue mutation" });
        return;
      }
      const command = value as QueueMutationCommand;
      if (cacheEpoch !== journal.commandEpoch) rotate();
      if (
        command.generation !== journal.generation ||
        command.commandEpoch !== journal.commandEpoch
      ) {
        sendJson(
          response,
          409,
          commandResponse(
            command.commandId,
            command.generation,
            command.commandEpoch,
            false,
            "Session command epoch is stale",
            "session-changed",
          ),
        );
        return;
      }
      const cacheKey = `${command.commandEpoch}\0${command.commandId}`;
      const fingerprint = createHash("sha256").update(rawBody).digest("base64url");
      const cached = commandCache.get(cacheKey);
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          sendJson(
            response,
            409,
            commandResponse(
              command.commandId,
              command.generation,
              command.commandEpoch,
              false,
              "Command ID was reused with different content",
              "invalid",
            ),
          );
        } else {
          sendJson(response, cached.status, cached.response);
        }
        return;
      }
      const inFlight = inFlightCommands.get(cacheKey);
      if (inFlight) {
        if (inFlight.fingerprint !== fingerprint) {
          sendJson(
            response,
            409,
            commandResponse(
              command.commandId,
              command.generation,
              command.commandEpoch,
              false,
              "Command ID was reused with different content",
              "invalid",
            ),
          );
        } else {
          const completed = await inFlight.result;
          sendJson(response, completed.status, completed.response);
        }
        return;
      }
      if (
        inFlightCommands.size >= MAX_IN_FLIGHT_COMMAND_IDS ||
        admissionTasks.size >= MAX_IN_FLIGHT_COMMAND_IDS
      ) {
        sendJson(
          response,
          503,
          commandResponse(
            command.commandId,
            command.generation,
            command.commandEpoch,
            false,
            "Command replay window is busy; retry shortly",
            "queue-busy",
          ),
        );
        return;
      }
      if (commandCache.size >= MAX_SETTLED_COMMAND_IDS && inFlightCommands.size === 0) {
        const previousEpoch = journal.commandEpoch;
        options.onCommandEpochReset?.("Command replay window rotated");
        journal.forceReset("command replay window rotated");
        if (journal.commandEpoch !== previousEpoch) {
          sendJson(
            response,
            409,
            commandResponse(
              command.commandId,
              command.generation,
              command.commandEpoch,
              false,
              "Session command epoch changed; refresh the session",
              "session-changed",
            ),
          );
          return;
        }
        if (commandCache.size >= MAX_SETTLED_COMMAND_IDS) {
          sendJson(
            response,
            503,
            commandResponse(
              command.commandId,
              command.generation,
              command.commandEpoch,
              false,
              "Command replay window is busy; retry shortly",
              "queue-busy",
            ),
          );
          return;
        }
      }
      const controller = new AbortController();
      const execution = executeQueueMutation(
        command,
        fingerprint,
        journal,
        options,
        controller,
        COMMAND_ADMISSION_DEADLINE_MS,
        (task) => {
          const reservation = { imageBytes: 0, released: false };
          admissionTasks.set(task, reservation);
          void task.finally(() => releaseAdmission(task, reservation)).catch(() => undefined);
        },
      );
      inFlightCommands.set(cacheKey, { fingerprint, controller, result: execution });
      const completed = await execution.finally(() => {
        inFlightCommands.delete(cacheKey);
      });
      if (command.commandEpoch === journal.commandEpoch) commandCache.set(cacheKey, completed);
      sendJson(response, completed.status, completed.response);
      return;
    }

    if (request.method === "POST" && route === "model-control") {
      if (!authorizeMutation(request, response, authentication)) return;
      let value: unknown;
      let rawBody: string;
      try {
        rawBody = await readBody(request, 8 * 1024);
        value = JSON.parse(rawBody);
      } catch {
        if (!response.destroyed) sendJson(response, 400, { error: "Invalid request" });
        return;
      }
      if (!Check(ModelControlCommandSchema, value)) {
        sendJson(response, 400, { error: "Invalid model control command" });
        return;
      }
      const command = value as ModelControlCommand;
      if (cacheEpoch !== journal.commandEpoch) rotate();
      if (
        command.generation !== journal.generation ||
        command.commandEpoch !== journal.commandEpoch
      ) {
        sendJson(
          response,
          409,
          commandResponse(
            command.commandId,
            command.generation,
            command.commandEpoch,
            false,
            "Session command epoch is stale",
            "session-changed",
          ),
        );
        return;
      }
      const cacheKey = `${command.commandEpoch}\0${command.commandId}`;
      const fingerprint = createHash("sha256").update(rawBody).digest("base64url");
      const cached = commandCache.get(cacheKey);
      if (cached) {
        sendJson(
          response,
          cached.fingerprint === fingerprint ? cached.status : 409,
          cached.fingerprint === fingerprint
            ? cached.response
            : commandResponse(
                command.commandId,
                command.generation,
                command.commandEpoch,
                false,
                "Command ID was reused with different content",
                "invalid",
              ),
        );
        return;
      }
      const inFlight = inFlightCommands.get(cacheKey);
      if (inFlight) {
        if (inFlight.fingerprint !== fingerprint) {
          sendJson(
            response,
            409,
            commandResponse(
              command.commandId,
              command.generation,
              command.commandEpoch,
              false,
              "Command ID was reused with different content",
              "invalid",
            ),
          );
        } else {
          const completed = await inFlight.result;
          sendJson(response, completed.status, completed.response);
        }
        return;
      }
      if (!journal.modelControlCapability || !options.modelControl) {
        sendJson(
          response,
          409,
          commandResponse(
            command.commandId,
            command.generation,
            command.commandEpoch,
            false,
            "Model control is unavailable",
            "capability-off",
          ),
        );
        return;
      }
      if (
        inFlightCommands.size >= MAX_IN_FLIGHT_COMMAND_IDS ||
        admissionTasks.size >= MAX_IN_FLIGHT_COMMAND_IDS
      ) {
        sendJson(
          response,
          503,
          commandResponse(
            command.commandId,
            command.generation,
            command.commandEpoch,
            false,
            "Command replay window is busy; retry shortly",
            "queue-busy",
          ),
        );
        return;
      }
      if (commandCache.size >= MAX_SETTLED_COMMAND_IDS) {
        const previousEpoch = journal.commandEpoch;
        options.onCommandEpochReset?.("Command replay window rotated");
        journal.forceReset("command replay window rotated");
        sendJson(
          response,
          journal.commandEpoch !== previousEpoch ? 409 : 503,
          commandResponse(
            command.commandId,
            command.generation,
            command.commandEpoch,
            false,
            journal.commandEpoch !== previousEpoch
              ? "Session command epoch changed; refresh the session"
              : "Command replay window is busy; retry shortly",
            journal.commandEpoch !== previousEpoch ? "session-changed" : "queue-busy",
          ),
        );
        return;
      }
      const controller = new AbortController();
      const deadlineAt = Date.now() + COMMAND_ADMISSION_DEADLINE_MS;
      let modelControlState!: InFlightCommand;
      const isHandedOff = () => modelControlState.handedOff === true;
      const failed = (reason: "queue-busy" | "session-changed"): CachedCommand => {
        const changed = reason === "session-changed";
        return {
          fingerprint,
          status: changed ? 409 : 503,
          response: modelControlResponse(
            command,
            false,
            changed
              ? "Session command epoch changed"
              : "Command admission timed out; retry shortly",
            reason,
          ),
        };
      };
      const execution = runInModelControlLane(
        () => {
          const remaining = deadlineAt - Date.now();
          if (remaining <= 0) {
            controller.abort();
            return Promise.resolve(failed("queue-busy"));
          }
          return executeModelControl(
            command,
            fingerprint,
            journal,
            options,
            controller,
            remaining,
            () => {
              if (
                modelControlState.handedOff ||
                controller.signal.aborted ||
                Date.now() >= deadlineAt ||
                command.generation !== journal.generation ||
                command.commandEpoch !== journal.commandEpoch
              ) {
                return false;
              }
              modelControlState.handedOff = true;
              return true;
            },
            isHandedOff,
            (task) => {
              const reservation = { imageBytes: 0, released: false };
              admissionTasks.set(task, reservation);
              void task.finally(() => releaseAdmission(task, reservation)).catch(() => undefined);
            },
          );
        },
        controller,
        COMMAND_ADMISSION_DEADLINE_MS,
        isHandedOff,
      ).then((result): CachedCommand => (result.completed ? result.value : failed(result.reason)));
      modelControlState = { fingerprint, controller, result: execution, handedOff: false };
      inFlightCommands.set(cacheKey, modelControlState);
      const completed = await execution.finally(() => inFlightCommands.delete(cacheKey));
      if (command.commandEpoch === journal.commandEpoch) commandCache.set(cacheKey, completed);
      if (!response.destroyed) sendJson(response, completed.status, completed.response);
      return;
    }

    if (request.method === "POST" && route === "complete") {
      if (!authorizeMutation(request, response, authentication)) return;
      let value: unknown;
      try {
        value = JSON.parse(await readBody(request));
      } catch {
        sendJson(response, 400, { error: "Invalid request" });
        return;
      }
      if (
        !Check(CompletionQuerySchema, value) ||
        Buffer.byteLength(value.query) > MAX_COMPLETION_QUERY_BYTES
      ) {
        sendJson(response, 400, { error: "Invalid completion query" });
        return;
      }
      if (value.generation !== journal.generation) {
        sendJson(response, 409, { error: "Session generation is stale" });
        return;
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      const close = () => {
        if (!response.writableEnded) abort();
      };
      request.once("aborted", abort);
      response.once("close", close);
      const items = options.completeMention
        ? await options.completeMention(value.query, controller.signal)
        : [];
      request.off("aborted", abort);
      response.off("close", close);
      if (!controller.signal.aborted && !response.destroyed) {
        const normalized = decodeCompletionResponse({ items });
        sendJson(response, 200, {
          version: 1,
          type: "completion-response",
          generation: journal.generation,
          items: normalized?.items ?? [],
        });
      }
      return;
    }

    if (request.method === "GET" && route.startsWith("image/")) {
      if (!authentication.authenticated(request)) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      const fetchSite = request.headers["sec-fetch-site"];
      if (
        (request.headers.origin && !authentication.sameOrigin(request)) ||
        (fetchSite !== undefined && fetchSite !== "same-origin")
      ) {
        sendJson(response, 403, { error: "Cross-origin requests are not allowed" });
        return;
      }
      const encodedId = route.slice("image/".length);
      let id: string;
      try {
        id = decodeURIComponent(encodedId);
      } catch {
        sendJson(response, 404, { error: "Unknown image reference" });
        return;
      }
      if (!id || id.includes("/") || encodedId.includes("/")) {
        sendJson(response, 404, { error: "Unknown image reference" });
        return;
      }
      const lookup = journal.images.acquire(id);
      if (lookup.status !== "found") {
        const status = lookup.status === "evicted" ? 410 : lookup.status === "busy" ? 503 : 404;
        const error =
          lookup.status === "evicted"
            ? "Image was evicted"
            : lookup.status === "busy"
              ? "Image resolver is busy"
              : "Unknown or stale image reference";
        sendJson(response, status, { error });
        return;
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        journal.images.releaseResponse();
      };
      response.once("finish", release);
      response.once("close", release);
      response.statusCode = 200;
      response.setHeader("Content-Type", lookup.image.reference.mimeType);
      response.setHeader("Content-Length", String(lookup.image.content.length));
      response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      response.end(lookup.image.content);
      return;
    }

    if ((request.method === "GET" || request.method === "POST") && route === "history") {
      if (!authentication.authenticated(request)) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (
        (request.method === "POST" || request.headers.origin) &&
        !authentication.sameOrigin(request)
      ) {
        sendJson(response, 403, { error: "Cross-origin requests are not allowed" });
        return;
      }
      let value: unknown;
      try {
        value =
          request.method === "POST" ? JSON.parse(await readBody(request)) : historyFromQuery(url);
      } catch {
        sendJson(response, 400, { error: "Invalid history request" });
        return;
      }
      if (!Check(HistoryRequestSchema, value)) {
        sendJson(response, 400, { error: "Invalid history request" });
        return;
      }
      try {
        sendJson(response, 200, journal.historyPage(value));
      } catch (error) {
        sendJson(response, 409, {
          version: 1,
          type: "error",
          generation: journal.generation,
          code: "STALE_HISTORY",
          message: error instanceof Error ? error.message : "History request failed",
          recoverable: true,
        });
      }
      return;
    }

    if (request.method === "GET" && route === "events") {
      if (!authentication.authenticated(request)) {
        sendJson(response, 401, { error: "Authentication required" });
        return;
      }
      if (request.headers.origin && !authentication.sameOrigin(request)) {
        sendJson(response, 403, { error: "Cross-origin requests are not allowed" });
        return;
      }
      if (
        !request.headers.accept?.split(",").some((value) => value.trim() === "text/event-stream")
      ) {
        sendJson(response, 406, { error: "Event stream required" });
        return;
      }
      sse.add(response);
      return;
    }

    if (request.method === "GET") {
      await serveStatic(route, response);
      return;
    }

    sendJson(response, 405, { error: "Method not allowed" });
  };
  handle.close = async () => {
    unsubscribe();
    rotate();
    const tasks = [...admissionTasks.keys()];
    if (tasks.length > 0) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(tasks),
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, 1_000);
          deadline.unref?.();
        }),
      ]);
      if (deadline) clearTimeout(deadline);
    }
    for (const [task, reservation] of admissionTasks) releaseAdmission(task, reservation);
  };
  return handle;
}

async function executeCommand(
  command: OutboundCommand,
  fingerprint: string,
  journal: OperationJournal,
  options: StartServerOptions,
  controller: AbortController,
  deadlineMs: number,
  trackAdmission: (task: Promise<CommandAcceptance>) => void,
): Promise<CachedCommand> {
  let status: number;
  let response: CommandResponseEnvelope;
  if (command.generation !== journal.generation || command.commandEpoch !== journal.commandEpoch) {
    status = 409;
    response = commandResponse(
      command.commandId,
      command.generation,
      command.commandEpoch,
      false,
      "Session command epoch is stale",
    );
  } else if (!options.submitInput) {
    status = 503;
    response = commandResponse(
      command.commandId,
      command.generation,
      command.commandEpoch,
      false,
      "Input is unavailable",
    );
  } else {
    try {
      const admission = options.submitInput(command, controller.signal);
      trackAdmission(admission);
      const acceptance = await withAdmissionDeadline(admission, controller, deadlineMs);
      status = acceptance.accepted ? 202 : 409;
      response = commandResponse(
        command.commandId,
        command.generation,
        command.commandEpoch,
        acceptance.accepted,
        acceptance.accepted ? undefined : acceptance.error,
        acceptance.accepted ? undefined : acceptance.reason,
      );
    } catch (error) {
      status = 500;
      response = commandResponse(
        command.commandId,
        command.generation,
        command.commandEpoch,
        false,
        command.type === "image-command"
          ? "Image message failed"
          : error instanceof Error
            ? error.message.slice(0, 4096)
            : "Message failed",
      );
    }
  }
  return { fingerprint, status, response };
}

async function executeQueueMutation(
  command: QueueMutationCommand,
  fingerprint: string,
  journal: OperationJournal,
  options: StartServerOptions,
  controller: AbortController,
  deadlineMs: number,
  trackAdmission: (task: Promise<CommandAcceptance>) => void,
): Promise<CachedCommand> {
  let status: number;
  let response: CommandResponseEnvelope;
  if (command.generation !== journal.generation || command.commandEpoch !== journal.commandEpoch) {
    status = 409;
    response = commandResponse(
      command.commandId,
      command.generation,
      command.commandEpoch,
      false,
      "Session command epoch is stale",
      "session-changed",
    );
  } else if (!options.mutatePendingInput) {
    status = 503;
    response = commandResponse(
      command.commandId,
      command.generation,
      command.commandEpoch,
      false,
      "Pending input editing is unavailable",
      "capability-off",
    );
  } else {
    try {
      const admission = options.mutatePendingInput(command, controller.signal);
      trackAdmission(admission);
      const acceptance = await withAdmissionDeadline(admission, controller, deadlineMs);
      status = acceptance.accepted ? 202 : 409;
      response = commandResponse(
        command.commandId,
        command.generation,
        command.commandEpoch,
        acceptance.accepted,
        acceptance.accepted ? undefined : acceptance.error,
        acceptance.accepted ? undefined : acceptance.reason,
      );
    } catch (error) {
      status = 500;
      response = commandResponse(
        command.commandId,
        command.generation,
        command.commandEpoch,
        false,
        error instanceof Error ? error.message.slice(0, 4096) : "Queue mutation failed",
        "invalid",
      );
    }
  }
  return { fingerprint, status, response };
}

async function executeModelControl(
  command: ModelControlCommand,
  fingerprint: string,
  journal: OperationJournal,
  options: StartServerOptions,
  controller: AbortController,
  deadlineMs: number,
  tryHandoff: () => boolean,
  isHandedOff: () => boolean,
  trackAdmission: (task: Promise<CommandAcceptance>) => void,
): Promise<CachedCommand> {
  if (
    controller.signal.aborted ||
    command.generation !== journal.generation ||
    command.commandEpoch !== journal.commandEpoch
  ) {
    return {
      fingerprint,
      status: 409,
      response: modelControlResponse(
        command,
        false,
        "Session command epoch is stale",
        "session-changed",
      ),
    };
  }
  if (!options.modelControl || !journal.modelControlCapability) {
    return {
      fingerprint,
      status: 409,
      response: modelControlResponse(
        command,
        false,
        "Model control is unavailable",
        "capability-off",
      ),
    };
  }
  try {
    const admission = options.modelControl(command, controller.signal, tryHandoff);
    trackAdmission(admission);
    const acceptance = await withModelControlDeadline(
      admission,
      controller,
      deadlineMs,
      isHandedOff,
    );
    return {
      fingerprint,
      status: acceptance.accepted ? 202 : 409,
      response: modelControlResponse(
        command,
        acceptance.accepted,
        acceptance.accepted ? undefined : acceptance.error,
        acceptance.accepted ? undefined : acceptance.reason,
      ),
    };
  } catch (error) {
    if (isHandedOff()) throw error;
    return {
      fingerprint,
      status: 500,
      response: modelControlResponse(
        command,
        false,
        error instanceof Error ? error.message.slice(0, 4096) : "Model control failed",
        "invalid",
      ),
    };
  }
}

function validateImageCommand(
  command: ImageAttachmentCommand,
  capability: ImageAttachmentCapability | undefined,
): ImageOmissionReason | "unsupported" | "declared-dimensions-mismatch" | undefined {
  if (!isImageAttachmentCommandPreflightValid(command, capability)) return "unsupported";
  let totalBytes = 0;
  let totalPixels = 0;
  for (const attachment of command.attachments) {
    const content = Buffer.from(attachment.data, "base64");
    if (content.length !== attachment.byteLength) return "invalid-data";
    const inspected = inspectRasterImage(content, attachment.mimeType);
    if (typeof inspected === "string") return inspected;
    if (inspected.width !== attachment.width || inspected.height !== attachment.height)
      return "declared-dimensions-mismatch";
    totalBytes += content.length;
    totalPixels += inspected.width * inspected.height;
    if (!capability || totalBytes > capability.maxTotalBytes) return "aggregate-bytes-exceeded";
    if (totalPixels > capability.maxTotalPixels) return "pixels-exceeded";
  }
  return undefined;
}

async function withModelControlDeadline(
  admission: Promise<CommandAcceptance>,
  controller: AbortController,
  deadlineMs: number,
  isHandedOff: () => boolean,
): Promise<CommandAcceptance> {
  if (controller.signal.aborted && !isHandedOff()) {
    return { accepted: false, error: "Session command epoch changed", reason: "session-changed" };
  }
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<CommandAcceptance>((resolve) => {
    deadline = setTimeout(() => {
      if (isHandedOff()) return;
      controller.abort();
      resolve({
        accepted: false,
        error: "Command admission timed out; retry shortly",
        reason: "queue-busy",
      });
    }, deadlineMs);
    deadline.unref?.();
    abort = () => {
      if (!isHandedOff()) {
        resolve({
          accepted: false,
          error: "Session command epoch changed",
          reason: "session-changed",
        });
      }
    };
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([admission, cancelled]);
  } finally {
    if (deadline) clearTimeout(deadline);
    if (abort) controller.signal.removeEventListener("abort", abort);
  }
}

async function withAdmissionDeadline(
  admission: Promise<CommandAcceptance>,
  controller: AbortController,
  deadlineMs: number,
): Promise<CommandAcceptance> {
  if (controller.signal.aborted) {
    return { accepted: false, error: "Session command epoch changed" };
  }
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const timeout = new Promise<CommandAcceptance>((resolve) => {
    deadline = setTimeout(() => {
      controller.abort();
      resolve({ accepted: false, error: "Command admission timed out; retry shortly" });
    }, deadlineMs);
    deadline.unref?.();
    abort = () => resolve({ accepted: false, error: "Session command epoch changed" });
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([admission, timeout]);
  } finally {
    if (deadline) clearTimeout(deadline);
    if (abort) controller.signal.removeEventListener("abort", abort);
  }
}

function historyFromQuery(url: URL): unknown {
  return {
    version: Number(url.searchParams.get("version")),
    type: "history-request",
    generation: url.searchParams.get("generation") ?? "",
    revision: Number(url.searchParams.get("revision")),
    historyGeneration: url.searchParams.get("historyGeneration") ?? "",
    beforeCursor: url.searchParams.get("beforeCursor") ?? "",
    beforeId: url.searchParams.get("beforeId") ?? "",
    limit: Number(url.searchParams.get("limit")),
  };
}

function modelControlResponse(
  command: ModelControlCommand,
  accepted: boolean,
  error?: unknown,
  reason?: unknown,
): ModelControlResponseEnvelope {
  const base = {
    version: 1 as const,
    type: "command-response" as const,
    commandId: command.commandId,
    generation: command.generation,
    commandEpoch: command.commandEpoch,
  };
  const response: ModelControlResponseEnvelope = accepted
    ? { ...base, accepted: true }
    : {
        ...base,
        accepted: false,
        error: (typeof error === "string" && error ? error : "Model control rejected").slice(
          0,
          4096,
        ),
        reason: Check(ModelControlRejectionReasonSchema, reason)
          ? (reason as ModelControlRejectionReason)
          : "invalid",
      };
  if (!Check(ModelControlResponseEnvelopeSchema, response)) {
    throw new Error("Invalid model control response");
  }
  return response;
}

function commandResponse(
  commandId: string,
  generation: string,
  commandEpoch: string,
  accepted: boolean,
  error?: string,
  reason?: CommandAcceptance["reason"],
): CommandResponseEnvelope {
  return accepted
    ? {
        version: 1,
        type: "command-response",
        commandId,
        generation,
        commandEpoch,
        accepted: true,
      }
    : {
        version: 1,
        type: "command-response",
        commandId,
        generation,
        commandEpoch,
        accepted: false,
        error: (error || "Message rejected").slice(0, 4096),
        ...(reason ? { reason } : {}),
      };
}

function authorizeMutation(
  request: IncomingMessage,
  response: ServerResponse,
  authentication: SessionAuthentication,
): boolean {
  if (!authentication.authenticated(request)) {
    sendJson(response, 401, { error: "Authentication required" });
    return false;
  }
  if (!authentication.sameOrigin(request)) {
    sendJson(response, 403, { error: "Cross-origin requests are not allowed" });
    return false;
  }
  return true;
}
