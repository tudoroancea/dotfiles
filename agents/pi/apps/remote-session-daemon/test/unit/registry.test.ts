import { describe, expect, it } from "vitest";
import { LaunchRegistry, type HostFactoryInput } from "../../src/host/registry.ts";
import type { SessionHost, SessionHostState } from "../../src/host/session-host.ts";
import { FakeSessionHost } from "../fixtures/fake-session-host.ts";

function host(
  input: HostFactoryInput,
  sessionId = "session-1",
  dispose = async () => {},
): SessionHost {
  const state: SessionHostState = {
    launchId: input.launchId,
    hostEpoch: input.hostEpoch,
    sessionEpoch: "s",
    lifecycle: "ready",
    ready: true,
    running: false,
    settled: true,
    pendingMessages: 0,
    queueCount: 0,
    queueBytes: 0,
    dialog: null,
    model: null,
    thinkingLevel: "off",
    identity: { sessionId, sessionFile: "/confirmed/session.jsonl" },
  };
  return {
    get state() {
      return structuredClone(state);
    },
    subscribe() {
      return () => {};
    },
    commands() {
      return [];
    },
    async command(command) {
      return { status: "accepted", commandId: command.commandId };
    },
    async transition() {
      return { status: "completed" };
    },
    async history() {
      return { entries: [], nextCursor: null, degraded: false, omittedEntries: 0 };
    },
    async projectionRead() {
      return {
        sessionEpoch: state.sessionEpoch,
        entries: [],
        beforeCursor: null,
        hasMore: false,
        queue: [],
      };
    },
    dispose,
  };
}

