import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/shared/limits.js";

describe("remote input limits", () => {
  it("leaves room for worst-case JSON escaping at parsed field limits", () => {
    const wireBytes = Buffer.byteLength(
      JSON.stringify({
        type: "prompt",
        commandId: "\0".repeat(LIMITS.commandIdUtf8Bytes),
        content: "\0".repeat(LIMITS.promptUtf8Bytes),
      }),
    );
    expect(wireBytes).toBeLessThanOrEqual(LIMITS.incomingWebSocketBytes);

    for (const escaped of ['"', "\\"]) {
      const alternateBytes = Buffer.byteLength(
        JSON.stringify({
          type: "prompt",
          commandId: escaped.repeat(LIMITS.commandIdUtf8Bytes),
          content: escaped.repeat(LIMITS.promptUtf8Bytes),
        }),
      );
      expect(alternateBytes).toBeLessThanOrEqual(LIMITS.incomingWebSocketBytes);
    }
  });

  it("fits every outbound item inside the per-client queue", () => {
    expect(LIMITS.snapshotBytes).toBeLessThanOrEqual(LIMITS.outboundMessageBytes);
    expect(LIMITS.outboundMessageBytes).toBeLessThanOrEqual(LIMITS.outboundBytesPerClient);
    const encodedImageBytes = 4 * Math.ceil(LIMITS.projectedImageSourceBytes / 3);
    const largestProjectedMessage =
      encodedImageBytes * LIMITS.projectedImagesPerMessage + LIMITS.toolTextUtf8Bytes + 1024;
    expect(largestProjectedMessage).toBeLessThanOrEqual(LIMITS.outboundMessageBytes);
  });

  it("bounds clients, queue depth, and bootstrap lifetime", () => {
    expect(LIMITS.connectedClients).toBeGreaterThan(0);
    expect(LIMITS.outboundMessagesPerClient).toBeGreaterThan(0);
    expect(LIMITS.bootstrapCredentialTtlMs).toBeLessThanOrEqual(60_000);
  });
});
