import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

const packageRoot = new URL("..", import.meta.url);
const expectedExtensionPath = await realpath(
  fileURLToPath(new URL("../src/index.ts", import.meta.url)),
);
const defaultTools = [
  "agentflow_cancel",
  "agentflow_delegate",
  "agentflow_finder",
  "agentflow_librarian",
  "agentflow_look_at",
  "agentflow_oracle",
  "agentflow_review",
  "agentflow_status",
  "agentflow_steer",
  "agentflow_wait",
];

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  child.kill("SIGTERM");
  const closed = new Promise((resolve) => child.once("close", resolve));
  const graceful = await Promise.race([
    closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!graceful) {
    child.kill("SIGKILL");
    await closed;
  }
}

async function verifyInstalledConfiguration(raw) {
  const args = ["--mode", "rpc", "--no-session", ...(raw ? ["--agentflow-raw"] : [])];
  const child = spawn("pi", args, {
    cwd: packageRoot,
    env: { ...process.env, PI_AGENTFLOW_CONFIG_SMOKE: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const decoder = new StringDecoder("utf8");
  const pending = new Map();
  const eventWaiters = [];
  let sequence = 0;
  let buffer = "";
  let stderr = "";
  let reloadError;
  let fatalError;
  let stopping = false;
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdin.on("error", (error) => {
    fatalError ??= error;
  });
  child.on("error", (error) => {
    fatalError ??= error;
    for (const waiter of eventWaiters.splice(0)) waiter.reject(error);
  });
  child.on("exit", (code, signal) => {
    if (stopping) return;
    const error = new Error(`Pi exited early (${signal ?? code})`);
    fatalError ??= error;
    for (const waiter of eventWaiters.splice(0)) waiter.reject(error);
  });
  const dispatch = (event) => {
    if (event.id && pending.has(event.id)) {
      pending.get(event.id)(event);
      pending.delete(event.id);
    }
    if (event.type === "extension_error") {
      if (String(event.extensionPath ?? "").includes("command:agentflow-config-reload"))
        reloadError = event.error;
      if (String(event.extensionPath ?? "").includes("/agentflow/")) fatalError = event.error;
    }
    for (let index = eventWaiters.length - 1; index >= 0; index--) {
      if (!eventWaiters[index].predicate(event)) continue;
      eventWaiters.splice(index, 1)[0].resolve(event);
    }
  };
  child.stdout.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        dispatch(JSON.parse(line));
      } catch (error) {
        fatalError ??= new Error(`Invalid RPC JSON: ${line}`, { cause: error });
      }
    }
  });
  const request = (command) =>
    new Promise((resolve, reject) => {
      const id = `request-${++sequence}`;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
        if (error) {
          pending.delete(id);
          reject(error);
        }
      });
    });
  const waitForEvent = (predicate) =>
    new Promise((resolve, reject) => eventWaiters.push({ predicate, resolve, reject }));
  const timeout = setTimeout(() => {
    fatalError ??= new Error(`${raw ? "raw" : "default"} RPC configuration smoke timed out`);
    for (const resolve of pending.values()) resolve({ success: false, error: fatalError.message });
    pending.clear();
    for (const waiter of eventWaiters.splice(0)) waiter.reject(fatalError);
  }, 30_000);
  const verifyCommands = async (stage) => {
    const response = await request({ type: "get_commands" });
    if (!response.success) throw new Error(`${stage} get_commands failed: ${response.error}`);
    const command = response.data?.commands?.find((item) => item.name === "agentflow-status");
    if (!command) throw new Error(`${stage}: installed agentflow commands are unavailable`);
    const actualPath = await realpath(command.sourceInfo?.path ?? "");
    if (actualPath !== expectedExtensionPath)
      throw new Error(`${stage}: expected ${expectedExtensionPath}, loaded ${actualPath}`);
  };
  const verifyTools = async (stage) => {
    const notification = waitForEvent(
      (event) =>
        event.type === "extension_ui_request" &&
        event.method === "notify" &&
        String(event.message).startsWith("AGENTFLOW_CONFIG_SMOKE "),
    );
    const response = await request({ type: "prompt", message: "/agentflow-config-smoke" });
    if (!response.success) throw new Error(`${stage} diagnostic command failed: ${response.error}`);
    const event = await notification;
    const report = JSON.parse(event.message.slice("AGENTFLOW_CONFIG_SMOKE ".length));
    const expected = raw
      ? [...defaultTools, "agentflow_agent", "agentflow_workflow"].sort()
      : defaultTools;
    if (JSON.stringify(report.all) !== JSON.stringify(expected))
      throw new Error(`${stage}: unexpected tools ${JSON.stringify(report.all)}`);
    const missingActive = expected.filter((name) => !report.active.includes(name));
    if (missingActive.length)
      throw new Error(`${stage}: registered tools are inactive: ${missingActive.join(", ")}`);
  };

  try {
    await verifyCommands("before reload");
    await verifyTools("before reload");
    const reload = await request({ type: "prompt", message: "/agentflow-config-reload" });
    if (!reload.success) throw new Error(`/reload failed: ${reload.error}`);
    if (reloadError) throw new Error(`/reload extension error: ${reloadError}`);
    await verifyCommands("after reload");
    await verifyTools("after reload");
    if (fatalError) throw fatalError;
  } finally {
    clearTimeout(timeout);
    stopping = true;
    await stopChild(child);
  }
  if (fatalError) throw new Error(`${fatalError.message}${stderr ? `\n${stderr}` : ""}`);
}

await verifyInstalledConfiguration(false);
await verifyInstalledConfiguration(true);
console.log("Installed RPC configuration smoke passed before and after /reload (default + raw).");
