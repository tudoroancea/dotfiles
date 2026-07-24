import { Buffer } from "node:buffer";
import { Check } from "typebox/value";
import { LIMITS } from "../shared/limits.js";
import { ClientCommandSchema, type ClientCommand } from "../shared/wire.js";

export { ClientCommandSchema, type ClientCommand } from "../shared/wire.js";

export function parseClientCommand(value: string): ClientCommand {
  if (Buffer.byteLength(value, "utf8") > LIMITS.incomingWebSocketBytes) {
    throw new Error("Command exceeds the WebSocket byte limit");
  }
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
