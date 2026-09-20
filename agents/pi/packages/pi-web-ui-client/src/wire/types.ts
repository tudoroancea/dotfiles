// Host-neutral browser transport types. Wire DTOs are schema-derived in
// `schema.ts`; this file keeps only the UI/transport seam handwritten.

import type {
  CommandCompletionEnvelope,
  CommandResponseEnvelope,
  CompletionQuery,
  CompletionResultEnvelope,
  ErrorEnvelope,
  HistoryPageEnvelope,
  HistoryRequest,
  ModelControlCommand,
  ModelControlResponseEnvelope,
  OperationBatchEnvelope,
  OutboundCommand,
  QueueMutationCommand,
  ResetEnvelope,
  SessionSnapshotEnvelope,
} from "./protocol.ts";
import type {
  CommandAcceptance,
  CompletionItem,
  ImageReference,
  Snapshot,
  SubmittedCommand,
} from "./schema.ts";

export type ConnectionStatus = "connecting" | "online" | "offline";

export interface TransportHandlers {
  onSnapshot(snapshot: Snapshot): void;
  onStatus(status: ConnectionStatus): void;
}

// The browser components depend only on this seam. They must not know whether the
// data came from Pi Extension APIs, daemon RPC events, or a recorded fixture.
export interface SessionTransport {
  connect(handlers: TransportHandlers): () => void;
  submit(command: SubmittedCommand): Promise<CommandAcceptance>;
  complete(query: string, signal: AbortSignal): Promise<CompletionItem[]>;
}

export type SessionStateEnvelope =
  | SessionSnapshotEnvelope
  | OperationBatchEnvelope
  | ResetEnvelope
  | CommandCompletionEnvelope
  | ErrorEnvelope;

export type BrowserTimingStage =
  | "jsonParse"
  | "schemaValidation"
  | "reducerApplication"
  | "renderCommit";

export interface IncrementalTransportHandlers {
  onEnvelope(envelope: SessionStateEnvelope): void;
  onStatus(status: ConnectionStatus): void;
  onTiming?(stage: "jsonParse" | "schemaValidation", durationMs: number): void;
}

/** Phase 3 transport seam. The legacy seam above remains for current components. */
export interface IncrementalSessionTransport {
  connect(handlers: IncrementalTransportHandlers): () => void;
  /** Resolve an opaque reference to a host-owned, authenticated resource URL. */
  imageUrl(reference: ImageReference): string;
  getHistory(request: HistoryRequest, signal: AbortSignal): Promise<HistoryPageEnvelope>;
  submit(command: OutboundCommand, signal: AbortSignal): Promise<CommandResponseEnvelope>;
  mutatePendingInput(
    command: QueueMutationCommand,
    signal: AbortSignal,
  ): Promise<CommandResponseEnvelope>;
  submitModelControl(
    command: ModelControlCommand,
    signal: AbortSignal,
  ): Promise<ModelControlResponseEnvelope>;
  complete(query: CompletionQuery, signal: AbortSignal): Promise<CompletionResultEnvelope>;
  close(): void;
}

export type {
  CommandAcceptance,
  CompletionItem,
  CompletionRequest,
  CompletionResponse,
  ContextUsage,
  ImageMimeType,
  ImageOmission,
  ImageOmissionReason,
  ImageReference,
  ModelChoice,
  ModelControlCapability,
  QueueMutationRejectionReason,
  RemoteImageBlock,
  InputDelivery,
  PendingInput,
  PendingInputBrokerCapability,
  SessionMetadata,
  SessionModel,
  Snapshot,
  SnapshotTheme,
  SubmittedCommand,
  ThemePalette,
  ThinkingLevel,
} from "./schema.ts";
