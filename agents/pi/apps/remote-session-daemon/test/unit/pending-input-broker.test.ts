import { describe, expect, it } from "vitest";
import { PendingInputBroker } from "../../src/host/pending-input-broker.ts";

describe("managed pending input broker", () => {
  it("edits/removes by stable item identity and preserves order", () => {
    const broker = new PendingInputBroker(() => {});
    const first = broker.enqueue("one", "epoch", "steer", "duplicate");
    const second = broker.enqueue("two", "epoch", "followUp", "duplicate");
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    if (first.status !== "accepted" || second.status !== "accepted") return;

    expect(
      broker.mutate({
        action: "edit",
        itemId: second.record.id,
        expectedItemVersion: 1,
        content: "edited duplicate",
      }).status,
    ).toBe("accepted");
    expect(broker.snapshot().map((item) => item.content)).toEqual([
      "duplicate",
      "edited duplicate",
    ]);
    expect(
      broker.mutate({ action: "remove", itemId: first.record.id, expectedItemVersion: 1 }).status,
    ).toBe("accepted");
    expect(broker.snapshot().map((item) => item.content)).toEqual(["edited duplicate"]);
  });

  it("restores a failed handoff and makes release conflicts deterministic", async () => {
    const broker = new PendingInputBroker(() => {});
    const queued = broker.enqueue("command", "epoch", "steer", "text");
    expect(queued.status).toBe("accepted");
    if (queued.status !== "accepted") return;
    let rejectHandoff!: (error: Error) => void;
    const handoff = broker.releaseNext(
      "steer",
      () =>
        new Promise<void>((_, reject) => {
          rejectHandoff = reject;
        }),
    );
    await Promise.resolve();
    const conflict = broker.mutate({
      action: "remove",
      itemId: queued.record.id,
      expectedItemVersion: 1,
    });
    expect(conflict.status).toBe("rejected");
    if (conflict.status === "rejected") expect(conflict.reason).toBe("released");
    rejectHandoff(new Error("temporary SDK failure"));
    expect((await handoff).status).toBe("failed");
    expect(broker.snapshot()[0]).toMatchObject({
      id: queued.record.id,
      editable: true,
      state: "held",
    });
  });

  it("retains image payload metadata through text edits and release", async () => {
    const sent: unknown[] = [];
    const broker = new PendingInputBroker(() => {});
    const image = {
      data: "encoded",
      mimeType: "image/png" as const,
      width: 1,
      height: 1,
      byteLength: 7,
    };
    const queued = broker.enqueue("image-command", "epoch", "steer", "before", [image]);
    expect(queued.status).toBe("accepted");
    if (queued.status !== "accepted") return;
    expect(broker.snapshot()[0]).toMatchObject({ attachmentCount: 1, editable: true });
    broker.mutate({
      action: "edit",
      itemId: queued.record.id,
      expectedItemVersion: 1,
      content: "after",
    });
    await broker.releaseNext("steer", (content, _delivery, images) => {
      sent.push({ content, images });
    });
    expect(sent).toEqual([{ content: "after", images: [image] }]);
  });

  it("releases one item per lifecycle boundary", async () => {
    const sent: string[] = [];
    const broker = new PendingInputBroker(() => {});
    broker.enqueue("one", "epoch", "followUp", "one");
    broker.enqueue("two", "epoch", "followUp", "two");
    expect(
      (
        await broker.releaseNext("followUp", (content) => {
          sent.push(content);
        })
      ).status,
    ).toBe("handed-off");
    expect(sent).toEqual(["one"]);
    expect(broker.snapshot().map((item) => item.content)).toEqual(["two"]);
  });
});
