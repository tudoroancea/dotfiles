import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { RunResult, RunSnapshot } from "../types.ts";

const MAX_JSON = 512_000;
function safe(value: unknown, max = MAX_JSON): string {
  const seen = new WeakSet<object>();
  let text: string;
  try {
    text =
      JSON.stringify(
        value,
        (_key, item) => {
          if (typeof item === "bigint") return String(item);
          if (item && typeof item === "object") {
            if (seen.has(item)) return "[Circular]";
            seen.add(item);
          }
          return item;
        },
        2,
      ) ?? "null";
  } catch {
    text = JSON.stringify({ error: "Value was not serializable" });
  }
  return Buffer.byteLength(text) <= max
    ? text
    : JSON.stringify({ truncated: true, preview: text.slice(0, max / 2) }, null, 2);
}
async function atomic(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
}

export class ArtifactStore {
  readonly root: string;
  private timers = new Map<string, NodeJS.Timeout>();
  constructor(root = join(getAgentDir(), "agentflow")) {
    this.root = root;
  }
  async recover(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      const path = join(this.root, name, "run.json");
      try {
        const data = JSON.parse(await readFile(path, "utf8"));
        if (data.status === "running" || data.status === "queued") {
          data.status = "aborted";
          data.error = "Pi exited before the run settled";
          data.completedAt = new Date().toISOString();
          await atomic(path, safe(data));
        }
      } catch {
        /* ignore incomplete artifacts */
      }
    }
  }
  async create(runId: string, script: string, args: unknown): Promise<string> {
    const dir = join(this.root, runId);
    await mkdir(dir, { recursive: true });
    await Promise.all([
      atomic(join(dir, "script.js"), script.slice(0, 256_000)),
      atomic(join(dir, "args.json"), safe(args, 128_000)),
    ]);
    return dir;
  }
  checkpoint(snapshot: RunSnapshot): void {
    if (!snapshot.artifactDir || this.timers.has(snapshot.runId)) return;
    this.timers.set(
      snapshot.runId,
      setTimeout(() => {
        this.timers.delete(snapshot.runId);
        void atomic(join(snapshot.artifactDir!, "run.json"), safe(snapshot)).catch(() => undefined);
      }, 250),
    );
  }
  async finish(result: RunResult): Promise<void> {
    const dir = result.snapshot.artifactDir;
    if (!dir) return;
    const timer = this.timers.get(result.runId);
    if (timer) clearTimeout(timer);
    this.timers.delete(result.runId);
    const transcripts = result.snapshot.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      originTool: n.originTool,
      semanticRole: n.semanticRole,
      status: n.status,
      toolCalls: n.toolCalls,
      result: n.resultPreview,
      error: n.error,
      sessionFile: n.sessionFile,
    }));
    await Promise.all([
      atomic(join(dir, "run.json"), safe(result.snapshot)),
      atomic(
        join(dir, "result.json"),
        safe({ status: result.status, result: result.result, error: result.error }),
      ),
      atomic(join(dir, "transcripts.json"), safe(transcripts, 256_000)),
    ]);
  }
}