describe("launch registry", () => {
  it("owns stable launch IDs and fresh generations across idle unload/reopen", async () => {
    let next = 0;
    const inputs: HostFactoryInput[] = [];
    const registry = new LaunchRegistry({
      capacity: 1,
      idFactory: () => `id-${++next}`,
      hostFactory: async (input) => {
        inputs.push(input);
        return host(input);
      },
    });
    const created = await registry.create("/canonical");
    await registry.unload(created.launchId);
    const reopened = await registry.reopen(created.launchId);
    expect(reopened.launchId).toBe(created.launchId);
    expect(reopened.generation).not.toBe(created.generation);
    expect(inputs[1]?.resumeTarget).toEqual({
      sessionId: "session-1",
      sessionFile: "/confirmed/session.jsonl",
    });
  });

  it("keeps interrupts and stop from blocking behind ordinary admission", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commandEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let disposed = false;
    const registry = new LaunchRegistry({
      capacity: 1,
      hostFactory: async (input) => {
        const candidate = host(input);
        return {
          ...candidate,
          async command(command) {
            if (command.type === "abort")
              return { status: "accepted" as const, commandId: command.commandId };
            entered();
            await gate;
            return { status: "handled" as const, commandId: command.commandId };
          },
          async dispose() {
            disposed = true;
          },
        };
      },
    });
    const launch = await registry.create("/canonical");
    const command = registry.command(launch.launchId, launch.generation, launch.commandEpoch, {
      type: "set_thinking",
      commandId: "command",
      level: "low",
    });
    await commandEntered;
    await expect(
      registry.command(launch.launchId, launch.generation, launch.commandEpoch, {
        type: "abort",
        commandId: "abort",
      }),
    ).resolves.toMatchObject({ status: "accepted" });
    const stop = registry.stop(launch.launchId);
    await expect(stop).resolves.toMatchObject({ lifecycle: "stopped" });
    expect(disposed).toBe(true);
    release();
    await expect(command).resolves.toMatchObject({ status: "handled" });
  });

  it("serializes concurrent reopen and unload without losing reservations or publishing stale hosts", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const registry = new LaunchRegistry({
      capacity: 1,
      hostFactory: async (input) => {
        calls += 1;
        if (calls === 2) await gate;
        return host(input);
      },
    });
    const launch = await registry.create("/canonical");
    await registry.unload(launch.launchId);
    const first = registry.reopen(launch.launchId);
    const second = registry.reopen(launch.launchId);
    const unload = registry.unload(launch.launchId);
    await Promise.resolve();
    expect(registry.reservedCapacity).toBe(1);
    await expect(registry.create("/other")).rejects.toMatchObject({ code: "capacity_exhausted" });
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await expect(unload).resolves.toMatchObject({ lifecycle: "unloaded" });
    expect(registry.reservedCapacity).toBe(0);
    expect(registry.detail(launch.launchId)).toMatchObject({ lifecycle: "unloaded", ready: false });
    expect(calls).toBe(2);
  });

  it("enforces the retained SDK message queue independently from admission", async () => {
    let state!: SessionHostState;
    const registry = new LaunchRegistry({
      capacity: 1,
      queueCount: 1,
      queueBytes: 1024,
      hostFactory: async (input) => {
        const candidate = host(input);
        state = candidate.state;
        return {
          ...candidate,
          get state() {
            return structuredClone(state);
          },
          async command(command) {
            if (command.type === "prompt")
              state = { ...state, lifecycle: "running", running: true, settled: false };
            if (command.type === "follow_up")
              state = {
                ...state,
                pendingMessages: state.pendingMessages + 1,
                queueCount: state.queueCount + 1,
                queueBytes: state.queueBytes + Buffer.byteLength(command.text),
              };
            return {
              status: command.type === "follow_up" ? ("queued" as const) : ("accepted" as const),
              commandId: command.commandId,
            };
          },
        };
      },
    });
    const launch = await registry.create("/canonical");
    await registry.command(launch.launchId, launch.generation, launch.commandEpoch, {
      type: "prompt",
      commandId: "prompt",
      text: "start",
    });
    await expect(
      registry.command(launch.launchId, launch.generation, launch.commandEpoch, {
        type: "follow_up",
        commandId: "first",
        text: "one",
      }),
    ).resolves.toMatchObject({ status: "queued" });
    await expect(
      registry.command(launch.launchId, launch.generation, launch.commandEpoch, {
        type: "follow_up",
        commandId: "second",
        text: "two",
      }),
    ).resolves.toMatchObject({ status: "rejected", code: "message_queue_full" });
  });

  it("bounds launch slots with stopped-slot eviction and applies RSS admission", async () => {
    const limited = new LaunchRegistry({
      capacity: 2,
      totalLaunches: 1,
      memoryBytes: 1024,
      memoryUsage: () => 0,
      hostFactory: async (input) => host(input),
    });
    const launch = await limited.create("/one");
    await limited.stop(launch.launchId);
    expect(limited.list()).toHaveLength(1);
    const replacement = await limited.create("/two");
    expect(limited.list()).toEqual([expect.objectContaining({ launchId: replacement.launchId })]);
    expect(() => limited.detail(launch.launchId)).toThrow(
      expect.objectContaining({ code: "launch_not_found" }),
    );

    let rss = 0;
    const memoryLimited = new LaunchRegistry({
      capacity: 1,
      totalLaunches: 1,
      memoryBytes: 1024,
      memoryUsage: () => rss,
      hostFactory: async (input) => host(input),
    });
    const retained = await memoryLimited.create("/one");
    await memoryLimited.stop(retained.launchId);
    rss = 1024;
    await expect(memoryLimited.create("/two")).rejects.toMatchObject({
      code: "memory_exhausted",
    });
    expect(memoryLimited.detail(retained.launchId).lifecycle).toBe("stopped");
  });

  it("never unloads an active host during an idle sweep", async () => {
    let now = 0;
    let state!: SessionHostState;
    let disposals = 0;
    const registry = new LaunchRegistry({
      capacity: 1,
      now: () => now,
      hostFactory: async (input) => {
        const candidate = host(input, "active", async () => {
          disposals += 1;
        });
        state = candidate.state;
        return {
          ...candidate,
          get state() {
            return structuredClone(state);
          },
        };
      },
    });
    await registry.create("/canonical");
    state = { ...state, lifecycle: "running", running: true, settled: false };
    now = 1000;
    await expect(registry.unloadIdle(100)).resolves.toEqual([]);
    expect(disposals).toBe(0);
    expect(registry.reservedCapacity).toBe(1);
  });

  it("withholds readiness until projection reconciliation and owns projection disposal", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let candidate!: SessionHost;
    const registry = new LaunchRegistry({
      capacity: 1,
      idFactory: (() => {
        let next = 0;
        return () => `id-${++next}`;
      })(),
      hostFactory: async (input) => {
        const base = host(input);
        candidate = {
          ...base,
          async projectionRead() {
            await gate;
            return {
              sessionEpoch: base.state.sessionEpoch,
              entries: [],
              beforeCursor: null,
              hasMore: false,
              queue: [],
            };
          },
        };
        return candidate;
      },
    });
    const creating = registry.create("/canonical");
    await Promise.resolve();
    expect(registry.detail("id-1")).toMatchObject({ lifecycle: "loading", ready: false });
    release();
    const launch = await creating;
    const attachment = registry.projection(launch.launchId);
    expect(attachment.initial.generation).toBe(launch.generation);
    expect(attachment.initial.snapshot.commandEpoch).toBe(candidate.state.sessionEpoch);
    await registry.stop(launch.launchId);
    expect(() => registry.projection(launch.launchId)).toThrow(
      expect.objectContaining({ code: "host_not_ready" }),
    );
  });

  it("discards a stale initial projection read when fenced during loading", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let disposals = 0;
    const registry = new LaunchRegistry({
      capacity: 1,
      idFactory: (() => {
        let next = 0;
        return () => `id-${++next}`;
      })(),
      hostFactory: async (input) => {
        const base = host(input, "stale", async () => {
          disposals += 1;
        });
        return {
          ...base,
          async projectionRead() {
            await gate;
            return {
              sessionEpoch: base.state.sessionEpoch,
              entries: [],
              beforeCursor: null,
              hasMore: false,
              queue: [],
            };
          },
        };
      },
    });
    const creating = registry.create("/canonical");
    await Promise.resolve();
    const stopping = registry.stop("id-1");
    release();
    await creating;
    await stopping;
    expect(disposals).toBe(1);
    expect(registry.detail("id-1")).toMatchObject({ lifecycle: "stopped", ready: false });
  });

  it.each(["failed-state", "host-lost"] as const)(
    "fences generation and closes projection attachments when the host reports %s",
    async (failure) => {
      let state!: SessionHostState;
      const listeners = new Set<Parameters<SessionHost["subscribe"]>[0]>();
      const registry = new LaunchRegistry({
        capacity: 1,
        idFactory: (() => {
          let next = 0;
          return () => `id-${++next}`;
        })(),
        hostFactory: async (input) => {
          const base = host(input);
          state = base.state;
          return {
            ...base,
            get state() {
              return structuredClone(state);
            },
            subscribe(listener) {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          };
        },
      });
      const launch = await registry.create("/canonical");
      const attachment = registry.projection(launch.launchId);
      let closed = 0;
      const subscription = attachment.attach(
        () => undefined,
        () => (closed += 1),
      );
      if (failure === "failed-state") {
        state = { ...state, lifecycle: "failed", ready: false };
        for (const listener of listeners) listener({ type: "state", state });
      } else {
        for (const listener of listeners) listener({ type: "host_lost" });
      }
      expect(closed).toBe(1);
      expect(registry.detail(launch.launchId)).toMatchObject({ lifecycle: "failed", ready: false });
      expect(registry.detail(launch.launchId).generation).not.toBe(launch.generation);
      expect(() => registry.projection(launch.launchId)).toThrow(
        expect.objectContaining({ code: "host_not_ready" }),
      );
      subscription.unsubscribe();
      await registry.stop(launch.launchId);
    },
  );

  it("fences generation and closes streams after projection reconciliation exhaustion", async () => {
    const listeners = new Set<Parameters<SessionHost["subscribe"]>[0]>();
    let failReads = false;
    const registry = new LaunchRegistry({
      capacity: 1,
      idFactory: (() => {
        let next = 0;
        return () => `id-${++next}`;
      })(),
      hostFactory: async (input) => {
        const base = host(input);
        return {
          ...base,
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          async projectionRead() {
            if (failReads) throw new Error("projection read failed");
            return {
              sessionEpoch: base.state.sessionEpoch,
              entries: [],
              beforeCursor: null,
              hasMore: false,
              queue: [],
            };
          },
        };
      },
    });
    const launch = await registry.create("/canonical");
    let closed = 0;
    registry.projection(launch.launchId).attach(
      () => undefined,
      () => (closed += 1),
    );
    failReads = true;
    for (const listener of listeners) listener({ type: "durable_change" });
    for (let index = 0; index < 4; index += 1)
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(1);
    expect(registry.detail(launch.launchId)).toMatchObject({
      lifecycle: "failed",
      failureCode: "projection_failed",
      ready: false,
    });
    expect(registry.detail(launch.launchId).generation).not.toBe(launch.generation);
    await registry.stop(launch.launchId);
  });

  it("rotates command epochs and fences queued old-epoch work after a model change", async () => {
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => (releaseModel = resolve));
    let fake!: FakeSessionHost;
    const registry = new LaunchRegistry({
      capacity: 1,
      hostFactory: async (input) => {
        fake = new FakeSessionHost({
          launchId: input.launchId,
          hostEpoch: input.hostEpoch,
          modelGate,
          rotateModelEpochOnModelChange: true,
          modelControl: {
            models: [{ provider: "provider", id: "model", name: "Model" }],
            thinkingLevels: ["off", "max"],
          },
        });
        fake.load({ sessionId: "session", sessionFile: "/confirmed/session.jsonl" });
        return fake;
      },
    });
    const launch = await registry.create("/canonical");
    const envelopes: unknown[] = [];
    const subscription = registry.projection(launch.launchId).attach(
      (envelope) => envelopes.push(envelope),
      () => undefined,
    );
    const model = registry.command(launch.launchId, launch.generation, launch.commandEpoch, {
      type: "set_model",
      commandId: "model",
      provider: "provider",
      model: "model",
    });
    const thinking = registry.command(launch.launchId, launch.generation, launch.commandEpoch, {
      type: "set_thinking",
      commandId: "thinking",
      level: "max",
    });
    await Promise.resolve();
    expect(fake.invokedCommands.map((command) => command.commandId)).toEqual(["model"]);
    releaseModel();
    await expect(model).resolves.toMatchObject({ status: "handled" });
    await expect(thinking).resolves.toMatchObject({ status: "rejected", code: "host_not_ready" });
    const rotated = registry.detail(launch.launchId).commandEpoch;
    expect(rotated).not.toBe(launch.commandEpoch);
    expect(fake.invokedCommands.map((command) => command.commandId)).toEqual(["model"]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(envelopes).toContainEqual(
      expect.objectContaining({
        type: "reset",
        snapshot: expect.objectContaining({
          commandEpoch: rotated,
          modelControl: expect.objectContaining({ thinkingLevels: ["off", "max"] }),
        }),
      }),
    );
    subscription.unsubscribe();
    await registry.stop(launch.launchId);
  });

  it("reserves capacity through failed disposal and isolates siblings", async () => {
    const registry = new LaunchRegistry({
      capacity: 1,
      hostFactory: async (input) =>
        host(input, "s", async () => {
          throw new Error("dispose");
        }),
    });
    const launch = await registry.create("/canonical");
    await expect(registry.stop(launch.launchId)).rejects.toThrow("dispose");
    expect(registry.reservedCapacity).toBe(1);
    await expect(registry.create("/other")).rejects.toMatchObject({ code: "capacity_exhausted" });
  });
});
