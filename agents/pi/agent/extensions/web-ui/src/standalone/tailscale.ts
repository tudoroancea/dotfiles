import { spawn } from "node:child_process";

// Standalone Tailscale Serve convenience: publishes the loopback origin on the
// tailnet and reports the resulting `*.ts.net` URL. Owns balanced process cleanup,
// including an emergency teardown registered on process exit.

export interface TailscaleServe {
  close(): Promise<void>;
}

export function startTailscaleServe(
  localOrigin: string,
  port: number,
  onReady: (origin: string) => void,
  onFailure: (reason: string) => void,
): TailscaleServe {
  const child = spawn("tailscale", ["serve", "--yes", `--https=${port}`, localOrigin], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  let ready = false;
  let closing = false;
  let failureReported = false;
  let processClosed = false;
  const emergencyCleanup = () => killProcessTree("SIGTERM");
  process.once("exit", emergencyCleanup);
  const closed = new Promise<void>((resolvePromise) => {
    child.once("close", () => {
      processClosed = true;
      process.off("exit", emergencyCleanup);
      resolvePromise();
    });
  });

  function inspectOutput(chunk: Buffer): void {
    output = (output + chunk.toString("utf8")).slice(-8192);
    const match = output.match(/https:\/\/[^\s/]+\.ts\.net(?::\d+)?/i);
    if (!match || ready) return;
    ready = true;
    onReady(match[0]);
  }

  function reportFailure(reason: string): void {
    if (closing || failureReported) return;
    failureReported = true;
    onFailure(reason);
  }

  function killProcessTree(signal: NodeJS.Signals): void {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // The process group may already have exited; fall back to the direct child.
      }
    }
    child.kill(signal);
  }

  function waitForClose(timeoutMs: number): Promise<boolean> {
    if (processClosed) return Promise.resolve(true);
    return new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise(false), timeoutMs);
      void closed.then(() => {
        clearTimeout(timer);
        resolvePromise(true);
      });
    });
  }

  child.stdout.on("data", inspectOutput);
  child.stderr.on("data", (chunk: Buffer) => {
    errorOutput = (errorOutput + chunk.toString("utf8")).slice(-4096);
    inspectOutput(chunk);
  });
  child.on("error", (error) => reportFailure(error.message));
  child.on("exit", (code, signal) => {
    if (closing) return;
    const detail = errorOutput.trim().split("\n").at(-1);
    reportFailure(
      detail ||
        (signal
          ? `tailscale serve stopped (${signal})`
          : `tailscale serve exited with code ${code ?? "unknown"}`),
    );
  });

  return {
    async close() {
      closing = true;
      if (processClosed) return;
      killProcessTree("SIGTERM");
      if (await waitForClose(2000)) return;
      killProcessTree("SIGKILL");
      await waitForClose(1000);
    },
  };
}
