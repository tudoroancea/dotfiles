import { Check } from "typebox/value";
import { applySessionEnvelope, createSessionState } from "../client/session-state.ts";
import {
  isImageAttachmentCommandPreflightValid,
  isModelControlCommandPreflightValid,
  LIMITS,
  QueueMutationCommandSchema,
  SessionCommandSchema,
} from "../wire/index.ts";
import type {
  CommandResponseEnvelope,
  CompletionResultEnvelope,
  HistoryPageEnvelope,
  IncrementalSessionTransport,
  IncrementalTransportHandlers,
  ModelControlResponseEnvelope,
  SessionSnapshotEnvelope,
  SessionStateEnvelope,
} from "../wire/index.ts";

export interface MockIncrementalTransport extends IncrementalSessionTransport {
  emit(frame: SessionStateEnvelope): void;
}

export interface MockIncrementalScript {
  commandResponses?: readonly CommandResponseEnvelope[];
  modelControlResponses?: readonly ModelControlResponseEnvelope[];
  completionResults?: readonly CompletionResultEnvelope[];
  imageUrl?: (id: string) => string;
}

/** Deterministic operation transport for reducer and host conformance tests. */
export function createMockIncrementalTransport(
  initial: SessionSnapshotEnvelope,
  historyPages: readonly HistoryPageEnvelope[] = [],
  script: MockIncrementalScript = {},
): MockIncrementalTransport {
  const listeners = new Set<IncrementalTransportHandlers>();
  const commandResponses = [...(script.commandResponses ?? [])];
  const modelControlResponses = [...(script.modelControlResponses ?? [])];
  const completionResults = [...(script.completionResults ?? [])];
  const initialTransition = createSessionState(initial);
  if (initialTransition.status !== "applied") throw new Error("Invalid mock initial snapshot");
  let currentState = initialTransition.state;
  let reconnectSnapshot = structuredClone(initial);

  return {
    connect(handlers) {
      listeners.add(handlers);
      handlers.onStatus("online");
      handlers.onEnvelope(structuredClone(reconnectSnapshot));
      return () => listeners.delete(handlers);
    },
    imageUrl(reference) {
      return script.imageUrl?.(reference.id) ?? `mock-images/${encodeURIComponent(reference.id)}`;
    },
    emit(frame) {
      const transition =
        frame.type === "command-completion" ? undefined : applySessionEnvelope(currentState, frame);
      if (transition?.status === "applied") {
        currentState = transition.state;
        const entries = currentState.snapshot.entries.slice(-LIMITS.maxSnapshotEntries);
        const truncated = entries.length < currentState.snapshot.entries.length;
        reconnectSnapshot = {
          version: 1,
          type: "snapshot",
          generation: currentState.generation,
          revision: currentState.revision,
          snapshot: {
            ...structuredClone(currentState.snapshot),
            entries: structuredClone(entries),
            history: {
              ...structuredClone(currentState.snapshot.history),
              beforeCursor: truncated
                ? `mock-before-${entries[0]?.id ?? "empty"}`
                : currentState.snapshot.history.beforeCursor,
              hasMore: truncated || currentState.snapshot.history.hasMore,
              oldestEntryId: entries[0]?.id ?? null,
            },
          },
        };
      }
      for (const handlers of listeners) handlers.onEnvelope(structuredClone(frame));
    },
    async getHistory(request) {
      const page = historyPages.find(
        (candidate) =>
          candidate.generation === request.generation && candidate.beforeId === request.beforeId,
      );
      if (!page) throw new Error("No matching mock history page");
      return structuredClone(page);
    },
    async submit(command): Promise<CommandResponseEnvelope> {
      const scripted = commandResponses.shift();
      if (scripted) return structuredClone(scripted);
      const structurallyValid =
        command.type === "command"
          ? Check(SessionCommandSchema, command)
          : isImageAttachmentCommandPreflightValid(command, currentState.snapshot.imageAttachments);
      return structurallyValid &&
        command.generation === currentState.generation &&
        command.commandEpoch === currentState.snapshot.commandEpoch
        ? {
            version: 1,
            type: "command-response",
            commandId: command.commandId,
            generation: command.generation,
            commandEpoch: command.commandEpoch,
            accepted: true,
          }
        : {
            version: 1,
            type: "command-response",
            commandId: command.commandId,
            generation: command.generation,
            commandEpoch: command.commandEpoch,
            accepted: false,
            error: "Stale generation",
          };
    },
    async mutatePendingInput(command): Promise<CommandResponseEnvelope> {
      const scripted = commandResponses.shift();
      const structurallyValid = Check(QueueMutationCommandSchema, command);
      return scripted
        ? structuredClone(scripted)
        : structurallyValid &&
            command.generation === currentState.generation &&
            command.commandEpoch === currentState.snapshot.commandEpoch
          ? {
              version: 1,
              type: "command-response",
              commandId: command.commandId,
              generation: command.generation,
              commandEpoch: command.commandEpoch,
              accepted: true,
            }
          : {
              version: 1,
              type: "command-response",
              commandId: command.commandId,
              generation: command.generation,
              commandEpoch: command.commandEpoch,
              accepted: false,
              error: "Stale queue mutation",
              reason: "session-changed",
            };
    },
    async submitModelControl(command): Promise<ModelControlResponseEnvelope> {
      const scripted = modelControlResponses.shift();
      if (scripted) return structuredClone(scripted);
      const capability = currentState.snapshot.modelControl;
      const advertised = isModelControlCommandPreflightValid(command, capability);
      return advertised &&
        command.generation === currentState.generation &&
        command.commandEpoch === currentState.snapshot.commandEpoch
        ? {
            version: 1,
            type: "command-response",
            commandId: command.commandId,
            generation: command.generation,
            commandEpoch: command.commandEpoch,
            accepted: true,
          }
        : {
            version: 1,
            type: "command-response",
            commandId: command.commandId,
            generation: command.generation,
            commandEpoch: command.commandEpoch,
            accepted: false,
            error: capability ? "Invalid model control" : "Model control is unavailable",
            reason: capability ? "invalid" : "capability-off",
          };
    },
    async complete(query): Promise<CompletionResultEnvelope> {
      const scripted = completionResults.shift();
      return scripted
        ? structuredClone(scripted)
        : {
            version: 1,
            type: "completion-response",
            generation: query.generation,
            items: [],
          };
    },
    close() {
      listeners.clear();
    },
  };
}
