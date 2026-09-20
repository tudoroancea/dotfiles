// Standalone browser transport.
//
// This is the extension-owned adapter that satisfies the host-neutral
// `IncrementalSessionTransport` contract. It performs the one-use fragment
// bootstrap, opens the authenticated SSE stream of protocol envelopes, and posts
// command/completion/history requests using relative URLs so an arbitrary
// standalone base path keeps working. Every incoming wire frame is validated
// against the shared schemas at this boundary before it reaches the client.

import {
  isHistoryPageEnvelope,
  isModelControlResponseEnvelope,
  isServerEnvelope,
  LIMITS,
  PROTOCOL_VERSION,
} from "@dotfiles/pi-web-ui-client/wire";
import type {
  CommandResponseEnvelope,
  CompletionQuery,
  CompletionResultEnvelope,
  HistoryPageEnvelope,
  HistoryRequest,
  IncrementalSessionTransport,
  IncrementalTransportHandlers,
  ModelControlCommand,
  ModelControlResponseEnvelope,
  OutboundCommand,
  QueueMutationCommand,
} from "@dotfiles/pi-web-ui-client/wire";

async function parseJson(
  response: Response,
  handlers?: IncrementalTransportHandlers,
): Promise<unknown> {
  const text = await response.text();
  const started = performance.now();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  } finally {
    handlers?.onTiming?.("jsonParse", performance.now() - started);
  }
}

function validate<T>(
  handlers: IncrementalTransportHandlers | undefined,
  predicate: (value: unknown) => value is T,
  value: unknown,
): value is T {
  const started = performance.now();
  try {
    return predicate(value);
  } finally {
    handlers?.onTiming?.("schemaValidation", performance.now() - started);
  }
}

export function createStandaloneTransport(): IncrementalSessionTransport {
  let source: EventSource | undefined;
  let activeHandlers: IncrementalTransportHandlers | undefined;

  // A corrupt state frame must not leave the UI online and stale. Close the stale
  // stream and emit a recoverable error so the controller's recovery epoch reopens
  // the stream and the host re-sends a fresh snapshot.
  function recover(handlers: IncrementalTransportHandlers, code: string, message: string): void {
    source?.close();
    source = undefined;
    handlers.onStatus("offline");
    handlers.onEnvelope({
      version: PROTOCOL_VERSION,
      type: "error",
      code,
      message,
      recoverable: true,
    });
  }

  function forward(handlers: IncrementalTransportHandlers, raw: string): void {
    if (raw.length > LIMITS.maxSnapshotFrameChars) {
      recover(handlers, "STREAM_OVERSIZE", "Dropped an oversized session frame");
      return;
    }
    let value: unknown;
    const parseStarted = performance.now();
    try {
      value = JSON.parse(raw);
    } catch {
      recover(handlers, "STREAM_MALFORMED", "Dropped a malformed session frame");
      return;
    } finally {
      handlers.onTiming?.("jsonParse", performance.now() - parseStarted);
    }
    if (!validate(handlers, isServerEnvelope, value)) {
      recover(handlers, "STREAM_INVALID", "Dropped a schema-invalid session frame");
      return;
    }
    // Admission and completion-query responses arrive over POST. Eventual command
    // settlement is replayable session-stream state and therefore arrives here.
    if (
      value.type === "snapshot" ||
      value.type === "operations" ||
      value.type === "reset" ||
      value.type === "command-completion" ||
      value.type === "error"
    ) {
      handlers.onEnvelope(value);
    }
  }

  return {
    imageUrl(reference) {
      return `image/${encodeURIComponent(reference.id)}`;
    },

    connect(handlers) {
      let cancelled = false;
      activeHandlers = handlers;

      async function start() {
        const match = location.hash.match(/(?:^#|&)code=([^&]+)/);
        if (match) {
          try {
            await fetch("auth", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code: decodeURIComponent(match[1]) }),
            });
          } catch {
            // Cookie may already be set from a previous exchange; try the stream anyway.
          }
          history.replaceState(null, "", location.pathname);
        }
        if (cancelled) return;
        source = new EventSource("events");
        source.onopen = () => handlers.onStatus("online");
        source.onmessage = (event) => forward(handlers, event.data);
        source.onerror = () => handlers.onStatus("offline");
      }

      start();
      return () => {
        cancelled = true;
        source?.close();
        source = undefined;
        if (activeHandlers === handlers) activeHandlers = undefined;
      };
    },

    async getHistory(request: HistoryRequest): Promise<HistoryPageEnvelope> {
      const response = await fetch("history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw new Error("History unavailable");
      const value = await parseJson(response, activeHandlers);
      if (!validate(activeHandlers, isHistoryPageEnvelope, value))
        throw new Error("Malformed history page");
      return value;
    },

    async submit(command: OutboundCommand, signal: AbortSignal): Promise<CommandResponseEnvelope> {
      let response: Response;
      try {
        response = await fetch(command.type === "image-command" ? "input-image" : "input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
          signal,
        });
      } catch {
        // Network failure is ambiguous: the host may still have admitted the
        // command. Throw so the controller keeps the command id for a deduped
        // retry rather than synthesizing a rejection the client would trust.
        throw new Error("Command delivery unconfirmed");
      }
      const value = await parseJson(response, activeHandlers);
      if (validate(activeHandlers, isServerEnvelope, value) && value.type === "command-response")
        return value;
      // Any non-authoritative outcome (unparseable or wrong-typed body, or an error
      // status without a command-response) is equally ambiguous; never fabricate a
      // host rejection from it.
      throw new Error("Command delivery unconfirmed");
    },

    async mutatePendingInput(
      command: QueueMutationCommand,
      signal: AbortSignal,
    ): Promise<CommandResponseEnvelope> {
      let response: Response;
      try {
        response = await fetch("queue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
          signal,
        });
      } catch {
        throw new Error("Queue mutation delivery unconfirmed");
      }
      const value = await parseJson(response, activeHandlers);
      if (validate(activeHandlers, isServerEnvelope, value) && value.type === "command-response")
        return value;
      throw new Error("Queue mutation delivery unconfirmed");
    },

    async submitModelControl(
      command: ModelControlCommand,
      signal: AbortSignal,
    ): Promise<ModelControlResponseEnvelope> {
      let response: Response;
      try {
        response = await fetch("model-control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
          signal,
        });
      } catch {
        throw new Error("Model control delivery unconfirmed");
      }
      const value = await parseJson(response, activeHandlers);
      if (
        validate(activeHandlers, isModelControlResponseEnvelope, value) &&
        value.commandId === command.commandId &&
        value.generation === command.generation &&
        value.commandEpoch === command.commandEpoch
      ) {
        return value;
      }
      throw new Error("Model control delivery unconfirmed");
    },

    async complete(query: CompletionQuery, signal: AbortSignal): Promise<CompletionResultEnvelope> {
      const response = await fetch("complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(query),
        signal,
      });
      if (!response.ok) throw new Error("Completion unavailable");
      const value = await parseJson(response, activeHandlers);
      if (validate(activeHandlers, isServerEnvelope, value) && value.type === "completion-response")
        return value;
      throw new Error("Malformed completion response");
    },

    close() {
      source?.close();
      source = undefined;
      activeHandlers = undefined;
    },
  };
}
