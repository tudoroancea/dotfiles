import {
  ImageAttachmentCommandSchema,
  ModelControlCommandSchema,
  PROTOCOL_VERSION,
  QueueMutationCommandSchema,
  SessionCommandSchema,
  type ImageAttachmentCommand,
  type ModelControlCommand,
  type QueueMutationCommand,
  type SessionCommand,
} from "@dotfiles/pi-web-ui-client/wire";
import { Check } from "typebox/value";
import type { SessionHostCommand } from "../host/session-host.ts";

const MAX_TEXT = 512;
const MAX_COMMAND_TEXT = 32 * 1024;
const GENERATION = /^[A-Za-z0-9._~-]{1,128}$/;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("JSON body must be an object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key)))
    throw new TypeError("JSON body has unexpected fields");
}

function text(value: unknown, name: string, maximum = MAX_TEXT): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\0")
  )
    throw new TypeError(`${name} is invalid`);
  return value;
}

export function parseLaunchRequest(value: unknown): { rootAlias: string; relativePath: string } {
  const input = record(value);
  exactKeys(input, ["rootAlias", "relativePath"]);
  return {
    rootAlias: text(input.rootAlias, "rootAlias"),
    relativePath: text(input.relativePath, "relativePath"),
  };
}

export function parseSessionCommand(value: unknown): SessionCommand {
  if (!Check(SessionCommandSchema, value)) throw new TypeError("Session command is invalid");
  return value;
}

export function parseQueueMutation(value: unknown): QueueMutationCommand {
  if (!Check(QueueMutationCommandSchema, value)) throw new TypeError("Queue mutation is invalid");
  return value;
}

export function parseImageAttachmentCommand(value: unknown): ImageAttachmentCommand {
  if (!Check(ImageAttachmentCommandSchema, value)) throw new TypeError("Image command is invalid");
  return value;
}

export interface ParsedControlCommand {
  generation: string;
  commandEpoch: string;
  command: SessionHostCommand;
}

export function parseControlCommand(value: unknown): ParsedControlCommand {
  if (Check(ModelControlCommandSchema, value)) {
    const input: ModelControlCommand = value;
    return {
      generation: input.generation,
      commandEpoch: input.commandEpoch,
      command:
        input.type === "set-model"
          ? {
              type: "set_model",
              commandId: input.commandId,
              provider: input.provider,
              model: input.modelId,
            }
          : {
              type: "set_thinking",
              commandId: input.commandId,
              level: input.thinkingLevel,
            },
    };
  }
  const input = record(value);
  if (input.version !== PROTOCOL_VERSION || input.type !== "control")
    throw new TypeError("Control envelope is invalid");
  const commandId = text(input.commandId, "commandId", 256);
  const generation = text(input.generation, "generation", 128);
  const commandEpoch = text(input.commandEpoch, "commandEpoch", 128);
  if (!GENERATION.test(generation) || !GENERATION.test(commandEpoch))
    throw new TypeError("Control generation is invalid");
  if (input.control === "abort") {
    exactKeys(input, ["version", "type", "commandId", "generation", "commandEpoch", "control"]);
    return { generation, commandEpoch, command: { type: "abort", commandId } };
  }
  if (input.control === "compact") {
    const keys = [
      "version",
      "type",
      "commandId",
      "generation",
      "commandEpoch",
      "control",
      ...(input.instructions === undefined ? [] : ["instructions"]),
    ];
    exactKeys(input, keys);
    return {
      generation,
      commandEpoch,
      command: {
        type: "compact",
        commandId,
        ...(input.instructions === undefined
          ? {}
          : { instructions: text(input.instructions, "instructions", MAX_COMMAND_TEXT) }),
      },
    };
  }
  throw new TypeError("Control command is invalid");
}

export function parseEmptyRequest(value: unknown): Record<string, never> {
  const input = record(value);
  exactKeys(input, []);
  return {};
}

export function assertControlPlaneOutput(value: unknown): void {
  if (value === undefined || JSON.stringify(value).length > 128 * 1024)
    throw new TypeError("Invalid control-plane output");
}
