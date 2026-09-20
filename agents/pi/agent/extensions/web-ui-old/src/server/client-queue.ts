import { Buffer } from "node:buffer";
import { WebSocket } from "ws";
import { LIMITS } from "../shared/limits.js";

type FrameKind = "control" | "state" | "snapshot" | "provider";

interface Frame {
  kind: FrameKind;
  data: string;
  bytes: number;
  key?: string;
  onSettled?: () => void;
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

  enqueueControl(serialized: string, onSettled?: () => void): boolean {
    return this.enqueue({
      kind: "control",
      data: serialized,
      bytes: Buffer.byteLength(serialized),
      ...(onSettled ? { onSettled } : {}),
    });
  }

  isOpen(): boolean {
    return !this.closed && this.websocket.readyState === WebSocket.OPEN;
  }

  enqueueState(serialized: string): void {
    this.enqueue({ kind: "state", data: serialized, bytes: Buffer.byteLength(serialized) });
  }

  enqueueProvider(provider: string, serialized: string): void {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index]!;
      if (frame.kind !== "provider" || frame.key !== provider) continue;
      this.queuedBytes -= frame.bytes;
      this.frames.splice(index, 1);
    }
    this.enqueue({
      kind: "provider",
      key: provider,
      data: serialized,
      bytes: Buffer.byteLength(serialized),
    });
  }

  enqueueSnapshot(serialized = this.currentSnapshot()): void {
    for (let index = this.frames.length - 1; index >= 0; index -= 1) {
      const frame = this.frames[index]!;
      if (frame.kind === "control" || frame.kind === "provider") continue;
      this.queuedBytes -= frame.bytes;
      this.frames.splice(index, 1);
    }
    this.enqueue({ kind: "snapshot", data: serialized, bytes: Buffer.byteLength(serialized) });
  }

  close(code = 1001, reason = "Session shutting down"): void {
    if (this.closed) return;
    this.closed = true;
    if (this.slowTimer) clearTimeout(this.slowTimer);
    for (const frame of this.frames) frame.onSettled?.();
    this.frames.length = 0;
    this.queuedBytes = 0;
    if (this.websocket.readyState === WebSocket.OPEN) this.websocket.close(code, reason);
  }

  terminate(): void {
    this.close();
    this.websocket.terminate();
  }

  private enqueue(frame: Frame): boolean {
    if (this.closed || this.websocket.readyState !== WebSocket.OPEN) return false;
    if (frame.bytes > LIMITS.outboundMessageBytes) {
      this.close(1009, "Outbound message exceeds the limit");
      return false;
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
        return false;
      }
      this.close(1013, "Client is too slow");
      return false;
    }
    this.pump();
    return true;
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
      frame.onSettled?.();
      if (error) {
        this.terminate();
        return;
      }
      this.pump();
    });
  }
}
