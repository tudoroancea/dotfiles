import type {
  AdmissionResult,
  HistoryEntry,
  HistoryPage,
  HistoryRequest,
  ProjectionRead,
  ProjectionReadRequest,
  SessionHost,
  SessionHostCommand,
  SessionHostEvent,
  SessionHostListener,
  SessionHostState,
  SessionTransition,
  TransitionResult,
} from "../../src/host/session-host.ts";

interface PendingAdmission {
  command: SessionHostCommand;
  resolve: (result: AdmissionResult) => void;
}
export interface FakeSessionHostOptions {
  launchId?: string;
  hostEpoch?: string;
  delayedAdmission?: boolean;
  failDisposal?: boolean;
  history?: HistoryEntry[];
  projectionGate?: Promise<void>;
  modelControl?: ProjectionRead["modelControl"];
  modelGate?: Promise<void>;
  rotateModelEpochOnModelChange?: boolean;
}

export class FakeSessionHost implements SessionHost {
  #listeners = new Set<SessionHostListener>();
  #pending = new Map<string, PendingAdmission>();
  #history: HistoryEntry[];
  #nextSession = 1;
  #delayedAdmission: boolean;
  #failDisposal: boolean;
  #disposePromise?: Promise<void>;
  #projectionGate?: Promise<void>;
  #modelControl?: ProjectionRead["modelControl"];
  #modelGate?: Promise<void>;
  #rotateModelEpochOnModelChange: boolean;
  #state: SessionHostState;
  readonly events: SessionHostEvent[] = [];
  readonly invokedCommands: SessionHostCommand[] = [];

