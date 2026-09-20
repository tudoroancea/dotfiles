import { describe, expect, it } from "vitest";
import type { SdkBundleHandle } from "../../src/host/sdk-bundle.ts";
import { SdkSessionHost } from "../../src/host/sdk-host.ts";
import { LiveProjection } from "../../src/projection/live-projection.ts";
import { SDK_PROJECTION_LIMITS } from "../../src/observability/sdk-projection-bounds.ts";

function bundle(entries: readonly unknown[] = []): SdkBundleHandle {
  return {
    snapshot: () => ({
      identity: { sessionId: "session", sessionFile: "/owned/session.jsonl" },
      idle: true,
      pendingMessages: 0,
      queueBytes: 0,
      model: null,
      thinkingLevel: "off",
      loadedExtensionPaths: [],
      diagnostics: [],
      agentStarts: 0,
      objectIdentities: [],
    }),
    projectionRead: (maxEntries) => ({
      entries: entries.slice(-maxEntries),
      totalEntries: entries.length,
      startIndex: Math.max(0, entries.length - maxEntries),
      queue: [],
    }),
    subscribe: () => () => {},
    commands: () => [],
    prompt: async (_text, _behavior, preflight) => {
      preflight(true);
    },
    steer: async () => {},
    followUp: async () => {},
    abort: async () => {},
    setModel: async () => false,
    setThinking: (level) => level,
    compact: async () => {},
    entries: () => entries,
    dispose: async () => {},
  };
}
async function host(entries: readonly unknown[] = []) {
  return SdkSessionHost.create({
    launchId: "launch",
    cwd: "/canonical",
    repositoryRoot: "/repository",
    bundleFactory: async () => bundle(entries),
  });
}

