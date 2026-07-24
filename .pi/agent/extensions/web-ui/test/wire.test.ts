import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionStateStore } from "../src/server/state.js";
import {
  ClientCommandSchema,
  CommandResponseMessageSchema,
  PongMessageSchema,
  PROTOCOL_VERSION,
  ReadyMessageSchema,
  ResyncRequiredMessageSchema,
  ServerMessageSchema,
  SnapshotMessageSchema,
  StatePatchSchema,
  StateUpdateMessageSchema,
} from "../src/shared/wire.js";

const context = {
  cwd: "/repo",
  model: undefined,
  thinkingLevel: "medium",
  sessionManager: {
    getBranch: () => [],
    getSessionId: () => "session-wire",
    getLeafId: () => null,
  },
  isIdle: () => true,
  getContextUsage: () => undefined,
} as unknown as ExtensionContext;

describe("protocol v3 schemas", () => {
  it("requires generation on every mutating client command", () => {
    for (const type of ["prompt", "steer", "follow_up"] as const) {
      const command = {
        type,
        commandId: `${type}-1`,
        generation: "generation-wire",
        content: "hello",
      };
      expect(Check(ClientCommandSchema, command)).toBe(true);
      expect(Check(ClientCommandSchema, { ...command, generation: undefined })).toBe(false);
    }
    expect(
      Check(ClientCommandSchema, {
        type: "abort",
        commandId: "abort-1",
        generation: "generation-wire",
      }),
    ).toBe(true);
    expect(Check(ClientCommandSchema, { type: "abort", commandId: "abort-1" })).toBe(false);
  });

  it("allows snapshot diagnostics with a known generation and revision", () => {
    expect(
      Check(ClientCommandSchema, {
        type: "snapshot",
        commandId: "snapshot-1",
        generation: "old-generation",
        revision: 42,
      }),
    ).toBe(true);
    expect(Check(ClientCommandSchema, { type: "snapshot", commandId: "snapshot-2" })).toBe(true);
    expect(
      Check(ClientCommandSchema, {
        type: "snapshot",
        commandId: "snapshot-3",
        revision: -1,
      }),
    ).toBe(false);
  });

  it("validates every top-level server envelope at protocol version 3", () => {
    const store = new SessionStateStore(context, "generation-wire");
    const snapshot = store.snapshot("snapshot-1");
    const update = store.agentStart()!;
    const messages = [
      {
        schema: ReadyMessageSchema,
        value: {
          type: "ready",
          protocolVersion: PROTOCOL_VERSION,
          generation: "generation-wire",
          revision: 0,
        },
      },
      { schema: SnapshotMessageSchema, value: snapshot },
      { schema: StateUpdateMessageSchema, value: update },
      {
        schema: CommandResponseMessageSchema,
        value: {
          type: "command_response",
          protocolVersion: PROTOCOL_VERSION,
          generation: "generation-wire",
          commandId: "prompt-1",
          command: "prompt",
          accepted: true,
        },
      },
      {
        schema: PongMessageSchema,
        value: {
          type: "pong",
          protocolVersion: PROTOCOL_VERSION,
          generation: "generation-wire",
          commandId: "ping-1",
        },
      },
      {
        schema: ResyncRequiredMessageSchema,
        value: {
          type: "resync_required",
          protocolVersion: PROTOCOL_VERSION,
          generation: "generation-wire",
          revision: 1,
          reason: "revision gap",
        },
      },
    ];

    for (const { schema, value } of messages) {
      expect(Check(schema, value)).toBe(true);
      expect(Check(ServerMessageSchema, value)).toBe(true);
      expect(Check(ServerMessageSchema, { ...value, protocolVersion: 1 })).toBe(false);
    }
    expect(Check(StatePatchSchema, {})).toBe(false);
  });
});