  constructor(options: FakeSessionHostOptions = {}) {
    this.#delayedAdmission = options.delayedAdmission ?? false;
    this.#failDisposal = options.failDisposal ?? false;
    this.#history = [...(options.history ?? [])];
    this.#projectionGate = options.projectionGate;
    this.#modelControl = options.modelControl;
    this.#modelGate = options.modelGate;
    this.#rotateModelEpochOnModelChange = options.rotateModelEpochOnModelChange ?? false;
    this.#state = {
      launchId: options.launchId ?? "launch-1",
      hostEpoch: options.hostEpoch ?? "host-1",
      sessionEpoch: "session-1",
      lifecycle: "unloaded",
      ready: false,
      running: false,
      settled: true,
      pendingMessages: 0,
      queueCount: 0,
      queueBytes: 0,
      dialog: null,
      model: null,
      thinkingLevel: "off",
      identity: null,
    };
  }
  get state(): SessionHostState {
    return structuredClone(this.#state);
  }
  get pendingAdmissions(): readonly string[] {
    return [...this.#pending.keys()];
  }
  subscribe(listener: SessionHostListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  commands() {
    return [{ name: "fake", description: "Fake command", source: "extension" as const }] as const;
  }
  #emit(event: SessionHostEvent): void {
    this.events.push(structuredClone(event));
    for (const listener of this.#listeners) listener(structuredClone(event));
  }
  #patch(patch: Partial<SessionHostState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#emit({ type: "state", state: this.state });
  }
  load(
    identity: { sessionId: string; sessionFile: string | null } = {
      sessionId: "fake-1",
      sessionFile: null,
    },
  ): void {
    this.#patch({ lifecycle: "loading", ready: false });
    this.#patch({ lifecycle: "ready", ready: true, identity });
  }
  command(command: SessionHostCommand): Promise<AdmissionResult> {
    if (
      !this.#state.ready ||
      ["transitioning", "unloading", "restarting", "failed", "stopped"].includes(
        this.#state.lifecycle,
      )
    )
      return this.#admit({
        status: "rejected",
        commandId: command.commandId,
        code: "host_not_ready",
        message: "Host is not ready",
      });
    if (this.#pending.has(command.commandId))
      return this.#admit({
        status: "rejected",
        commandId: command.commandId,
        code: "duplicate",
        message: "Command is already pending",
      });
    this.invokedCommands.push(structuredClone(command));
    if (command.type === "abort") {
      this.#patch({ running: false, settled: true, lifecycle: "ready", pendingMessages: 0 });
      return this.#admit({ status: "accepted", commandId: command.commandId });
    }
    if (command.type === "set_model") {
      const apply = () => {
        this.#patch({
          ...(this.#rotateModelEpochOnModelChange
            ? { sessionEpoch: `session-${++this.#nextSession}` }
            : {}),
          model: { provider: command.provider, id: command.model },
        });
        this.#emit({ type: "model", model: this.#state.model });
        return this.#admit({ status: "handled" as const, commandId: command.commandId });
      };
      return this.#modelGate ? this.#modelGate.then(apply) : apply();
    }
    if (command.type === "set_thinking") {
      this.#patch({ thinkingLevel: command.level });
      this.#emit({ type: "thinking", level: command.level });
      return this.#admit({ status: "handled", commandId: command.commandId });
    }
    if (command.type === "dialog_response" || command.type === "dialog_cancel") {
      if (this.#state.dialog?.id !== command.dialogId)
        return this.#admit({
          status: "rejected",
          commandId: command.commandId,
          code: "dialog_stale",
          message: "Dialog is no longer active",
        });
      this.#patch({ dialog: null });
      this.#emit({ type: "dialog", dialog: null });
      return this.#admit({ status: "handled", commandId: command.commandId });
    }
    if (command.type === "steer" || command.type === "follow_up") {
      const bytes = Buffer.byteLength(command.text);
      this.#patch({
        queueCount: this.#state.queueCount + 1,
        queueBytes: this.#state.queueBytes + bytes,
      });
      this.#emit({ type: "queue", count: this.#state.queueCount, bytes: this.#state.queueBytes });
      return this.#admit({ status: "queued", commandId: command.commandId });
    }
    if (this.#delayedAdmission) {
      return new Promise((resolve) => this.#pending.set(command.commandId, { command, resolve }));
    }
    return this.#admit(
      { status: command.type === "compact" ? "handled" : "accepted", commandId: command.commandId },
      command,
    );
  }
  #admit(result: AdmissionResult, command?: SessionHostCommand): Promise<AdmissionResult> {
    this.#emit({ type: "admission", result });
    if ((result.status === "accepted" || result.status === "handled") && command?.type === "prompt")
      this.#patch({ running: true, settled: false, lifecycle: "running" });
    return Promise.resolve(result);
  }
  resolveAdmission(
    commandId: string,
    status: "accepted" | "handled" | "rejected" = "accepted",
  ): void {
    const pending = this.#pending.get(commandId);
    if (!pending) throw new Error(`No pending admission: ${commandId}`);
    this.#pending.delete(commandId);
    const result: AdmissionResult =
      status === "rejected"
        ? { status, commandId, code: "fake_rejection", message: "Rejected by fake host" }
        : { status, commandId };
    void this.#admit(result, pending.command).then(pending.resolve);
  }
  loseHost(ambiguous = true): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    this.#patch({
      lifecycle: "failed",
      ready: false,
      running: false,
      failure: { code: "host_lost", message: "Fake host was lost", ambiguous },
    });
    for (const item of pending) {
      const result: AdmissionResult = ambiguous
        ? {
            status: "ambiguous",
            commandId: item.command.commandId,
            message: "Admission outcome is unknown",
          }
        : {
            status: "rejected",
            commandId: item.command.commandId,
            code: "host_lost",
            message: "Host was lost before admission",
          };
      this.#emit({ type: "admission", result });
      item.resolve(result);
    }
    this.#emit({
      type: "host_lost",
      ambiguousCommandId: ambiguous ? pending[0]?.command.commandId : undefined,
    });
  }
  streamMessage(
    commandId: string,
    chunks: readonly string[],
    tool?: { id: string; name: string },
  ): void {
    const messageId = `message-${commandId}`;
    this.#emit({ type: "message_start", messageId, role: "assistant" });
    for (const text of chunks) this.#emit({ type: "message_delta", messageId, text });
    if (tool) {
      this.#emit({ type: "tool_start", toolCallId: tool.id, name: tool.name });
      this.#emit({ type: "tool_update", toolCallId: tool.id, update: "running" });
      this.#emit({ type: "tool_end", toolCallId: tool.id, output: "done" });
    }
    this.#emit({ type: "message_end", messageId, role: "assistant" });
  }
  settle(commandId: string, outcome: "completed" | "failed" | "aborted" = "completed"): void {
    this.#emit({ type: "command_completed", commandId, outcome });
    this.#patch({
      running: false,
      settled: true,
      lifecycle: "ready",
      queueCount: 0,
      queueBytes: 0,
    });
    this.#emit({ type: "settled" });
  }
  openDialog(id = "dialog-1", kind: "select" | "confirm" | "input" | "editor" = "confirm"): void {
    this.#patch({ dialog: { id, kind } });
    this.#emit({ type: "dialog", dialog: this.#state.dialog });
  }
  durableChange(): void {
    this.#emit({ type: "durable_change" });
  }
  compact(phase: "started" | "completed" | "failed"): void {
    this.#emit({ type: "compaction", phase });
  }
  async transition(transition: SessionTransition): Promise<TransitionResult> {
    this.#patch({
      lifecycle:
        transition.type === "unload"
          ? "unloading"
          : transition.type === "restart"
            ? "restarting"
            : "transitioning",
      ready: false,
    });
    this.#emit({ type: "transition", phase: "started", transition });
    if (transition.type === "unload") {
      this.#patch({ lifecycle: "unloaded", identity: null, running: false, settled: true });
      this.#emit({ type: "transition", phase: "completed", transition });
      return { status: "completed" };
    }
    this.#nextSession += 1;
    const identity = {
      sessionId: `fake-${this.#nextSession}`,
      sessionFile:
        "sessionFile" in transition && typeof transition.sessionFile === "string"
          ? transition.sessionFile
          : `/fake/session-${this.#nextSession}.jsonl`,
    };
    this.#state = {
      ...this.#state,
      hostEpoch:
        transition.type === "restart" || transition.type === "replace"
          ? `host-${this.#nextSession}`
          : this.#state.hostEpoch,
      sessionEpoch: `session-${this.#nextSession}`,
    };
    this.#patch({ lifecycle: "ready", ready: true, identity, failure: undefined });
    this.#emit({ type: "transition", phase: "completed", transition });
    return { status: "completed", identity };
  }
  appendHistory(...entries: HistoryEntry[]): void {
    this.#history.push(...structuredClone(entries));
  }
  replaceHistory(entries: HistoryEntry[]): void {
    this.#history = structuredClone(entries);
  }
  async projectionRead(request: ProjectionReadRequest): Promise<ProjectionRead> {
    await this.#projectionGate;
    const end = this.#history.length;
    const start = Math.max(0, end - request.maxEntries);
    const entries: HistoryEntry[] = [];
    let bytes = 2;
    for (let index = end - 1; index >= start; index -= 1) {
      const entry = structuredClone(this.#history[index]!);
      let size = 0;
      try {
        size = Buffer.byteLength(JSON.stringify(entry)) + (entries.length ? 1 : 0);
      } catch {
        size = 128;
      }
      if (bytes + size > request.byteLimit) break;
      entries.unshift(entry);
      bytes += size;
    }
    const omitted = end - entries.length;
    return {
      sessionEpoch: this.#state.sessionEpoch,
      entries,
      beforeCursor: omitted > 0 ? String(omitted) : null,
      hasMore: omitted > 0,
      queue: [],
      ...(this.#modelControl === undefined
        ? {}
        : { modelControl: structuredClone(this.#modelControl) }),
    };
  }
  async history(request: HistoryRequest): Promise<HistoryPage> {
    const start = request.cursor === undefined ? 0 : Number.parseInt(request.cursor, 10);
    const entries: HistoryEntry[] = [];
    let bytes = 2;
    for (const entry of this.#history.slice(start, start + request.limit)) {
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (bytes + size > request.byteLimit) break;
      entries.push(structuredClone(entry));
      bytes += size;
    }
    const next = start + entries.length;
    return {
      entries,
      nextCursor: next < this.#history.length ? String(next) : null,
      degraded: next < Math.min(this.#history.length, start + request.limit),
      omittedEntries: this.#history.length - next,
    };
  }
  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposePromise = (async () => {
      this.#patch({ lifecycle: "stopping", ready: false });
      const errors = this.#failDisposal ? ["Injected disposal failure"] : [];
      this.#emit({ type: "disposed", success: errors.length === 0, errors });
      this.#patch({
        lifecycle: errors.length === 0 ? "stopped" : "failed",
        failure:
          errors.length === 0
            ? undefined
            : { code: "dispose_failed", message: errors[0]!, ambiguous: false },
      });
      this.#listeners.clear();
      if (errors.length > 0)
        throw new AggregateError(
          errors.map((message) => new Error(message)),
          "Fake host disposal failed",
        );
    })();
    return this.#disposePromise;
  }
}
