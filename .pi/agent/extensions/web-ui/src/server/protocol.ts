import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { LIMITS } from "../shared/limits.js";

const commandId = Type.String({ minLength: 1, maxLength: LIMITS.commandIdUtf8Bytes });
const content = Type.String({ minLength: 1, maxLength: LIMITS.promptUtf8Bytes });

export const ClientCommandSchema = Type.Union([
  Type.Object(
    { type: Type.Literal("prompt"), commandId, content },
    { additionalProperties: false },
  ),
  Type.Object({ type: Type.Literal("steer"), commandId, content }, { additionalProperties: false }),
  Type.Object(
    { type: Type.Literal("follow_up"), commandId, content },
    { additionalProperties: false },
  ),
  Type.Object({ type: Type.Literal("abort"), commandId }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("snapshot"), commandId }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("ping"), commandId }, { additionalProperties: false }),
]);

export type ClientCommand = Static<typeof ClientCommandSchema>;

export function parseClientCommand(value: string): ClientCommand {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid JSON command");
  }
  if (!Check(ClientCommandSchema, parsed)) throw new Error("Invalid command payload");

  const command = parsed as ClientCommand;
  if (Buffer.byteLength(command.commandId, "utf8") > LIMITS.commandIdUtf8Bytes) {
    throw new Error("Command ID exceeds the UTF-8 byte limit");
  }
  if ("content" in command && Buffer.byteLength(command.content, "utf8") > LIMITS.promptUtf8Bytes) {
    throw new Error("Prompt exceeds the UTF-8 byte limit");
  }
  return command;
}
