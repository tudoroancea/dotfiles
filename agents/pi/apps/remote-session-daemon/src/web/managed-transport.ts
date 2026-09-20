// Managed browser transport for the daemon-served SPA.
//
// This is the daemon-owned adapter that satisfies the host-neutral
// `IncrementalSessionTransport` contract for one managed launch. It mirrors the
// standalone transport's frame validation, oversize recovery, timing hooks, and
// ambiguous-submit semantics, but targets the daemon's absolute per-session SSE
// and command endpoints so it works regardless of which shell route is mounted.
//
// This first Phase 4C slice serves only the recent/live transcript and command
// admission. Bounded history paging, `@` completion, and image resolution are
// owned by later phases, so `getHistory` and `complete` reject immediately
// without a fetch and `imageUrl` returns an empty string rather than pointing at
// an endpoint that does not exist yet.

import {
  isModelControlResponseEnvelope,
  isServerEnvelope,
  LIMITS,
  PROTOCOL_VERSION,
} from "@dotfiles/pi-web-ui-client/wire";
import type {
  IncrementalSessionTransport,
  IncrementalTransportHandlers,
  ModelControlCommand,
  QueueMutationCommand,
} from "@dotfiles/pi-web-ui-client/wire";

const SESSIONS_BASE = "/_pi/api/v1/sessions";

function sessionEndpoint(launchId: string, suffix: string): string {
  return `${SESSIONS_BASE}/${encodeURIComponent(launchId)}${suffix}`;
}

async function parseJson(
  response: Response,
  handlers: IncrementalTransportHandlers | undefined,
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

/** Build a transport bound to one managed launch's absolute daemon endpoints. */
export function createManagedSessionTransport(launchId: string): IncrementalSessionTransport {
  const detailUrl = sessionEndpoint(launchId, "");
  const eventsUrl = sessionEndpoint(launchId, "/events");
  const commandUrl = sessionEndpoint(launchId, "/command");
  let source: EventSource | undefined;
  let activeHandlers: IncrementalTransportHandlers | undefined;
  let checkingLifecycle = false;

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

  async function revealLifecycleChange(handlers: IncrementalTransportHandlers): Promise<void> {
    if (checkingLifecycle) return;
    checkingLifecycle = true;
    try {
      const response = await fetch(detailUrl, { headers: { accept: "application/json" } });
      if (!response.ok || activeHandlers !== handlers) return;
      const value = (await response.json()) as {
        launch?: { lifecycle?: unknown; ready?: unknown };
      };
      if (
        value.launch &&
        value.launch.ready === false &&
        typeof value.launch.lifecycle === "string"
      ) {
        location.reload();
      }
    } catch {
      // A network outage is not evidence that the launch lifecycle changed.
    } finally {
      checkingLifecycle = false;
    }
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
    // Admission responses arrive over POST. Eventual command settlement is
    // replayable session-stream state and therefore arrives here.
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
    imageUrl() {
      // Binary image resolution is a later phase; report no resolvable URL.
      return "";
    },

    connect(handlers) {
      activeHandlers = handlers;
      source = new EventSource(eventsUrl);
      source.onopen = () => handlers.onStatus("online");
      source.onmessage = (event) => forward(handlers, event.data);
      source.onerror = () => {
        handlers.onStatus("offline");
        void revealLifecycleChange(handlers);
      };
      return () => {
        source?.close();
        source = undefined;
        if (activeHandlers === handlers) activeHandlers = undefined;
      };
    },

    getHistory() {
      // Bounded history paging is owned by a later phase; never fetch here.
      return Promise.reject(new Error("Older history is unavailable in this managed session"));
    },

    async submit(command, signal) {
      let response: Response;
      try {
        response = await fetch(commandUrl, {
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
      // Any non-authoritative outcome (an ambiguous 409 error envelope, an
      // unparseable or wrong-typed body) is equally ambiguous; never fabricate a
      // host rejection from it.
      throw new Error("Command delivery unconfirmed");
    },

    async mutatePendingInput(command: QueueMutationCommand, signal: AbortSignal) {
      let response: Response;
      try {
        response = await fetch(commandUrl, {
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

    async submitModelControl(command: ModelControlCommand, signal: AbortSignal) {
      let response: Response;
      try {
        response = await fetch(commandUrl, {
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
        response.status === 200 &&
        validate(activeHandlers, isModelControlResponseEnvelope, value) &&
        value.commandId === command.commandId &&
        value.generation === command.generation &&
        value.commandEpoch === command.commandEpoch
      )
        return value;
      throw new Error("Model control delivery unconfirmed");
    },

    complete() {
      // Completion discovery is owned by a later phase; never fetch here.
      return Promise.reject(new Error("Completion is unavailable in this managed session"));
    },

    close() {
      source?.close();
      source = undefined;
      activeHandlers = undefined;
    },
  };
}
