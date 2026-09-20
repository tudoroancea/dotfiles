// A host-free `SessionTransport` for rendering a complete session without Pi or
// HTTP. It replays a fixed snapshot, echoes accepted immediate messages as new
// user entries, and answers completion from a static list. It is enough to drive
// the shared client in a browser test harness or a future conformance runner.

import type {
  CompletionItem,
  SessionTransport,
  Snapshot,
  TransportHandlers,
} from "../wire/types.ts";

export interface MockTransportOptions {
  completions?: CompletionItem[];
}

/** A mock transport plus a `close` helper for tearing down test listeners. */
export type MockTransport = SessionTransport & { close(): void };

export function createMockTransport(
  initial: Snapshot,
  options: MockTransportOptions = {},
): MockTransport {
  let snapshot = structuredClone(initial);
  const completions = options.completions ?? [];
  const listeners = new Set<TransportHandlers>();

  function emit() {
    for (const handlers of listeners) handlers.onSnapshot(structuredClone(snapshot));
  }

  return {
    connect(handlers) {
      listeners.add(handlers);
      handlers.onStatus("online");
      handlers.onSnapshot(structuredClone(snapshot));
      return () => listeners.delete(handlers);
    },
    async submit({ content, delivery }) {
      if (delivery === "immediate" && snapshot.isRunning) {
        return { accepted: false, error: "Pi is busy; choose Steer or Queue" };
      }
      if (delivery === "immediate") {
        const index = snapshot.entries.length;
        snapshot = {
          ...snapshot,
          isRunning: true,
          leafId: `mock-${index}`,
          entries: [
            ...snapshot.entries,
            {
              id: `mock-${index}`,
              parentId: snapshot.leafId,
              timestamp: new Date(0).toISOString(),
              type: "message",
              message: { role: "user", content: [{ type: "text", text: content }] },
            },
          ],
        };
      } else {
        snapshot = {
          ...snapshot,
          pendingInputs: [
            ...snapshot.pendingInputs,
            { id: `pending-${snapshot.pendingInputs.length}`, content, delivery },
          ],
        };
      }
      emit();
      return { accepted: true };
    },
    async complete(query) {
      return completions.filter((item) => item.value.includes(query.replace(/^@"?/, "")));
    },
    close() {
      listeners.clear();
    },
  };
}
