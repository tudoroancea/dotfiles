import type {
  CommandAcceptance,
  CompletionItem,
  ImageAttachmentCapability,
  InputDelivery,
  ModelControlCommand,
  OutboundCommand,
  PendingInput,
  PendingInputBrokerCapability,
  QueueMutationCommand,
  SessionMetadata,
  Snapshot,
  SnapshotTheme,
  ThemePalette,
} from "@dotfiles/pi-web-ui-client/wire";
import type { JournalMetricsSink, JournalMetricsSnapshot } from "./metrics.js";

export interface StartServerOptions {
  submitInput?: (command: OutboundCommand, signal: AbortSignal) => Promise<CommandAcceptance>;
  mutatePendingInput?: (
    command: QueueMutationCommand,
    signal: AbortSignal,
  ) => Promise<CommandAcceptance>;
  modelControl?: (
    command: ModelControlCommand,
    signal: AbortSignal,
    tryHandoff: () => boolean,
  ) => Promise<CommandAcceptance>;
  onCommandEpochReset?: (reason: string) => void;
  completeMention?: (query: string, signal: AbortSignal) => Promise<CompletionItem[]>;
  getPollKey?: () => string;
  getEntries?: () => { persisted: readonly unknown[]; live: readonly unknown[] };
  getPersistedEntries?: () => readonly unknown[];
  getLiveEntries?: () => readonly unknown[];
  metrics?: JournalMetricsSink;
}

export interface WebUiServer {
  readonly url: string;
  readonly origin: string;
  readonly port: number;
  bootstrapUrl(origin?: string): string;
  readonly generation: string;
  readonly commandEpoch: string;
  readonly imageAttachmentCapability: ImageAttachmentCapability | undefined;
  broadcast(mode?: "full" | "live"): void;
  completeCommand(
    commandId: string,
    commandEpoch: string,
    status: "completed" | "failed",
    error?: string,
  ): void;
  reset(reason: string): void;
  metrics(): JournalMetricsSnapshot;
  close(): Promise<void>;
}

export type {
  CommandAcceptance,
  CompletionItem,
  InputDelivery,
  PendingInput,
  PendingInputBrokerCapability,
  SessionMetadata,
  Snapshot,
  SnapshotTheme,
  ThemePalette,
};
