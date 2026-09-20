// Session controller.
//
// Owns the incremental protocol lifecycle for one mounted client: it drives the
// reducer from transport envelopes, recovers by reconnecting when continuity is
// lost, loads older history pages, and submits admission-only commands. It never
// references `fetch`, `EventSource`, or any host detail — only the injected
// `IncrementalSessionTransport` seam and the shared reducer.

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { LIMITS } from "../wire/limits.ts";
import type {
  CommandCompletionEnvelope,
  CommandResponseEnvelope,
  HistoryRequest,
  ModelControlCommand,
  ModelControlResponseEnvelope,
  OutboundImageAttachment,
  OutboundCommand,
  QueueMutationCommand,
} from "../wire/protocol.ts";
import { isImageAttachmentCommandPreflightValid } from "../wire/protocol.ts";
import type {
  CompletionItem,
  InputDelivery,
  QueueMutationRejectionReason,
  ThinkingLevel,
} from "../wire/schema.ts";
import type {
  BrowserTimingStage,
  ConnectionStatus,
  IncrementalSessionTransport,
} from "../wire/types.ts";
import {
  applySessionEnvelope,
  MAX_LOADED_ENTRIES,
  prependHistoryPage,
  type SessionState,
} from "./session-state.ts";

/** Distinct browser pipeline timings plus reset/envelope counters for diagnostics. */
export interface TimingMetric {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
}

export interface SessionMetrics {
  envelopes: number;
  resets: number;
  timings: Record<BrowserTimingStage, TimingMetric>;
}

