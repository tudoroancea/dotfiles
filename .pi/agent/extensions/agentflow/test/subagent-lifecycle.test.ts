import { describe, expect, it, vi } from "vitest";
import {
  awaitWithChildDeadline,
  disposeChildSession,
  settleChildAbort,
} from "../src/runtime/subagent-runner.ts";

describe("child deadline and disposal", () => {
  it("rejects a hung prompt at the hard deadline and aborts it", async () => {
    vi.useFakeTimers();
    try {
      const abort = vi.fn(async () => undefined);
      const result = awaitWithChildDeadline(new Promise<never>(() => undefined), 250, abort);
      const rejection = expect(result).rejects.toThrow("Child deadline exceeded after 250ms");

      await vi.advanceTimersByTimeAsync(250);

      await rejection;
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for abort settlement before shutdown without waiting forever", async () => {
    vi.useFakeTimers();
    try {
      let settle!: () => void;
      const abort = new Promise<void>((resolve) => {
        settle = resolve;
      });
      let completed = false;
      const waiting = settleChildAbort(abort, 100).then(() => {
        completed = true;
      });

      await vi.advanceTimersByTimeAsync(50);
      expect(completed).toBe(false);
      settle();
      await waiting;
      expect(completed).toBe(true);

      const hung = settleChildAbort(new Promise<never>(() => undefined), 100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(hung).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds extension shutdown and always disposes the child session", async () => {
    vi.useFakeTimers();
    try {
      const dispose = vi.fn();
      const emit = vi.fn(async () => new Promise<never>(() => undefined));
      const completion = disposeChildSession({ dispose, _extensionRunner: { emit } } as never, 100);

      await vi.advanceTimersByTimeAsync(100);
      await completion;

      expect(emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
