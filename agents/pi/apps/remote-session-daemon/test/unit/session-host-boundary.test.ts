import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  SessionHost,
  SessionHostCommand,
  SessionHostEvent,
} from "../../src/host/session-host.ts";

const command: SessionHostCommand = { type: "prompt", commandId: "c", text: "hello" };
const event: SessionHostEvent = { type: "settled" };

describe("SessionHost boundary", () => {
  it("has host-neutral command and event unions", () => {
    expect(command.type).toBe("prompt");
    expect(event.type).toBe("settled");
    expectTypeOf<SessionHost["dispose"]>().returns.toEqualTypeOf<Promise<void>>();
  });
  it("contains no Pi SDK import or browser wire dependency", async () => {
    const source = await readFile(
      new URL("../../src/host/session-host.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/@earendil-works|pi-web-ui-client|\/wire/);
    expect(source).not.toMatch(/^import /m);
  });
});