describe("real SDK host admission and history", () => {
  it("answers from preflight without waiting for eventual completion", async () => {
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => (finish = resolve));
    const owned = bundle();
    let emit: ((event: unknown) => void) | undefined;
    owned.subscribe = (listener) => {
      emit = listener;
      return () => (emit = undefined);
    };
    owned.prompt = async (_text, _behavior, preflight) => {
      preflight(true);
      await completion;
    };
    const sdkHost = await SdkSessionHost.create({
      launchId: "launch",
      cwd: "/canonical",
      repositoryRoot: "/repository",
      bundleFactory: async () => owned,
    });
    const completions: string[] = [];
    sdkHost.subscribe((event) => {
      if (event.type === "command_completed") completions.push(event.outcome);
    });
    await expect(
      sdkHost.command({ type: "prompt", commandId: "prompt", text: "message" }),
    ).resolves.toEqual({ status: "accepted", commandId: "prompt" });
    expect(completions).toEqual([]);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completions).toEqual([]);
    emit?.({ type: "agent_settled" });
    expect(completions).toEqual(["completed"]);
    await sdkHost.dispose();
  });

  it("starts prompt invocation synchronously and cancels late acceptance during disposal", async () => {
    let preflight!: (accepted: boolean) => void;
    let finish!: () => void;
    let promptStarted = false;
    let aborts = 0;
    let finishLateAbort!: () => void;
    const lateAbort = new Promise<void>((resolve) => (finishLateAbort = resolve));
    let bundleDisposed = false;
    const owned = bundle();
    owned.prompt = (_text, _behavior, callback) => {
      promptStarted = true;
      preflight = callback;
      return new Promise<void>((resolve) => (finish = resolve));
    };
    owned.abort = async () => {
      aborts += 1;
      if (aborts > 1) await lateAbort;
    };
    owned.dispose = async () => {
      bundleDisposed = true;
    };
    const sdkHost = await SdkSessionHost.create({
      launchId: "launch",
      cwd: "/canonical",
      repositoryRoot: "/repository",
      bundleFactory: async () => owned,
    });
    const completions: string[] = [];
    sdkHost.subscribe((event) => {
      if (event.type === "command_completed") completions.push(event.outcome);
    });
    const admission = sdkHost.command({ type: "prompt", commandId: "prompt", text: "message" });
    expect(promptStarted).toBe(true);
    const disposal = sdkHost.dispose();
    await expect(admission).resolves.toMatchObject({ status: "ambiguous" });
    preflight(true);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bundleDisposed).toBe(false);
    finishLateAbort();
    await expect(disposal).resolves.toBeUndefined();
    expect(aborts).toBeGreaterThanOrEqual(2);
    expect(completions).toEqual([]);
  });

  it.each(["model", "compact"] as const)(
    "waits for in-flight %s operations before disposing",
    async (operation) => {
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => (finish = resolve));
      let bundleDisposed = false;
      const owned = bundle();
      owned.setModel = async () => {
        await gate;
        return true;
      };
      if (operation === "model") {
        const snapshot = owned.snapshot;
        owned.snapshot = () => ({
          ...snapshot(),
          modelControl: {
            models: [{ provider: "fixture", id: "fixture", name: "Fixture" }],
            thinkingLevels: ["off"],
          },
        });
      }
      owned.compact = async () => {
        await gate;
      };
      owned.dispose = async () => {
        bundleDisposed = true;
      };
      const sdkHost = await SdkSessionHost.create({
        launchId: "launch",
        cwd: "/canonical",
        repositoryRoot: "/repository",
        bundleFactory: async () => owned,
      });
      const admission =
        operation === "model"
          ? sdkHost.command({
              type: "set_model",
              commandId: operation,
              provider: "fixture",
              model: "fixture",
            })
          : sdkHost.command({ type: "compact", commandId: operation });
      const disposal = sdkHost.dispose();
      await Promise.resolve();
      expect(bundleDisposed).toBe(false);
      finish();
      await expect(admission).resolves.toMatchObject({ status: "ambiguous" });
      await expect(disposal).resolves.toBeUndefined();
      expect(bundleDisposed).toBe(true);
    },
  );

  it("marks an accepted prompt aborted when compaction interrupts it", async () => {
    let finishPrompt!: () => void;
    const owned = bundle();
    let emit: ((event: unknown) => void) | undefined;
    owned.subscribe = (listener) => {
      emit = listener;
      return () => (emit = undefined);
    };
    owned.prompt = async (_text, _behavior, preflight) => {
      preflight(true);
      await new Promise<void>((resolve) => (finishPrompt = resolve));
    };
    owned.compact = async () => finishPrompt();
    const sdkHost = await SdkSessionHost.create({
      launchId: "launch",
      cwd: "/canonical",
      repositoryRoot: "/repository",
      bundleFactory: async () => owned,
    });
    const completions: string[] = [];
    sdkHost.subscribe((event) => {
      if (event.type === "command_completed") completions.push(event.outcome);
    });
    await sdkHost.command({ type: "prompt", commandId: "prompt", text: "message" });
    await sdkHost.command({ type: "compact", commandId: "compact" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completions).toEqual([]);
    emit?.({ type: "agent_settled" });
    expect(completions).toEqual(["aborted"]);
    await sdkHost.dispose();
  });

  it("settles duplicate callbacks once and treats missing callbacks as ambiguous", async () => {
    const rejected = bundle();
    rejected.prompt = async (_text, _behavior, preflight) => {
      preflight(false);
      preflight(true);
      throw new Error("preflight rejected");
    };
    const rejectedHost = await SdkSessionHost.create({
      launchId: "launch",
      cwd: "/canonical",
      repositoryRoot: "/repository",
      bundleFactory: async () => rejected,
    });
    const admissions: string[] = [];
    rejectedHost.subscribe((event) => {
      if (event.type === "admission") admissions.push(event.result.status);
    });
    await expect(
      rejectedHost.command({ type: "prompt", commandId: "rejected", text: "message" }),
    ).resolves.toMatchObject({ status: "rejected", code: "preflight_rejected" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(admissions).toEqual(["rejected"]);
    await rejectedHost.dispose();

    const missing = bundle();
    missing.prompt = async () => {};
    const missingHost = await SdkSessionHost.create({
      launchId: "launch",
      cwd: "/canonical",
      repositoryRoot: "/repository",
      bundleFactory: async () => missing,
    });
    await expect(
      missingHost.command({ type: "prompt", commandId: "missing", text: "message" }),
    ).resolves.toMatchObject({ status: "ambiguous" });
    await missingHost.dispose();
  });

  it("settles every accepted and queued command once from the final run outcome", async () => {
    let emit: ((event: unknown) => void) | undefined;
    const owned = bundle();
    owned.subscribe = (listener) => {
      emit = listener;
      return () => (emit = undefined);
    };
    owned.prompt = async (_text, _behavior, preflight) => preflight(true);
    const sdkHost = await SdkSessionHost.create({
      launchId: "launch",
      cwd: "/canonical",
      repositoryRoot: "/repository",
      maxPendingAdmissions: 8,
      bundleFactory: async () => owned,
    });
    const completions: Array<{ commandId: string; outcome: string }> = [];
    sdkHost.subscribe((event) => {
      if (event.type === "command_completed") completions.push(event);
    });

    await sdkHost.command({ type: "prompt", commandId: "first", text: "one" });
    emit?.({ type: "agent_start" });
    await sdkHost.command({ type: "follow_up", commandId: "queued", text: "two" });
    emit?.({
      type: "message_end",
      message: { role: "assistant", timestamp: 1, stopReason: "error", errorMessage: "failed" },
    });
    emit?.({ type: "tool_execution_start", toolCallId: "call", toolName: "read", args: {} });
    emit?.({ type: "tool_execution_end", toolCallId: "call", result: "done", isError: false });
    emit?.({
      type: "message_end",
      message: { role: "assistant", timestamp: 2, stopReason: "aborted" },
    });
    expect(completions).toEqual([]);
    emit?.({ type: "agent_settled" });
    emit?.({ type: "agent_settled" });
    expect(completions).toEqual([
      { commandId: "first", outcome: "aborted", type: "command_completed" },
    ]);
    await expect(
      sdkHost.projectionRead({ maxEntries: 10, byteLimit: 1024 }),
    ).resolves.toMatchObject({
      queue: [{ content: "two", delivery: "followUp", editable: true, itemVersion: 1 }],
    });
    await sdkHost.dispose();
  });

  it("reconciles every raw message boundary before settlement and maps all SDK roles", async () => {
    let emit: ((event: unknown) => void) | undefined;
    let entries: unknown[] = [];
    const owned = bundle();
    owned.subscribe = (listener) => {
      emit = listener;
      return () => (emit = undefined);
    };
    owned.projectionRead = (maxEntries) => ({
      entries: entries.slice(-maxEntries),
      totalEntries: entries.length,
      startIndex: Math.max(0, entries.length - maxEntries),
      queue: [],
    });
    const sdkHost = await SdkSessionHost.create({
      launchId: "launch",
      cwd: "/canonical",
      repositoryRoot: "/repository",
      bundleFactory: async () => owned,
    });
    const projection = await LiveProjection.create(sdkHost, "generation");
    const boundaries: string[] = [];
    sdkHost.subscribe((event) => {
      if (event.type === "message_end") boundaries.push(event.role);
    });

    entries = [{ id: "user", role: "user", content: "one", timestamp: 1 }];
    emit?.({ type: "message_end", message: entries[0] });
    await projection.settled();
    expect(projection.attachment().initial.snapshot.entries.map(({ id }) => id)).toEqual(["user"]);
    entries = [
      ...entries,
      { id: "assistant", role: "assistant", content: [], timestamp: 2, stopReason: "stop" },
      { id: "tool", role: "toolResult", toolCallId: "call", content: [], timestamp: 3 },
    ];
    emit?.({ type: "message_end", message: entries[1] });
    emit?.({ type: "message_end", message: entries[2] });
    await projection.settled();
    expect(projection.attachment().initial.snapshot.entries.map(({ id }) => id)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    expect(boundaries).toEqual(["user", "assistant", "tool"]);

    entries = [...entries, { id: "custom", type: "custom", payload: true, timestamp: 4 }];
    emit?.({ type: "entry_appended", entry: entries.at(-1) });
    await projection.settled();
    expect(projection.attachment().initial.snapshot.entries.at(-1)?.id).toBe("custom");

    projection.dispose();
    await sdkHost.dispose();
  });

  it("discovers sanitized commands and classifies canonical slash execution as handled", async () => {
    const owned = bundle();
    owned.commands = () => [{ name: "status", description: "Show status", source: "extension" }];
    const sdkHost = await SdkSessionHost.create({
      launchId: "launch",
      cwd: "/canonical",
      repositoryRoot: "/repository",
      bundleFactory: async () => owned,
    });
    expect(sdkHost.commands()).toEqual([
      { name: "status", description: "Show status", source: "extension" },
    ]);
    await expect(
      sdkHost.command({ type: "prompt", commandId: "slash", text: "/status" }),
    ).resolves.toEqual({ status: "handled", commandId: "slash" });
    await sdkHost.dispose();
  });

  it.each([
    ["prompt", "accepted"],
    ["steer", "accepted"],
    ["follow_up", "accepted"],
  ] as const)("returns authoritative %s preflight as %s", async (type, status) => {
    const sdkHost = await host();
    await expect(sdkHost.command({ type, commandId: type, text: "message" })).resolves.toEqual({
      status,
      commandId: type,
    });
    await sdkHost.dispose();
  });

  it("retries retained bundle disposal after a transient failure", async () => {
    let attempts = 0;
    const owned = bundle();
    owned.dispose = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient disposal failure");
    };
    const sdkHost = await SdkSessionHost.create({
      launchId: "launch",
      cwd: "/canonical",
      repositoryRoot: "/repository",
      bundleFactory: async () => owned,
    });
    await expect(sdkHost.dispose()).rejects.toThrow("SDK host disposal failed");
    await expect(sdkHost.dispose()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("rejects absent and exact unadvertised model-control targets", async () => {
    const owned = bundle();
    let capability: ReturnType<SdkBundleHandle["snapshot"]>["modelControl"];
    const snapshot = owned.snapshot;
    owned.snapshot = () => ({ ...snapshot(), ...(capability ? { modelControl: capability } : {}) });
    let modelMutations = 0;
    let thinkingMutations = 0;
    owned.setModel = async () => {
      modelMutations += 1;
      return true;
    };
    owned.setThinking = (level) => {
      thinkingMutations += 1;
      return level;
    };
    const sdkHost = await SdkSessionHost.create({
      launchId: "launch",
      cwd: "/canonical",
      repositoryRoot: "/repository",
      bundleFactory: async () => owned,
    });
    await expect(
      sdkHost.command({ type: "set_model", commandId: "off-model", provider: "p", model: "m" }),
    ).resolves.toMatchObject({ status: "rejected", code: "capability_off" });
    await expect(
      sdkHost.command({ type: "set_thinking", commandId: "off-level", level: "max" }),
    ).resolves.toMatchObject({ status: "rejected", code: "capability_off" });
    capability = {
      models: [{ provider: "p", id: "advertised", name: "Advertised" }],
      thinkingLevels: ["off"],
    };
    await expect(
      sdkHost.command({ type: "set_model", commandId: "bad-model", provider: "p", model: "m" }),
    ).resolves.toMatchObject({ status: "rejected", code: "invalid_control" });
    await expect(
      sdkHost.command({ type: "set_thinking", commandId: "bad-level", level: "max" }),
    ).resolves.toMatchObject({ status: "rejected", code: "invalid_control" });
    expect({ modelMutations, thinkingMutations }).toEqual({
      modelMutations: 0,
      thinkingMutations: 0,
    });
    capability.thinkingLevels.push("max");
    await expect(
      sdkHost.command({ type: "set_thinking", commandId: "max", level: "max" }),
    ).resolves.toMatchObject({ status: "handled" });
    expect(thinkingMutations).toBe(1);
    await sdkHost.dispose();
  });

  it("handles authoritative current model controls without mutation or durable events", async () => {
    const owned = bundle();
    const snapshot = owned.snapshot;
    owned.snapshot = () => ({
      ...snapshot(),
      model: { provider: "provider", id: "model" },
      thinkingLevel: "high",
      modelControl: {
        models: [{ provider: "provider", id: "model", name: "Model" }],
        thinkingLevels: ["high"],
      },
    });
    let modelMutations = 0;
    let thinkingMutations = 0;
    owned.setModel = async () => {
      modelMutations += 1;
      return true;
    };
    owned.setThinking = (level) => {
      thinkingMutations += 1;
      return level;
    };
    const sdkHost = await SdkSessionHost.create({
      launchId: "launch",
      cwd: "/canonical",
      repositoryRoot: "/repository",
      bundleFactory: async () => owned,
    });
    const initialEpoch = sdkHost.state.sessionEpoch;
    const events: string[] = [];
    sdkHost.subscribe((event) => events.push(event.type));

    await expect(
      sdkHost.command({
        type: "set_model",
        commandId: "same-model",
        provider: "provider",
        model: "model",
      }),
    ).resolves.toMatchObject({ status: "handled" });
    await expect(
      sdkHost.command({ type: "set_thinking", commandId: "same-thinking", level: "high" }),
    ).resolves.toMatchObject({ status: "handled" });

    expect({ modelMutations, thinkingMutations }).toEqual({
      modelMutations: 0,
      thinkingMutations: 0,
    });
    expect(
      events.filter((type) => ["model", "thinking", "durable_change", "state"].includes(type)),
    ).toEqual([]);
    expect(sdkHost.state.sessionEpoch).toBe(initialEpoch);
    await sdkHost.dispose();
  });

  it("fails old-epoch runs before model epoch rotation and permits command ID reuse", async () => {
    const owned = bundle();
    let listener: ((event: unknown) => void) | undefined;
    owned.subscribe = (next) => {
      listener = next;
      return () => (listener = undefined);
    };
    let model = { provider: "provider", id: "old" };
    const snapshot = owned.snapshot;
    owned.snapshot = () => ({
      ...snapshot(),
      model,
      modelControl: {
        models: [
          { provider: "provider", id: "old", name: "Old" },
          { provider: "provider", id: "new", name: "New" },
        ],
        thinkingLevels: ["off"],
      },
    });
    owned.setModel = async (provider, id) => {
      model = { provider, id };
      return true;
    };
    const promptFinishes: Array<() => void> = [];
    owned.prompt = async (_text, _behavior, preflight) => {
      preflight(true);
      await new Promise<void>((resolve) => promptFinishes.push(resolve));
    };
    const sdkHost = await SdkSessionHost.create({
      launchId: "launch",
      cwd: "/canonical",
      repositoryRoot: "/repository",
      bundleFactory: async () => owned,
    });
    const projection = await LiveProjection.create(sdkHost, "generation");
    const completions: Array<{
      commandId: string;
      commandEpoch: string;
      status: string;
      error?: string;
    }> = [];
    projection.attachment().subscribe((envelope) => {
      if (envelope.type === "command-completion") completions.push(envelope);
    });
    const oldEpoch = sdkHost.state.sessionEpoch;
    await sdkHost.command({ type: "prompt", commandId: "reused", text: "old run" });
    listener?.({ type: "agent_start" });

    await sdkHost.command({
      type: "set_model",
      commandId: "model-change",
      provider: "provider",
      model: "new",
    });
    const newEpoch = sdkHost.state.sessionEpoch;
    expect(newEpoch).not.toBe(oldEpoch);
    expect(completions).toEqual([
      {
        version: 1,
        type: "command-completion",
        commandId: "reused",
        generation: "generation",
        commandEpoch: oldEpoch,
        revision: expect.any(Number),
        status: "failed",
        error: "Model changed",
      },
    ]);

    promptFinishes.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener?.({ type: "agent_settled" });
    expect(completions).toHaveLength(1);

    await expect(
      sdkHost.command({ type: "prompt", commandId: "reused", text: "new run" }),
    ).resolves.toMatchObject({ status: "accepted" });
    listener?.({ type: "agent_start" });
    promptFinishes.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener?.({ type: "agent_settled" });
    expect(completions.at(-1)).toMatchObject({
      commandId: "reused",
      commandEpoch: newEpoch,
      status: "completed",
    });
    expect(completions).toHaveLength(2);

    projection.dispose();
    await sdkHost.dispose();
  });

  it("projects authoritative real-host queue, model, and thinking state", async () => {
    let listener: ((event: unknown) => void) | undefined;
    let queue: Array<{ id: string; content: string; delivery: "steer" | "followUp" }> = [];
    const owned = bundle();
    owned.subscribe = (next) => {
      listener = next;
      return () => (listener = undefined);
    };
    owned.projectionRead = () => ({
      entries: [],
      totalEntries: 0,
      startIndex: 0,
      queue,
    });
    let effectiveModel: { provider: string; id: string } | null = null;
    const baseSnapshot = owned.snapshot;
    owned.snapshot = () => ({
      ...baseSnapshot(),
      model: effectiveModel,
      modelControl: {
        models: [{ provider: "fixture", id: "model", name: "model" }],
        thinkingLevels: ["off" as const, "high" as const],
      },
    });
    owned.setModel = async (provider, model) => {
      effectiveModel = { provider, id: model };
      return true;
    };
    owned.setThinking = () => "medium";
    const sdkHost = await SdkSessionHost.create({
      launchId: "launch",
      cwd: "/canonical",
      repositoryRoot: "/repository",
      bundleFactory: async () => owned,
    });
    const initialEpoch = sdkHost.state.sessionEpoch;
    const projection = await LiveProjection.create(sdkHost, "generation");
    queue = [{ id: "queued", content: "next", delivery: "followUp" }];
    listener?.({ type: "queue_update", steering: [], followUp: ["next"] });
    await projection.settled();
    await sdkHost.command({
      type: "set_model",
      commandId: "model",
      provider: "fixture",
      model: "model",
    });
    await expect(
      sdkHost.command({ type: "set_thinking", commandId: "thinking", level: "high" }),
    ).resolves.toMatchObject({ status: "rejected", code: "invalid_control" });
    await projection.settled();

    expect(sdkHost.state.sessionEpoch).not.toBe(initialEpoch);
    expect(projection.attachment().initial.snapshot).toMatchObject({
      commandEpoch: sdkHost.state.sessionEpoch,
      modelControl: {
        models: [{ provider: "fixture", id: "model", name: "model" }],
        thinkingLevels: ["off", "high"],
      },
      queue: [{ id: "queued", content: "next", delivery: "followUp" }],
      metadata: {
        model: { provider: "fixture", id: "model", name: "model" },
        thinkingLevel: "medium",
      },
    });
    listener?.({ type: "thinking_level_changed", level: "low" });
    expect(sdkHost.state.thinkingLevel).toBe("low");
    projection.dispose();
    await sdkHost.dispose();
  });

  it("emits canonical message starts once for real SDK message updates", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const owned = bundle();
    owned.subscribe = (next) => {
      listener = next;
      return () => (listener = undefined);
    };
    const sdkHost = await SdkSessionHost.create({
      launchId: "launch",
      cwd: "/canonical",
      repositoryRoot: "/repository",
      bundleFactory: async () => owned,
    });
    const events: string[] = [];
    sdkHost.subscribe((event) => events.push(event.type));
    listener?.({
      type: "message_update",
      message: { id: "assistant-1" },
      assistantMessageEvent: { type: "text_delta", delta: "one" },
    });
    listener?.({
      type: "message_update",
      message: { id: "assistant-1" },
      assistantMessageEvent: { type: "text_delta", delta: "two" },
    });
    expect(events).toEqual(["message_start", "message_delta", "message_delta"]);
    await sdkHost.dispose();
  });

  it("uses resumed model and effective post-set thinking as authoritative state", async () => {
    const owned = bundle();
    owned.snapshot = () => ({
      identity: { sessionId: "session", sessionFile: "/owned/session.jsonl" },
      idle: true,
      pendingMessages: 0,
      queueBytes: 0,
      model: { provider: "resumed", id: "current" },
      thinkingLevel: "high",
      loadedExtensionPaths: [],
      diagnostics: [],
      agentStarts: 0,
      objectIdentities: [],
      modelControl: {
        models: [{ provider: "resumed", id: "current", name: "Current" }],
        thinkingLevels: ["xhigh"],
      },
    });
    owned.setThinking = () => "low";
    const sdkHost = await SdkSessionHost.create({
      launchId: "launch",
      cwd: "/canonical",
      repositoryRoot: "/repository",
      bundleFactory: async () => owned,
    });
    expect(sdkHost.state).toMatchObject({
      model: { provider: "resumed", id: "current" },
      thinkingLevel: "high",
    });
    await expect(
      sdkHost.command({ type: "set_thinking", commandId: "thinking", level: "xhigh" }),
    ).resolves.toMatchObject({ status: "rejected", code: "invalid_control" });
    expect(sdkHost.state.thinkingLevel).toBe("low");
    await sdkHost.dispose();
  });

  it("reads the latest active-branch window chronologically with explicit placeholders", async () => {
    const sdkHost = await host([
      { id: "old", parentId: null, type: "custom", payload: "old" },
      { id: "huge", parentId: "old", type: "custom", payload: "x".repeat(4096) },
      { id: "latest", parentId: "huge", type: "custom", payload: "latest" },
    ]);
    const read = await sdkHost.projectionRead({ maxEntries: 2, byteLimit: 1024 });
    expect(read.entries.map(({ id }) => id)).toEqual(["huge", "latest"]);
    expect(read.entries[0]?.data).toEqual({
      type: "projection_placeholder",
      reason: "oversized",
    });
    expect(read).toMatchObject({ sessionEpoch: sdkHost.state.sessionEpoch, hasMore: true });
    await sdkHost.dispose();
  });

  it("bounds structural fields without dropping the latest projectable entries", async () => {
    const sdkHost = await host([
      { id: "x".repeat(20_000), parentId: null, type: "custom", payload: "huge id" },
      { id: "middle", parentId: "p".repeat(20_000), type: "custom", payload: "huge parent" },
      { id: "latest", parentId: "middle", type: "custom", payload: "latest" },
    ]);
    const read = await sdkHost.projectionRead({ maxEntries: 3, byteLimit: 2048 });
    expect(read.entries).toHaveLength(3);
    expect(read.entries.at(-1)?.id).toBe("latest");
    expect(read.entries[0]?.id).toMatch(/^entry-0-[a-f0-9]{64}$/);
    expect(read.entries[0]?.data).toMatchObject({
      type: "projection_placeholder",
      reason: "oversized",
      field: "id",
    });
    expect(read.entries[1]?.data).toMatchObject({ field: "parentId" });
    await sdkHost.dispose();
  });

  it("rejects unsafe caller bounds and advances past oversized entries with degradation", async () => {
    const sdkHost = await host([
      {
        id: "huge",
        type: "custom",
        payload: "x".repeat(SDK_PROJECTION_LIMITS.projectedEntryBytes),
      },
      { id: "small", type: "custom", payload: "ok" },
    ]);
    for (const request of [
      { limit: Number.POSITIVE_INFINITY, byteLimit: 1024 },
      { limit: SDK_PROJECTION_LIMITS.historyPageEntries + 1, byteLimit: 1024 },
      { limit: 1, byteLimit: SDK_PROJECTION_LIMITS.historyPageBytes + 1 },
    ])
      await expect(sdkHost.history(request)).rejects.toThrow(/unsafe history bounds/);
    const first = await sdkHost.history({ limit: 1, byteLimit: 1024 });
    expect(first).toMatchObject({
      entries: [],
      nextCursor: "1",
      degraded: true,
      degradedReasons: expect.arrayContaining(["entry_bytes"]),
    });
    const second = await sdkHost.history({ cursor: first.nextCursor!, limit: 1, byteLimit: 1024 });
    expect(second.entries).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    await sdkHost.dispose();
  });
});
