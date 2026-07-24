import { spawn } from "node:child_process";

const child = spawn("pi", ["--mode", "rpc", "--no-session"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => (stdout += chunk));
child.stderr.on("data", (chunk) => (stderr += chunk));
child.stdin.end(`${JSON.stringify({ id: "web-ui-smoke", type: "get_state" })}\n`);

const timeout = setTimeout(() => child.kill("SIGTERM"), 15_000);
const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code));
});
clearTimeout(timeout);

if (exitCode !== 0) throw new Error(`RPC process exited with ${exitCode}\n${stderr}`);
const records = stdout
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
if (!records.some((record) => record.id === "web-ui-smoke" && record.success === true)) {
  throw new Error(`RPC response missing from stdout:\n${stdout}`);
}
if (!/^Pi Web UI: http:\/\/127\.0\.0\.1:\d+\/$/m.test(stderr)) {
  throw new Error(`Diagnostic URL missing from stderr:\n${stderr}`);
}
if (stdout.includes("Pi Web UI:") || stdout.includes("bootstrap=")) {
  throw new Error(`Web UI diagnostics or credentials leaked to RPC stdout:\n${stdout}`);
}
console.log(`RPC smoke passed (${records.length} JSONL records)`);
