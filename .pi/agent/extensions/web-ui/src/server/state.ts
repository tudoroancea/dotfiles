import { Buffer } from "node:buffer";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LIMITS } from "../shared/limits.js";
import { PROTOCOL_VERSION } from "../shared/wire.js";
import type {
  HistoryPageCommand,
  HistoryPageMessage,
  LiveState,
  ProjectedMessage,
  SessionMetadata,
  SessionState,
  SnapshotMessage,
  StatePatch,
  StateUpdateMessage,
  ToolExecution,
} from "../shared/wire.js";
import { projectJson, projectMessage, projectMetadata, projectToolResult } from "./projection.js";
import { HistoryManager } from "./history.js";

const MAX_FINALIZED_OVERLAYS = 8;
const MAX_LIVE_TOOLS = 32;
const MAX_LIVE_STATE_BYTES = 4 * 1024 * 1024;

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export interface ToolStartEventLike {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolUpdateEventLike extends ToolStartEventLike {
  partialResult: unknown;
}

export interface ToolEndEventLike {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

export class SessionStateStore {
  readonly generation: string;
  private revisionValue = 0;
  private readonly history: HistoryManager;
  private persistedState;
  private metadataState: SessionMetadata;
  private isRunning: boolean;
  private partialAssistant: ProjectedMessage | undefined;
  private finalizedMessages: ProjectedMessage[] = [];
  private readonly tools = new Map<string, ToolExecution>();
  private nextToolOrdinal = 0;

  constructor(context: ExtensionContext, generation: string, activeTools: readonly string[] = []) {
    this.generation = generation;
    this.history = new HistoryManager(context, generation);
    this.persistedState = this.history.window();
    this.metadataState = projectMetadata(context, activeTools);
    this.isRunning = !context.isIdle();
  }

  get revision(): number {
    return this.revisionValue;
  }

  state(): SessionState {
    return {
      persisted: this.persistedState,
      live: this.liveState(),
      metadata: this.metadataState,
    };
  }

  snapshot(commandId?: string): SnapshotMessage {
    const state = this.boundedSnapshotState(commandId);
    return {
      type: "snapshot",
      protocolVersion: PROTOCOL_VERSION,
      generation: this.generation,
      revision: this.revisionValue,
      ...(commandId ? { commandId } : {}),
      state,
    };
  }

  historyPage(command: HistoryPageCommand): HistoryPageMessage {
    return this.history.page(command, this.revisionValue);
  }

  rotateHistory(context: ExtensionContext): StateUpdateMessage | undefined {
    this.history.refresh(true);
    return this.reconcileProjected(context, {}, true);
  }

  agentStart(): StateUpdateMessage | undefined {
    const next: LiveState = {
      isRunning: true,
      finalizedMessages: [],
      tools: [],
    };
    const metadata = { ...this.metadataState, isIdle: false };
    if (equal(next, this.liveState()) && equal(metadata, this.metadataState)) return undefined;
    this.applyLive(next);
    this.metadataState = metadata;
    return this.commit({ live: next, metadata });
  }

  messageStart(message: unknown): StateUpdateMessage | undefined {
    const projected = projectMessage(message);
    if (projected.role === "assistant" || projected.role === "toolResult") return undefined;
    return this.upsertFinalizedMessage(projected);
  }

  messageUpdate(message: unknown): StateUpdateMessage | undefined {
    const projected = projectMessage(message);
    if (projected.role !== "assistant") return undefined;
    const next = this.liveState();
    next.isRunning = true;
    next.partialAssistant = projected;
    return this.replaceLive(next);
  }

  messageEnd(message: unknown): StateUpdateMessage | undefined {
    const projected = projectMessage(message);
    const next = this.liveState();
    if (projected.role === "assistant") delete next.partialAssistant;
    const key = this.messageKey(projected);
    const existingIndex = next.finalizedMessages.findIndex(
      (candidate) => this.messageKey(candidate) === key,
    );
    if (existingIndex >= 0) next.finalizedMessages[existingIndex] = projected;
    else next.finalizedMessages = [...next.finalizedMessages, projected];
    next.finalizedMessages = next.finalizedMessages.slice(-MAX_FINALIZED_OVERLAYS);
    return this.replaceLive(next);
  }

  toolStart(event: ToolStartEventLike): StateUpdateMessage | undefined {
    const existing = this.tools.get(event.toolCallId);
    const tool: ToolExecution = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ordinal: existing?.ordinal ?? this.nextToolOrdinal++,
      status: "running",
      args: projectJson(event.args),
      isError: false,
      ...(existing?.result === undefined ? {} : { result: existing.result }),
    };
    if (existing && equal(existing, tool) && this.isRunning) return undefined;
    this.setTool(tool);
    this.isRunning = true;
    return this.commit({ live: this.liveState() });
  }

  toolUpdate(event: ToolUpdateEventLike): StateUpdateMessage | undefined {
    const existing = this.tools.get(event.toolCallId);
    const tool: ToolExecution = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ordinal: existing?.ordinal ?? this.nextToolOrdinal++,
      status: "running",
      args: projectJson(event.args),
      result: projectToolResult(event.partialResult),
      isError: false,
    };
    if (existing && equal(existing, tool) && this.isRunning) return undefined;
    this.setTool(tool);
    this.isRunning = true;
    return this.commit({ live: this.liveState() });
  }

  toolEnd(event: ToolEndEventLike): StateUpdateMessage | undefined {
    const existing = this.tools.get(event.toolCallId);
    const tool: ToolExecution = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ordinal: existing?.ordinal ?? this.nextToolOrdinal++,
      status: event.isError ? "error" : "completed",
      args: existing?.args ?? null,
      result: projectToolResult(event.result),
      isError: event.isError,
    };
    if (existing && equal(existing, tool)) return undefined;
    this.setTool(tool);
    return this.commit({ live: this.liveState() });
  }

  updateMetadata(
    context: ExtensionContext,
    activeTools: readonly string[] = this.metadataState.activeTools,
  ): StateUpdateMessage | undefined {
    const metadata = projectMetadata(context, activeTools);
    if (equal(metadata, this.metadataState)) return undefined;
    this.metadataState = metadata;
    return this.commit({ metadata });
  }

  reconcile(
    context: ExtensionContext,
    options: { settled?: boolean; activeTools?: readonly string[] } = {},
  ): StateUpdateMessage | undefined {
    this.history.refresh();
    return this.reconcileProjected(context, options);
  }

  private reconcileProjected(
    context: ExtensionContext,
    options: { settled?: boolean; activeTools?: readonly string[] } = {},
    forceCostRefresh = false,
  ): StateUpdateMessage | undefined {
    const persisted = this.history.window();
    const persistedChanged = !equal(persisted, this.persistedState);
    const metadata = this.projectReconciledMetadata(
      context,
      options.activeTools ?? this.metadataState.activeTools,
      forceCostRefresh || persistedChanged,
    );
    const patch: StatePatch = {};
    if (persistedChanged) {
      this.persistedState = persisted;
      patch.persisted = persisted;
    }
    if (!equal(metadata, this.metadataState)) {
      this.metadataState = metadata;
      patch.metadata = metadata;
    }
    if (options.settled) {
      const settledLive: LiveState = {
        isRunning: false,
        finalizedMessages: [],
        tools: [],
      };
      if (!equal(settledLive, this.liveState())) {
        this.applyLive(settledLive);
        patch.live = settledLive;
      }
    }
    return Object.keys(patch).length === 0 ? undefined : this.commit(patch);
  }

  private projectReconciledMetadata(
    context: ExtensionContext,
    activeTools: readonly string[],
    refreshCost: boolean,
  ): SessionMetadata {
    if (refreshCost) return projectMetadata(context, activeTools);

    // Metadata changes are hot while a session is running. Avoid walking the
    // complete branch solely to rediscover an unchanged cost; persisted
    // changes (including strict appends and rotations) refresh it exactly.
    const emptyBranchManager = new Proxy(context.sessionManager, {
      get(target, property, receiver) {
        if (property === "getBranch") return () => [];
        return Reflect.get(target, property, receiver);
      },
    });
    const metadataContext = new Proxy(context, {
      get(target, property, receiver) {
        if (property === "sessionManager") return emptyBranchManager;
        return Reflect.get(target, property, receiver);
      },
    });
    const metadata = projectMetadata(metadataContext, activeTools);
    if (this.metadataState.sessionCost === undefined) delete metadata.sessionCost;
    else metadata.sessionCost = this.metadataState.sessionCost;
    return metadata;
  }

  private boundedSnapshotState(commandId?: string): SessionState {
    const source = this.state();
    const state: SessionState = {
      persisted: {
        ...source.persisted,
        entries: [...source.persisted.entries],
      },
      live: {
        ...source.live,
        finalizedMessages: [...source.live.finalizedMessages],
        tools: [...source.live.tools],
      },
      metadata: source.metadata,
    };
    const size = () =>
      Buffer.byteLength(
        JSON.stringify({
          type: "snapshot",
          protocolVersion: PROTOCOL_VERSION,
          generation: this.generation,
          revision: this.revisionValue,
          ...(commandId ? { commandId } : {}),
          state,
        }),
      );
    while (size() > LIMITS.snapshotBytes) {
      if (state.live.finalizedMessages.length > 0) {
        state.live.finalizedMessages.shift();
        continue;
      }
      if (state.live.tools.length > 0) {
        const completed = state.live.tools.findIndex((tool) => tool.status !== "running");
        state.live.tools.splice(completed >= 0 ? completed : 0, 1);
        continue;
      }
      if (state.live.partialAssistant) {
        delete state.live.partialAssistant;
        continue;
      }
      throw new Error("Session snapshot exceeds the transport limit");
    }
    return state;
  }

  private upsertFinalizedMessage(projected: ProjectedMessage): StateUpdateMessage | undefined {
    const next = this.liveState();
    const key = this.messageKey(projected);
    const index = next.finalizedMessages.findIndex(
      (candidate) => this.messageKey(candidate) === key,
    );
    if (index >= 0) {
      if (equal(next.finalizedMessages[index], projected)) return undefined;
      next.finalizedMessages[index] = projected;
    } else {
      next.finalizedMessages = [...next.finalizedMessages, projected];
    }
    next.finalizedMessages = next.finalizedMessages.slice(-MAX_FINALIZED_OVERLAYS);
    return this.replaceLive(next);
  }

  private messageKey(message: ProjectedMessage): string {
    return [
      message.role,
      message.timestamp ?? "",
      message.toolCallId ?? "",
      message.customType ?? "",
    ].join(":");
  }

  private setTool(tool: ToolExecution): void {
    this.tools.set(tool.toolCallId, tool);
    while (
      this.tools.size > MAX_LIVE_TOOLS ||
      Buffer.byteLength(JSON.stringify(this.liveState())) > MAX_LIVE_STATE_BYTES
    ) {
      const ordered = [...this.tools.values()].sort((left, right) => left.ordinal - right.ordinal);
      const removable = ordered.find((candidate) => candidate.status !== "running") ?? ordered[0];
      if (!removable) return;
      this.tools.delete(removable.toolCallId);
    }
  }

  private replaceLive(next: LiveState): StateUpdateMessage | undefined {
    if (equal(next, this.liveState())) return undefined;
    this.applyLive(next);
    return this.commit({ live: next });
  }

  private applyLive(next: LiveState): void {
    this.isRunning = next.isRunning;
    this.partialAssistant = next.partialAssistant;
    this.finalizedMessages = [...next.finalizedMessages];
    this.tools.clear();
    for (const tool of next.tools) this.tools.set(tool.toolCallId, tool);
    this.nextToolOrdinal = Math.max(0, ...next.tools.map((tool) => tool.ordinal + 1));
  }

  private liveState(): LiveState {
    return {
      isRunning: this.isRunning,
      ...(this.partialAssistant ? { partialAssistant: this.partialAssistant } : {}),
      finalizedMessages: [...this.finalizedMessages],
      tools: [...this.tools.values()].sort((left, right) => left.ordinal - right.ordinal),
    };
  }

  private commit(patch: StatePatch): StateUpdateMessage {
    const baseRevision = this.revisionValue;
    this.revisionValue += 1;
    return {
      type: "state_update",
      protocolVersion: PROTOCOL_VERSION,
      generation: this.generation,
      baseRevision,
      revision: this.revisionValue,
      patch,
    };
  }
}

export function mergeStateUpdates(
  first: StateUpdateMessage,
  second: StateUpdateMessage,
): StateUpdateMessage {
  if (first.generation !== second.generation || first.revision !== second.baseRevision) {
    throw new Error("State updates are not contiguous");
  }
  return {
    type: "state_update",
    protocolVersion: PROTOCOL_VERSION,
    generation: first.generation,
    baseRevision: first.baseRevision,
    revision: second.revision,
    patch: { ...first.patch, ...second.patch },
  };
}
