import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const worker = resolve("src/runtime/sandbox-worker.mjs");
function run(code: string, respond = true): Promise<any> {
  return new Promise((resolveResult, reject) => {
    const token = "test-token";
    const child = spawn(process.execPath, ["--permission", worker, token], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {},
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("sandbox test timed out"));
    }, 3000);
    child.on("error", reject);
    child.on("message", (message: any) => {
      if (message.type === "request" && respond)
        child.send({
          token,
          type: "response",
          id: message.id,
          result: { ok: true, output: "ok", aborted: false, usage: {} },
        });
      if (message.type === "done" || message.type === "failed") {
        clearTimeout(timer);
        child.kill();
        resolveResult(message);
      }
    });
    child.send({ token, type: "init", code, args: {}, cwd: "/tmp", budget: {}, vmTimeoutMs: 50 });
  });
}

describe("workflow sandbox process", () => {
  it("has no ambient process global and completes agent requests", async () => {
    const result = await run(
      `(async () => ({ ambient: typeof process, output: (await agent("x")).output }))()`,
    );
    expect(result).toMatchObject({ type: "done", result: { ambient: "undefined", output: "ok" } });
  });

  it("exposes semantic helpers through the same request channel", async () => {
    const result = await run(
      `(async () => ({ output: (await look_at({ path: "screen.png", objective: "inspect" })).output }))()`,
    );
    expect(result).toMatchObject({ type: "done", result: { output: "ok" } });
  });

  it("interrupts non-yielding synchronous code", async () => {
    const result = await run(`(async () => { while (true) {} })()`);
    expect(result.type).toBe("failed");
    expect(result.error).toContain("timed out");
  });

  it("rejects unawaited agent requests", async () => {
    const result = await run(`(async () => { agent("x"); return "early" })()`, false);
    expect(result).toMatchObject({ type: "failed" });
    expect(result.error).toContain("unawaited agent");
  });
});
