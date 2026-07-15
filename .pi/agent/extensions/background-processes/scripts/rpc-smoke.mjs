import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const extensionPath = new URL("../src/index.ts", import.meta.url).pathname;
const child = spawn("pi", ["--mode", "rpc", "--no-session", "--extension", extensionPath], {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "pipe"],
});
const decoder = new StringDecoder("utf8");
let buffer = "";
let stderr = "";
let finished = false;
let commandsVerified = false;
let stateVerified = false;
let statusVerified = false;
let lifecycleVerified = false;

const maybeFinish = () => {
  if (commandsVerified && stateVerified && statusVerified && lifecycleVerified) finish();
};

const finish = (error) => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  child.kill("SIGTERM");
  if (error) {
    console.error(error.message);
    if (stderr) console.error(stderr);
    process.exitCode = 1;
    return;
  }
  console.log(
    "RPC smoke passed: extension commands, status UI events, state, and new-session lifecycle were observable without an LLM/tool-execute request.",
  );
};

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});
child.stdout.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    let line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      finish(new Error(`Invalid RPC JSON: ${line}`));
      return;
    }
    if (event.type === "extension_error") {
      finish(new Error(`Extension error: ${event.error}`));
      return;
    }
    if (
      event.type === "extension_ui_request" &&
      event.method === "setStatus" &&
      event.statusKey === "background-processes" &&
      !("statusText" in event)
    ) {
      statusVerified = true;
      maybeFinish();
      return;
    }
    if (event.type === "response" && event.id === "commands") {
      const names = new Set(
        (event.data?.commands ?? event.data ?? []).map((command) => command.name),
      );
      const expected = ["background-tasks", "background-stop", "background-tail"];
      if (
        !event.success ||
        event.command !== "get_commands" ||
        expected.some((name) => !names.has(name))
      ) {
        finish(new Error(`Background commands missing from RPC response: ${line}`));
      } else {
        commandsVerified = true;
        maybeFinish();
      }
      return;
    }
    if (event.type === "response" && event.id === "smoke") {
      if (!event.success || event.command !== "get_state") {
        finish(new Error(`Unexpected RPC response: ${line}`));
      } else {
        stateVerified = true;
        maybeFinish();
      }
      return;
    }
    if (event.type === "response" && event.id === "lifecycle") {
      if (!event.success || event.command !== "new_session" || event.data?.cancelled !== false) {
        finish(new Error(`Unexpected lifecycle response: ${line}`));
      } else {
        lifecycleVerified = true;
        maybeFinish();
      }
      return;
    }
  }
});
child.on("error", (error) => finish(error));
child.on("exit", (code) => {
  if (!finished) finish(new Error(`Pi exited early with code ${code}`));
});

const timer = setTimeout(() => finish(new Error("RPC smoke timed out")), 15_000);
child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
child.stdin.write(`${JSON.stringify({ id: "smoke", type: "get_state" })}\n`);
child.stdin.write(`${JSON.stringify({ id: "lifecycle", type: "new_session" })}\n`);
