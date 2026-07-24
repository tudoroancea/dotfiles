import { Buffer } from "node:buffer";
import { WebSocket } from "ws";
import { LIMITS } from "../shared/limits.js";

type FrameKind = "control" | "state" | "snapshot";

interface Frame {
  kind: FrameKind;
  data: string;
  bytes: number;
}

export class ClientQueue {
  private readonly frames: Frame[] = [];
  private queuedBytes = 0;
  private sending = false;
  private closed = false;
  private slowTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly websocket: WebSocket,
    private readonly currentSnapshot: () => string,
  ) {}

  enqueueControl(serialized: string): void {
    this.enqueue({ kind: "control", data: serialized, bytes: Buffer.byteLength(serialized) });
  }

  enqueueState(serialized: string): void {
    this.enqueue({ kind: "state", data: serialized, bytes: Buffer.byteLength(serialized) });
  }

  enqueueSnapshot(serialized = this.currentSnapshot()): void {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index]!;
      if (frame.kind === "control") continue;
      this.queuedBytes -= frame.bytes;
      this.frames.splice(index, 1);
    }
    this.enqueue({ kind: "snapshot", data: serialized, bytes: Buffer.byteLength(serialized) });
  }

  close(code = 1001, reason = "Session shutting down"): void {
    if (this.closed) return;
    this.closed = true;
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.frames.length = 0;
    this.queuedBytes = 0;
    if (this.websocket.readyState === WebSocket.OPEN) this.websocket.close(code, reason);
  }

  terminate(): void {
    this.close();
    this.websocket.terminate();
  }

  private enqueue(frame: Frame): void {
    if (this.closed || this.websocket.readyState !== WebSocket.OPEN) return;
    if (frame.bytes > LIMITS.outboundMessageBytes) {
      this.close(1009, "Outbound message exceeds the limit");
      return;
    }
    this.frames.push(frame);
    this.queuedBytes += frame.bytes;
    if (
      this.frames.length > LIMITS.outboundMessagesPerClient ||
      this.queuedBytes + this.websocket.bufferedAmount > LIMITS.outboundBytesPerClient
    ) {
      if (frame.kind === "state") {
        this.frames.pop();
        this.queuedBytes -= frame.bytes;
        this.enqueueSnapshot();
        return;
      }
      this.close(1013, "Client is too slow");
      return;
    }
    this.pump();
  }

  private pump(): void {
    if (this.closed || this.sending || this.websocket.readyState !== WebSocket.OPEN) return;
    const frame = this.frames.shift();
    if (!frame) return;
    this.queuedBytes -= frame.bytes;
    this.sending = true;
    this.slowTimer = setTimeout(() => {
      this.slowTimer = undefined;
      this.close(1013, "Client is too slow");
      this.websocket.terminate();
    }, LIMITS.outboundSlowClientMs);
    this.slowTimer.unref?.();
    this.websocket.send(frame.data, (error) => {
      if (this.slowTimer) clearTimeout(this.slowTimer);
      this.slowTimer = undefined;
      this.sending = false;
      if (error) {
        this.terminate();
        return;
      }
      this.pump();
    });
  }
}
