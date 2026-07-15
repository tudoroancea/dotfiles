import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { BoundedTail, TAIL_MAX_BYTES, TAIL_MAX_LINES } from "../src/runtime/bounded-tail.ts";

describe("BoundedTail", () => {
  it("keeps only the newest configured number of lines", () => {
    const tail = new BoundedTail();
    const lines = Array.from({ length: TAIL_MAX_LINES + 5 }, (_, index) => `line-${index}`);

    tail.append(`${lines.join("\n")}\n`);

    const snapshot = tail.snapshot();
    expect(snapshot.lines).toBe(TAIL_MAX_LINES);
    expect(snapshot.content).toBe(`${lines.slice(5).join("\n")}\n`);
    expect(snapshot.truncated).toBe(true);
  });

  it("obeys both bounds under high-volume output", () => {
    const tail = new BoundedTail();
    for (let index = 0; index < 4_000; index += 1) {
      tail.append(`${index.toString().padStart(4, "0")}:${"x".repeat(40)}\n`);
    }

    const snapshot = tail.snapshot();
    expect(snapshot.bytes).toBeLessThanOrEqual(TAIL_MAX_BYTES);
    expect(snapshot.lines).toBeLessThanOrEqual(TAIL_MAX_LINES);
    expect(snapshot.content.endsWith(`3999:${"x".repeat(40)}\n`)).toBe(true);
  });

  it("bounds a pathological single line without splitting UTF-8", () => {
    const tail = new BoundedTail();
    tail.append("🙂".repeat(TAIL_MAX_BYTES));

    const snapshot = tail.snapshot();
    expect(snapshot.bytes).toBeLessThanOrEqual(TAIL_MAX_BYTES);
    expect(snapshot.lines).toBe(1);
    expect(snapshot.content).not.toContain("�");
    expect(Buffer.from(snapshot.content, "utf8").toString("utf8")).toBe(snapshot.content);
    expect(snapshot.truncated).toBe(true);
  });

  it("preserves line accounting across chunk boundaries", () => {
    const tail = new BoundedTail(20, 2);
    tail.append("old");
    tail.append(" line\nnew");
    tail.append(" line\nlatest");

    expect(tail.snapshot()).toEqual({
      content: "new line\nlatest",
      bytes: 15,
      lines: 2,
      truncated: true,
    });
  });
});