function emptyTiming(): TimingMetric {
  return { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
}

export function recordTiming(
  metrics: SessionMetrics,
  stage: BrowserTimingStage,
  durationMs: number,
): void {
  const timing = metrics.timings[stage];
  timing.count += 1;
  timing.totalMs += durationMs;
  timing.maxMs = Math.max(timing.maxMs, durationMs);
  timing.lastMs = durationMs;
}

/** Result of an admission-only command submission. */
export interface SubmitResult {
  accepted: boolean;
  error?: string;
  commandId: string;
  /**
   * The command's fate is unknown: a transport network/parse failure or a
   * non-matching response means the host may or may not have admitted it. The
   * same command id is preserved so a retry of the identical prompt is deduped by
   * the host rather than admitting the prompt twice.
   */
  ambiguous?: boolean;
  reason?: QueueMutationRejectionReason;
}

type ModelControlTarget =
  | { type: "set-model"; provider: string; modelId: string }
  | { type: "set-thinking"; thinkingLevel: ThinkingLevel };

interface ModelControlLedgerEntry {
  readonly commandId: string;
  readonly target: ModelControlTarget;
}

interface InFlightModelControl extends ModelControlLedgerEntry {
  readonly promise: Promise<SubmitResult>;
}

function modelControlTargetKey(target: ModelControlTarget): string {
  return target.type === "set-model"
    ? JSON.stringify([target.type, target.provider, target.modelId])
    : JSON.stringify([target.type, target.thinkingLevel]);
}

function isAuthoritativeModelControlTarget(
  target: ModelControlTarget,
  state: SessionState | null,
): boolean {
  return target.type === "set-model"
    ? state?.snapshot.metadata?.model?.provider === target.provider &&
        state.snapshot.metadata.model.id === target.modelId
    : state?.snapshot.metadata?.thinkingLevel === target.thinkingLevel;
}

export interface SessionController {
  state: SessionState | null;
  connection: ConnectionStatus;
  loadingOlder: boolean;
  metrics: SessionMetrics;
  commandCompletions: ReadonlyMap<string, CommandCompletionEnvelope>;
  loadOlder(): void;
  submit(
    content: string,
    delivery: InputDelivery,
    attachments?: readonly OutboundImageAttachment[],
    retryIdentity?: string,
  ): Promise<SubmitResult>;
  mutatePendingInput(
    itemId: string,
    expectedItemVersion: number,
    action: "edit" | "remove",
    content?: string,
  ): Promise<SubmitResult>;
  submitModelControl(target: ModelControlTarget): Promise<SubmitResult>;
  complete(query: string, signal: AbortSignal): Promise<CompletionItem[]>;
}

const HISTORY_PAGE_LIMIT = 200;
const MAX_COMMAND_COMPLETIONS = 128;
const MAX_MODEL_CONTROL_LEDGER_ENTRIES = 32;

function newCommandId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useSession(transport: IncrementalSessionTransport): SessionController {
  const [state, setState] = useState<SessionState | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [commandCompletions, setCommandCompletions] = useState<
    ReadonlyMap<string, CommandCompletionEnvelope>
  >(new Map());
  // A recovery epoch: bumping it tears down and re-opens the transport so the host
  // re-sends a fresh snapshot after any lost-continuity or recoverable error.
  const [epoch, setEpoch] = useState(0);

  const stateRef = useRef<SessionState | null>(null);
  const recoveryAttemptsRef = useRef(0);
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const loadingRef = useRef(false);
  // Records submissions whose fate stayed ambiguous, keyed by generation and exact
  // prompt, so later retries still reuse one command id even if another draft was sent.
  const pendingCommandsRef = useRef(new Map<string, string>());
  const modelControlInFlightRef = useRef(new Map<string, InFlightModelControl>());
  const ambiguousModelControlsRef = useRef(new Map<string, ModelControlLedgerEntry>());
  const metricsRef = useRef<SessionMetrics>({
    envelopes: 0,
    resets: 0,
    timings: {
      jsonParse: emptyTiming(),
      schemaValidation: emptyTiming(),
      reducerApplication: emptyTiming(),
      renderCommit: emptyTiming(),
    },
  });

  const requestRecovery = useCallback(() => {
    if (recoveryTimerRef.current) return;
    setConnection("offline");
    const delay = Math.min(100 * 2 ** recoveryAttemptsRef.current, 2_000);
    recoveryAttemptsRef.current += 1;
    recoveryTimerRef.current = setTimeout(() => {
      recoveryTimerRef.current = undefined;
      setConnection("connecting");
      setEpoch((current) => current + 1);
    }, delay);
  }, []);

  useEffect(() => {
    let disposed = false;
    let synchronized = false;
    const dispose = transport.connect({
      onStatus: (status) => {
        if (!disposed && (status !== "online" || synchronized)) setConnection(status);
      },
      onTiming: (stage, durationMs) => recordTiming(metricsRef.current, stage, durationMs),
      onEnvelope: (envelope) => {
        if (disposed) return;
        if (envelope.type === "error") {
          if (envelope.recoverable) requestRecovery();
          else setConnection("offline");
          return;
        }
        if (envelope.type === "command-completion") {
          const current = stateRef.current;
          if (
            !current ||
            envelope.generation !== current.generation ||
            envelope.commandEpoch !== current.snapshot.commandEpoch
          ) {
            return;
          }
          if (envelope.revision > current.revision) {
            requestRecovery();
            return;
          }
          setCommandCompletions((previous) => {
            const existing = previous.get(envelope.commandId);
            if (existing) {
              if (
                existing.status !== envelope.status ||
                existing.revision !== envelope.revision ||
                (existing.status === "failed" &&
                  envelope.status === "failed" &&
                  existing.error !== envelope.error)
              ) {
                requestRecovery();
              }
              return previous;
            }
            const next = new Map(previous);
            next.set(envelope.commandId, envelope);
            if (next.size > MAX_COMMAND_COMPLETIONS) next.delete(next.keys().next().value!);
            return next;
          });
          return;
        }
        const started = performance.now();
        const transition = applySessionEnvelope(stateRef.current, envelope);
        recordTiming(metricsRef.current, "reducerApplication", performance.now() - started);
        metricsRef.current.envelopes += 1;
        if (transition.status === "applied") {
          synchronized = true;
          recoveryAttemptsRef.current = 0;
          setConnection("online");
          if (
            stateRef.current?.generation !== transition.state.generation ||
            stateRef.current?.snapshot.commandEpoch !== transition.state.snapshot.commandEpoch
          ) {
            pendingCommandsRef.current.clear();
            modelControlInFlightRef.current.clear();
            ambiguousModelControlsRef.current.clear();
            setCommandCompletions(new Map());
          } else {
            for (const [key, entry] of ambiguousModelControlsRef.current) {
              if (isAuthoritativeModelControlTarget(entry.target, transition.state))
                ambiguousModelControlsRef.current.delete(key);
            }
          }
          stateRef.current = transition.state;
          setState(transition.state);
        } else {
          metricsRef.current.resets += 1;
          requestRecovery();
        }
      },
    });
    return () => {
      disposed = true;
      dispose();
    };
  }, [transport, epoch, requestRecovery]);

  useEffect(
    () => () => {
      if (recoveryTimerRef.current) clearTimeout(recoveryTimerRef.current);
    },
    [],
  );

  const loadOlder = useCallback(() => {
    const current = stateRef.current;
    if (!current || loadingRef.current) return;
    const { history } = current.snapshot;
    const beforeId = current.snapshot.entries[0]?.id;
    if (
      !history.hasMore ||
      history.beforeCursor === null ||
      !beforeId ||
      current.snapshot.entries.length >= MAX_LOADED_ENTRIES
    )
      return;

    loadingRef.current = true;
    setLoadingOlder(true);
    const request: HistoryRequest = {
      version: 1,
      type: "history-request",
      generation: current.generation,
      revision: current.revision,
      historyGeneration: history.historyGeneration,
      beforeCursor: history.beforeCursor,
      beforeId,
      limit: Math.min(
        HISTORY_PAGE_LIMIT,
        LIMITS.maxHistoryPageSize,
        MAX_LOADED_ENTRIES - current.snapshot.entries.length,
      ),
    };
    const controller = new AbortController();
    transport
      .getHistory(request, controller.signal)
      .then((page) => {
        const active = stateRef.current;
        if (!active) return;
        const started = performance.now();
        const transition = prependHistoryPage(active, page);
        recordTiming(metricsRef.current, "reducerApplication", performance.now() - started);
        if (transition.status === "applied") {
          stateRef.current = transition.state;
          setState(transition.state);
        } else {
          requestRecovery();
        }
      })
      .catch(() => {
        // A failed page leaves state untouched; the boundary can be retried.
      })
      .finally(() => {
        loadingRef.current = false;
        setLoadingOlder(false);
      });
  }, [transport, requestRecovery]);

  const submit = useCallback(
    async (
      content: string,
      delivery: InputDelivery,
      attachments: readonly OutboundImageAttachment[] = [],
      retryIdentity?: string,
    ): Promise<SubmitResult> => {
      const generation = stateRef.current?.generation;
      const commandEpoch = stateRef.current?.snapshot.commandEpoch;
      const identity = attachments.length > 0 ? (retryIdentity ?? newCommandId()) : content;
      const key = `${generation ?? ""}\0${commandEpoch ?? ""}\0${delivery}\0${identity}`;
      const commandId = pendingCommandsRef.current.get(key) ?? newCommandId();
      if (!generation || !commandEpoch)
        return { accepted: false, error: "Not connected", commandId };
      const controller = new AbortController();
      const command: OutboundCommand = attachments.length
        ? {
            version: 1,
            type: "image-command",
            commandId,
            generation,
            commandEpoch,
            content,
            delivery,
            attachments: [...attachments],
          }
        : {
            version: 1,
            type: "command",
            commandId,
            generation,
            commandEpoch,
            content,
            delivery,
          };
      if (
        command.type === "image-command" &&
        !isImageAttachmentCommandPreflightValid(
          command,
          stateRef.current?.snapshot.imageAttachments,
        )
      ) {
        return { accepted: false, error: "Image attachments are not available", commandId };
      }
      let response: CommandResponseEnvelope;
      try {
        response = await transport.submit(command, controller.signal);
      } catch {
        // Transport network/parse failure: the host may or may not have admitted
        // this exact command. Keep the id so a retry of the same prompt is deduped.
        pendingCommandsRef.current.set(key, commandId);
        return {
          accepted: false,
          ambiguous: true,
          error: "Delivery unconfirmed — retry to be sure",
          commandId,
        };
      }
      // A response for a different command or generation leaves this command's fate
      // unknown; treat it as ambiguous and keep the id for a deduped retry.
      if (
        response.commandId !== commandId ||
        response.generation !== generation ||
        response.commandEpoch !== commandEpoch
      ) {
        pendingCommandsRef.current.set(key, commandId);
        return { accepted: false, ambiguous: true, error: "Stale command response", commandId };
      }
      // Authoritative accept or reject: the command's fate is settled.
      pendingCommandsRef.current.delete(key);
      return response.accepted
        ? { accepted: true, commandId }
        : { accepted: false, error: response.error, reason: response.reason, commandId };
    },
    [transport],
  );

  const mutatePendingInput = useCallback(
    async (
      itemId: string,
      expectedItemVersion: number,
      action: "edit" | "remove",
      content?: string,
    ): Promise<SubmitResult> => {
      const generation = stateRef.current?.generation;
      const commandEpoch = stateRef.current?.snapshot.commandEpoch;
      const key = [
        generation ?? "",
        commandEpoch ?? "",
        itemId,
        expectedItemVersion,
        action,
        content ?? "",
      ].join("\\0");
      const commandId = pendingCommandsRef.current.get(key) ?? newCommandId();
      if (!generation || !commandEpoch)
        return { accepted: false, error: "Not connected", commandId };
      const command: QueueMutationCommand =
        action === "edit"
          ? {
              version: 1,
              type: "queue-edit",
              commandId,
              generation,
              commandEpoch,
              itemId,
              expectedItemVersion,
              content: content ?? "",
            }
          : {
              version: 1,
              type: "queue-remove",
              commandId,
              generation,
              commandEpoch,
              itemId,
              expectedItemVersion,
            };
      let response: CommandResponseEnvelope;
      try {
        response = await transport.mutatePendingInput(command, new AbortController().signal);
      } catch {
        pendingCommandsRef.current.set(key, commandId);
        return {
          accepted: false,
          ambiguous: true,
          error: "Queue mutation unconfirmed — retry to be sure",
          commandId,
        };
      }
      if (
        response.commandId !== commandId ||
        response.generation !== generation ||
        response.commandEpoch !== commandEpoch
      ) {
        pendingCommandsRef.current.set(key, commandId);
        return { accepted: false, ambiguous: true, error: "Stale queue response", commandId };
      }
      pendingCommandsRef.current.delete(key);
      return response.accepted
        ? { accepted: true, commandId }
        : {
            accepted: false,
            error: response.error,
            reason: response.reason,
            commandId,
          };
    },
    [transport],
  );

  const submitModelControl = useCallback(
    (target: ModelControlTarget): Promise<SubmitResult> => {
      const generation = stateRef.current?.generation;
      const commandEpoch = stateRef.current?.snapshot.commandEpoch;
      const key = `${generation ?? ""}\0${commandEpoch ?? ""}\0${modelControlTargetKey(target)}`;
      const existing = modelControlInFlightRef.current.get(key);
      if (existing) return existing.promise;

      const commandId = ambiguousModelControlsRef.current.get(key)?.commandId ?? newCommandId();
      if (!generation || !commandEpoch)
        return Promise.resolve({ accepted: false, error: "Not connected", commandId });
      if (modelControlInFlightRef.current.size >= MAX_MODEL_CONTROL_LEDGER_ENTRIES) {
        return Promise.resolve({
          accepted: false,
          error: "Too many model changes are pending",
          commandId,
        });
      }

      const command: ModelControlCommand =
        target.type === "set-model"
          ? {
              version: 1,
              type: "set-model",
              commandId,
              generation,
              commandEpoch,
              provider: target.provider,
              modelId: target.modelId,
            }
          : {
              version: 1,
              type: "set-thinking",
              commandId,
              generation,
              commandEpoch,
              thinkingLevel: target.thinkingLevel,
            };
      const rememberAmbiguous = () => {
        if (
          stateRef.current?.generation !== generation ||
          stateRef.current.snapshot.commandEpoch !== commandEpoch
        )
          return;
        if (isAuthoritativeModelControlTarget(target, stateRef.current)) {
          ambiguousModelControlsRef.current.delete(key);
          return;
        }
        if (
          !ambiguousModelControlsRef.current.has(key) &&
          ambiguousModelControlsRef.current.size >= MAX_MODEL_CONTROL_LEDGER_ENTRIES
        ) {
          ambiguousModelControlsRef.current.delete(
            ambiguousModelControlsRef.current.keys().next().value!,
          );
        }
        ambiguousModelControlsRef.current.set(key, { commandId, target });
      };
      const promise = (async (): Promise<SubmitResult> => {
        let response: ModelControlResponseEnvelope;
        try {
          response = await Promise.resolve().then(() =>
            transport.submitModelControl(command, new AbortController().signal),
          );
        } catch {
          rememberAmbiguous();
          return {
            accepted: false,
            ambiguous: true,
            error: "Model change unconfirmed — retry to be sure",
            commandId,
          };
        } finally {
          const current = modelControlInFlightRef.current.get(key);
          if (current?.commandId === commandId) modelControlInFlightRef.current.delete(key);
        }
        if (
          response.commandId !== commandId ||
          response.generation !== generation ||
          response.commandEpoch !== commandEpoch
        ) {
          rememberAmbiguous();
          return {
            accepted: false,
            ambiguous: true,
            error: "Stale model control response",
            commandId,
          };
        }
        ambiguousModelControlsRef.current.delete(key);
        return response.accepted
          ? { accepted: true, commandId }
          : { accepted: false, error: response.error, reason: response.reason, commandId };
      })();
      modelControlInFlightRef.current.set(key, { commandId, target, promise });
      return promise;
    },
    [transport],
  );

  const complete = useCallback(
    async (query: string, signal: AbortSignal): Promise<CompletionItem[]> => {
      const generation = stateRef.current?.generation;
      if (!generation) return [];
      const result = await transport.complete(
        { version: 1, type: "completion-request", generation, query },
        signal,
      );
      return result.generation === generation ? result.items : [];
    },
    [transport],
  );

  return {
    state,
    connection,
    loadingOlder,
    metrics: metricsRef.current,
    commandCompletions,
    loadOlder,
    submit,
    mutatePendingInput,
    submitModelControl,
    complete,
  };
}
