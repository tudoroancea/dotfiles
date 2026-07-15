import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const args = ["--mode", "rpc", "--no-session", "--agentflow-raw", "--tools", "agentflow_agent"];
if (process.env.PI_AGENTFLOW_SMOKE_MODEL)
  args.push("--model", process.env.PI_AGENTFLOW_SMOKE_MODEL);
const child = spawn("pi", args, {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "pipe"],
});
const decoder = new StringDecoder("utf8");
let buffer = "";
let stderr = "";
let sawStart = false;
let sawUpdate = false;
let sawEnd = false;
let settled = false;
const events = [];

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});
const finish = (error) => {
  clearTimeout(timer);
  child.kill("SIGTERM");
  if (error) {
    console.error(error.message);
    if (stderr) console.error(stderr);
    process.exitCode = 1;
  } else {
    console.log(`RPC smoke passed: start=${sawStart} update=${sawUpdate} end=${sawEnd}`);
  }
};
const handle = (line) => {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return finish(new Error(`Invalid RPC JSON: ${line}`));
  }
  events.push(event);
  if (event.type === "extension_error") return finish(new Error(`Extension error: ${event.error}`));
  if (event.type === "tool_execution_start" && event.toolName === "agentflow_agent")
    sawStart = true;
  if (
    event.type === "tool_execution_update" &&
    event.toolName === "agentflow_agent" &&
    event.partialResult?.details?.snapshot
  )
    sawUpdate = true;
  if (event.type === "tool_execution_end" && event.toolName === "agentflow_agent") {
    sawEnd =
      !event.isError &&
      event.result?.details?.snapshot?.status === "completed" &&
      event.result?.details?.result?.answer === "CHILD_OK";
  }
  if (event.type === "agent_settled") {
    settled = true;
    if (!sawStart || !sawUpdate || !sawEnd)
      finish(
        new Error(
          `Missing agentflow lifecycle events. start=${sawStart} update=${sawUpdate} end=${sawEnd}\n${JSON.stringify(events.slice(-8), null, 2)}`,
        ),
      );
    else finish();
  }
};
child.stdout.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    let line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    handle(line);
  }
});
child.on("error", (error) => finish(error));
child.on("exit", (code) => {
  if (!settled && process.exitCode !== 1) finish(new Error(`Pi exited early with code ${code}`));
});
const timer = setTimeout(() => finish(new Error("RPC smoke timed out")), 180_000);
child.stdin.write(
  `${JSON.stringify({ id: "smoke", type: "prompt", message: "You must call agentflow_agent exactly once with prompt 'Return answer CHILD_OK', label 'rpc smoke', tools false, and outputSchema {type:'object', properties:{answer:{type:'string'}}, required:['answer'], additionalProperties:false}. Then report its result." })}\n`,
);
