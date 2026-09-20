export type HostLifecycleState =
  | "unloaded"
  | "loading"
  | "ready"
  | "running"
  | "transitioning"
  | "unloading"
  | "restarting"
  | "stopping"
  | "stopped"
  | "failed";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SessionIdentity {
  sessionId: string;
  sessionFile: string | null;
}
export interface SessionHostImage {
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  byteLength: number;
}
export interface SessionHostState {
  launchId: string;
  hostEpoch: string;
  sessionEpoch: string;
  lifecycle: HostLifecycleState;
  ready: boolean;
  running: boolean;
  settled: boolean;
  pendingMessages: number;
  queueCount: number;
  queueBytes: number;
  dialog: { id: string; kind: "select" | "confirm" | "input" | "editor" } | null;
  model: { provider: string; id: string } | null;
  thinkingLevel: ThinkingLevel;
  identity: SessionIdentity | null;
  failure?: { code: string; message: string; ambiguous: boolean };
}

export type SessionHostCommand =
  | { type: "prompt"; commandId: string; text: string; images?: readonly SessionHostImage[] }
  | { type: "steer"; commandId: string; text: string; images?: readonly SessionHostImage[] }
  | {
      type: "follow_up";
      commandId: string;
      text: string;
      images?: readonly SessionHostImage[];
    }
  | {
      type: "queue_edit";
      commandId: string;
      itemId: string;
      expectedItemVersion: number;
      text: string;
    }
  | { type: "queue_remove"; commandId: string; itemId: string; expectedItemVersion: number }
  | { type: "abort"; commandId: string }
  | { type: "dialog_response"; commandId: string; dialogId: string; value: string | boolean }
  | { type: "dialog_cancel"; commandId: string; dialogId: string }
  | { type: "set_model"; commandId: string; provider: string; model: string }
  | { type: "set_thinking"; commandId: string; level: ThinkingLevel }
  | { type: "compact"; commandId: string; instructions?: string };

export type AdmissionResult =
  | { status: "accepted" | "queued" | "handled"; commandId: string }
  | { status: "rejected"; commandId: string; code: string; message: string }
  | { status: "ambiguous"; commandId: string; message: string };

export type SessionTransition =
  | { type: "new" }
  | { type: "switch"; sessionFile: string }
  | { type: "fork"; entryId: string }
  | { type: "clone"; entryId: string }
  | { type: "import"; sessionFile: string }
  | { type: "replace"; sessionFile?: string }
  | { type: "unload" }
  | { type: "restart"; sessionFile?: string };
export interface TransitionResult {
  status: "completed" | "cancelled" | "failed";
  identity?: SessionIdentity;
  message?: string;
}

export type SessionHostEvent =
  | { type: "state"; state: SessionHostState }
  | { type: "admission"; result: AdmissionResult }
  | {
      type: "command_completed";
      commandId: string;
      outcome: "completed" | "failed" | "aborted";
      message?: string;
    }
  | {
      type: "message_start" | "message_end";
      messageId: string;
      role: "user" | "assistant" | "tool";
    }
  | { type: "message_delta"; messageId: string; text: string }
  | { type: "tool_start"; toolCallId: string; name: string; input?: unknown }
  | { type: "tool_update"; toolCallId: string; update: unknown }
  | { type: "tool_end"; toolCallId: string; output?: unknown; error?: string }
  | { type: "queue"; count: number; bytes: number }
  | { type: "dialog"; dialog: SessionHostState["dialog"] }
  | { type: "model"; model: SessionHostState["model"] }
  | { type: "thinking"; level: ThinkingLevel }
  | { type: "durable_change" }
  | { type: "compaction"; phase: "started" | "completed" | "failed"; message?: string }
  | { type: "settled" }
  | {
      type: "transition";
      phase: "started" | "completed" | "failed";
      transition: SessionTransition;
      message?: string;
    }
  | { type: "host_lost"; ambiguousCommandId?: string }
  | { type: "disposed"; success: boolean; errors: string[] };

export interface HistoryEntry {
  id: string;
  parentId: string | null;
  type: string;
  timestamp: number;
  data: unknown;
}
export interface HistoryRequest {
  cursor?: string;
  limit: number;
  byteLimit: number;
}
export interface HistoryPage {
  entries: HistoryEntry[];
  nextCursor: string | null;
  degraded: boolean;
  degradedReasons?: string[];
  omittedEntries: number;
}
export interface ProjectionReadRequest {
  maxEntries: number;
  byteLimit: number;
}
export interface ProjectionQueueItem {
  id: string;
  content: string;
  delivery: "steer" | "followUp";
  attachmentCount?: number;
  editable?: boolean;
  itemVersion?: number;
  state?: "held" | "releasing";
}
/** Latest bounded active-branch view used by host-neutral live projections. */
export interface ProjectionRead {
  sessionEpoch: string;
  entries: HistoryEntry[];
  beforeCursor: string | null;
  hasMore: boolean;
  queue: ProjectionQueueItem[];
  imageAttachments?: {
    supportedMimeTypes: ("image/png" | "image/jpeg" | "image/webp")[];
    maxAttachments: number;
    maxBytesPerImage: number;
    maxTotalBytes: number;
    maxWidth: number;
    maxHeight: number;
    maxPixels: number;
    maxTotalPixels: number;
  };
  pendingInputBroker?: { edit: boolean; remove: boolean };
  modelControl?: {
    models: { provider: string; id: string; name: string }[];
    thinkingLevels: ThinkingLevel[];
  };
}
export type SessionHostListener = (event: SessionHostEvent) => void;
export interface SessionCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

export interface SessionHost {
  readonly state: SessionHostState;
  subscribe(listener: SessionHostListener): () => void;
  commands(): readonly SessionCommandInfo[];
  command(command: SessionHostCommand): Promise<AdmissionResult>;
  transition(transition: SessionTransition): Promise<TransitionResult>;
  history(request: HistoryRequest): Promise<HistoryPage>;
  projectionRead(request: ProjectionReadRequest): Promise<ProjectionRead>;
  dispose(): Promise<void>;
}
