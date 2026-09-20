import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const args = ["--mode", "rpc", "--no-session", "--agentflow-raw", "--tools", "agentflow_workflow"];
if (process.env.PI_AGENTFLOW_SMOKE_MODEL)
  args.push("--model", process.env.PI_AGENTFLOW_SMOKE_MODEL);
const child = spawn("pi", args, {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "pipe"],
});
const decoder = new StringDecoder("utf8");
let buffer = "",
  stderr = "";
let updates = 0,
  passed = false,
  done = false;
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const finish = (error) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  child.kill("SIGTERM");
  if (error) {
    console.error(error.message);
    if (stderr) console.error(stderr);
    process.exitCode = 1;
  } else console.log(`RPC workflow smoke passed: updates=${updates}, parallelNodes=2`);
};
const handle = (line) => {
  if (!line.trim()) return;
  const event = JSON.parse(line);
  if (event.type === "extension_error") return finish(new Error(event.error));
  if (event.type === "tool_execution_update" && event.toolName === "agentflow_workflow")
    updates += 1;
  if (event.type === "tool_execution_end" && event.toolName === "agentflow_workflow") {
    const snapshot = event.result?.details?.snapshot;
    passed =
      !event.isError &&
      snapshot?.status === "completed" &&
      snapshot.nodes?.length === 2 &&
      snapshot.nodes.every((node) => node.status === "completed");
  }
  if (event.type === "agent_settled")
    finish(
      passed && updates > 0
        ? undefined
        : new Error(`Workflow lifecycle incomplete (passed=${passed}, updates=${updates})`),
    );
};
child.stdout.on("data", (chunk) => {
  buffer += decoder.write(chunk);
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    handle(line);
  }
});
child.on("error", finish);
child.on("exit", (code) => {
  if (!done) finish(new Error(`Pi exited early: ${code}`));
});
const timer = setTimeout(() => finish(new Error("RPC workflow smoke timed out")), 240_000);
const script = `export const meta = { name: "rpc_parallel", description: "RPC parallel smoke", phases: [{ title: "Run" }] }\nphase("Run")\nconst values = await parallel([\n  () => agent("Reply exactly A", { label: "alpha", tools: false }),\n  () => agent("Reply exactly B", { label: "beta", tools: false }),\n])\nreturn { values }`;
child.stdin.write(
  `${JSON.stringify({ type: "prompt", message: `Call agentflow_workflow exactly once with this exact script and no other fields:\n\n${script}\n\nThen report the result.` })}\n`,
);
