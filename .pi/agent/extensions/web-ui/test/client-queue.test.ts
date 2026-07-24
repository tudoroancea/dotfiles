import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { LIMITS } from "../src/shared/limits.js";
import { ClientQueue } from "../src/server/client-queue.js";

class FakeWebSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  sent: string[] = [];
  callbacks: Array<(error?: Error) => void> = [];
  close = vi.fn((code?: number) => {
    this.readyState = WebSocket.CLOSING;
    void code;
  });
  terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
  });

  send(data: string, callback: (error?: Error) => void) {
    this.sent.push(data);
    this.callbacks.push(callback);
  }

  completeNext(error?: Error) {
    this.callbacks.shift()?.(error);
  }
}

describe("ClientQueue", () => {
  it("lets a snapshot supersede unsent state frames while preserving controls", () => {
    const socket = new FakeWebSocket();
    const queue = new ClientQueue(socket as unknown as WebSocket, () => "current-snapshot");
    queue.enqueueControl("control-1");
    queue.enqueueState("state-1");
    queue.enqueueControl("control-2");
    queue.enqueueState("state-2");
    queue.enqueueSnapshot("snapshot");

    expect(socket.sent).toEqual(["control-1"]);
    socket.completeNext();
    expect(socket.sent).toEqual(["control-1", "control-2"]);
    socket.completeNext();
    expect(socket.sent).toEqual(["control-1", "control-2", "snapshot"]);
  });

  it("preserves the newest provider frame across a session snapshot barrier", () => {
    const socket = new FakeWebSocket();
    const queue = new ClientQueue(socket as unknown as WebSocket, () => "current-snapshot");
    queue.enqueueControl("in-flight");
    queue.enqueueProvider("agentflow", "provider-old");
    queue.enqueueProvider("agentflow", "provider-new");
    queue.enqueueState("session-update");
    queue.enqueueSnapshot("session-snapshot");
    socket.completeNext();
    expect(socket.sent.at(-1)).toBe("provider-new");
    socket.completeNext();
    expect(socket.sent.at(-1)).toBe("session-snapshot");
  });

  it("collapses state queue overflow to a current snapshot", () => {
    const socket = new FakeWebSocket();
    const queue = new ClientQueue(socket as unknown as WebSocket, () => "current-snapshot");
    queue.enqueueControl("in-flight");
    for (let index = 0; index <= LIMITS.outboundMessagesPerClient; index += 1) {
      queue.enqueueState(`state-${index}`);
    }
    socket.completeNext();
    expect(socket.sent.at(-1)).toBe("current-snapshot");
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("disconnects a send that exceeds the slow-client deadline", () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const queue = new ClientQueue(socket as unknown as WebSocket, () => "snapshot");
    queue.enqueueControl("control");
    vi.advanceTimersByTime(LIMITS.outboundSlowClientMs);
    expect(socket.close).toHaveBeenCalledWith(1013, "Client is too slow");
    expect(socket.terminate).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
