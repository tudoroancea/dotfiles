import { describe, expect, it } from "vitest";
import { AdmissionController } from "../../src/host/admission.ts";
import type { SessionHostCommand } from "../../src/host/session-host.ts";

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>((settle) => (resolve = settle)), resolve };
}

describe("AdmissionController", () => {
  it("rejects invalid retention and deadline bounds", () => {
    const execute = async (command: SessionHostCommand) => ({
      status: "accepted" as const,
      commandId: command.commandId,
    });
    for (const maxCompletedRecords of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY])
      expect(
        () =>
          new AdmissionController(
            { maxPendingCount: 1, maxPendingBytes: 1, maxCompletedRecords },
            execute,
          ),
      ).toThrow(RangeError);
    for (const deadlineMs of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 10 * 60_000 + 1])
      expect(
        () =>
          new AdmissionController({ maxPendingCount: 1, maxPendingBytes: 1, deadlineMs }, execute),
      ).toThrow(RangeError);
  });

  it("admits ordinary commands in FIFO order while interrupts bypass the lane", async () => {
    const firstGate = deferred();
    const invoked: string[] = [];
    const controller = new AdmissionController(
      { maxPendingCount: 4, maxPendingBytes: 4096 },
      async (command) => {
        invoked.push(command.commandId);
        if (command.commandId === "first") await firstGate.promise;
        return { status: "handled", commandId: command.commandId };
      },
    );
    const first = controller.submit("principal", {
      type: "set_thinking",
      commandId: "first",
      level: "low",
    });
    const second = controller.submit("principal", {
      type: "set_thinking",
      commandId: "second",
      level: "high",
    });
    const alsoQueued = controller.submit("principal", {
      type: "set_thinking",
      commandId: "also-queued",
      level: "xhigh",
    });
    await Promise.resolve();
    await expect(
      controller.submit("principal", { type: "abort", commandId: "abort" }),
    ).resolves.toMatchObject({ status: "handled" });
    for (const queued of [second, alsoQueued])
      await expect(queued).resolves.toMatchObject({
        status: "rejected",
        code: "admission_interrupted",
      });
    expect(invoked).toEqual(["first", "abort"]);
    const third = controller.submit("principal", {
      type: "set_thinking",
      commandId: "third",
      level: "medium",
    });
    firstGate.resolve();
    await expect(Promise.all([first, third])).resolves.toHaveLength(2);
    expect(invoked).toEqual(["first", "abort", "third"]);
  });

  it("rejects queued and new ordinary work while an interrupt is active", async () => {
    const ordinaryGate = deferred();
    const abortGate = deferred();
    const controller = new AdmissionController(
      { maxPendingCount: 4, maxPendingBytes: 4096 },
      async (command) => {
        if (command.type === "abort") await abortGate.promise;
        else await ordinaryGate.promise;
        return { status: "accepted", commandId: command.commandId };
      },
    );
    const active = controller.submit("principal", {
      type: "prompt",
      commandId: "active",
      text: "active",
    });
    const queued = controller.submit("principal", {
      type: "prompt",
      commandId: "queued",
      text: "queued",
    });
    const abort = controller.submit("principal", { type: "abort", commandId: "abort" });
    await expect(queued).resolves.toMatchObject({
      status: "rejected",
      code: "admission_interrupted",
    });
    await expect(
      controller.submit("principal", {
        type: "prompt",
        commandId: "new",
        text: "new",
      }),
    ).resolves.toMatchObject({ status: "rejected", code: "host_not_ready" });
    abortGate.resolve();
    await abort;
    ordinaryGate.resolve();
    await active;
  });

  it("coalesces identical command IDs and rejects conflicting reuse", async () => {
    const gate = deferred();
    let calls = 0;
    const controller = new AdmissionController(
      { maxPendingCount: 2, maxPendingBytes: 4096 },
      async (command) => {
        calls += 1;
        await gate.promise;
        return { status: "accepted", commandId: command.commandId };
      },
    );
    const command: SessionHostCommand = { type: "prompt", commandId: "same", text: "hello" };
    const first = controller.submit("principal", command);
    expect(controller.submit("principal", command)).toBe(first);
    await expect(
      controller.submit("principal", { ...command, text: "different" }),
    ).resolves.toMatchObject({ status: "rejected", code: "command_id_conflict" });
    gate.resolve();
    await expect(first).resolves.toMatchObject({ status: "accepted" });
    await expect(controller.submit("principal", command)).resolves.toMatchObject({
      status: "accepted",
    });
    expect(calls).toBe(1);
  });

  it("bounds pending count and UTF-8 bytes per launch and scope", async () => {
    const gate = deferred();
    const controller = new AdmissionController(
      { maxPendingCount: 1, maxPendingBytes: 90 },
      async (command) => {
        await gate.promise;
        return { status: "accepted", commandId: command.commandId };
      },
    );
    const first = controller.submit("one", { type: "prompt", commandId: "first", text: "é" });
    await expect(
      controller.submit("one", { type: "prompt", commandId: "second", text: "x" }),
    ).resolves.toMatchObject({ status: "rejected", code: "admission_queue_full" });
    const other = controller.submit("two", {
      type: "prompt",
      commandId: "other",
      text: "x",
    });
    await expect(other).resolves.toMatchObject({
      status: "rejected",
      code: "admission_queue_full",
    });
    gate.resolve();
    await first;
  });

  it("fences every queued command immediately", async () => {
    const gate = deferred();
    const invoked: string[] = [];
    const controller = new AdmissionController(
      { maxPendingCount: 4, maxPendingBytes: 4096 },
      async (command) => {
        invoked.push(command.commandId);
        await gate.promise;
        return { status: "accepted", commandId: command.commandId };
      },
    );
    const active = controller.submit("principal", {
      type: "prompt",
      commandId: "active",
      text: "active",
    });
    const queued = ["one", "two", "three"].map((commandId) =>
      controller.submit("principal", { type: "prompt", commandId, text: commandId }),
    );
    controller.fence();
    for (const result of queued)
      await expect(result).resolves.toMatchObject({ status: "rejected", code: "host_not_ready" });
    gate.resolve();
    await active;
    expect(invoked).toEqual(["active"]);
  });

  it("never forgets replay IDs within an exhausted command epoch", async () => {
    let calls = 0;
    const controller = new AdmissionController(
      { maxPendingCount: 1, maxPendingBytes: 1024, maxCompletedRecords: 2 },
      async (command) => {
        calls += 1;
        return { status: "accepted", commandId: command.commandId };
      },
    );
    const first = { type: "prompt", commandId: "first", text: "one" } as const;
    await controller.submit("principal", first);
    await controller.submit("principal", {
      type: "prompt",
      commandId: "second",
      text: "two",
    });
    await expect(controller.submit("principal", first)).resolves.toMatchObject({
      status: "accepted",
    });
    await expect(
      controller.submit("principal", { type: "prompt", commandId: "third", text: "three" }),
    ).resolves.toMatchObject({ status: "rejected", code: "command_epoch_exhausted" });
    await expect(
      controller.submit("principal", { ...first, text: "changed" }),
    ).resolves.toMatchObject({ status: "rejected", code: "command_id_conflict" });
    expect(calls).toBe(2);
  });

  it("marks invoked deadline expiry ambiguous and safely rejects queued work", async () => {
    const never = new Promise<never>(() => {});
    const controller = new AdmissionController(
      { maxPendingCount: 2, maxPendingBytes: 4096, deadlineMs: 10 },
      async () => never,
    );
    const invoked = controller.submit("principal", {
      type: "prompt",
      commandId: "invoked",
      text: "hello",
    });
    const queued = controller.submit("principal", {
      type: "prompt",
      commandId: "queued",
      text: "later",
    });
    await expect(invoked).resolves.toMatchObject({ status: "ambiguous" });
    await expect(queued).resolves.toMatchObject({ status: "rejected", code: "host_not_ready" });
  });
});
