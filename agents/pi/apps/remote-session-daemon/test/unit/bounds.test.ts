import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  SDK_PROJECTION_LIMITS,
  measureBoundedHistory,
  measureSdkProjection,
} from "../../src/observability/sdk-projection-bounds.ts";
const textEntry = (id: number, size = 32) => ({
  type: "message",
  id: `entry-${id}`,
  message: { role: "user", content: "x".repeat(size) },
});
describe("SDK projection hard bounds", () => {
  it("preserves a representative page", () => {
    const source = Array.from({ length: 20 }, (_, i) => textEntry(i));
    const r = measureBoundedHistory(source, Buffer.byteLength(JSON.stringify(source)));
    expect(r.degraded).toBe(false);
    expect(r.entries).toEqual(source);
  });
  it("caps generated adversarial history", () => {
    const source = Array.from({ length: SDK_PROJECTION_LIMITS.sessionEntries + 1 }, (_, i) =>
      textEntry(i, 12 * 1024),
    );
    const r = measureBoundedHistory(source, SDK_PROJECTION_LIMITS.sessionBytes + 1);
    expect(r.entries.length).toBeLessThanOrEqual(100);
    expect(r.measurement.projectedBytes).toBeLessThanOrEqual(
      SDK_PROJECTION_LIMITS.historyPageBytes,
    );
    expect(r.reasons).toEqual(
      expect.arrayContaining(["session_bytes", "session_entries", "page_bytes"]),
    );
    expect(r.omittedEntries).toBeGreaterThan(0);
  });
  it.each([
    ["entry_bytes", { payload: "x".repeat(SDK_PROJECTION_LIMITS.projectedEntryBytes + 1) }],
    [
      "image_bytes",
      {
        type: "message",
        message: {
          role: "user",
          content: [
            {
              type: "image",
              data: "a".repeat(Math.ceil(((SDK_PROJECTION_LIMITS.imageBytes + 1) * 4) / 3)),
            },
          ],
        },
      },
    ],
    [
      "image_count",
      {
        type: "message",
        message: {
          role: "user",
          content: Array.from({ length: SDK_PROJECTION_LIMITS.imagesPerEntry + 1 }, () => ({
            type: "image",
            data: "YQ==",
          })),
        },
      },
    ],
    [
      "tool_result_bytes",
      {
        type: "message",
        message: {
          role: "toolResult",
          content: "x".repeat(SDK_PROJECTION_LIMITS.toolResultBytes + 1),
        },
      },
    ],
  ] as const)("reports %s degradation", (reason, entry) => {
    const r = measureBoundedHistory([entry], Buffer.byteLength(JSON.stringify(entry)));
    expect(r.entries).toEqual([]);
    expect(r.degraded).toBe(true);
    expect(r.reasons).toContain(reason);
  });
  it("measures image and tool bytes", () => {
    const m = measureSdkProjection([
      { type: "image", data: "aGVsbG8=" },
      { role: "toolResult", content: "result" },
    ]);
    expect(m.imageCount).toBe(1);
    expect(m.imageBytes).toBe(6);
    expect(m.toolResultBytes).toBeGreaterThanOrEqual(6);
  });
});
