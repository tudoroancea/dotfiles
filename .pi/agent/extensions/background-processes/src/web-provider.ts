import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessRuntime } from "./runtime/process-runtime.ts";
import { serializeJobs } from "./runtime/results.ts";

const DISCOVER = "web-ui:provider-discover";
const REGISTER = "web-ui:provider-register";

export function registerBackgroundWebProvider(
  pi: ExtensionAPI,
  getRuntime: () => ProcessRuntime | undefined,
): () => void {
  let discovered = false;
  const supported = typeof pi.events?.on === "function" && typeof pi.events?.emit === "function";
  const announce = () => {
    if (!supported || !discovered) return;
    pi.events.emit(REGISTER, {
      id: "background",
      getSnapshot: () => {
        const runtime = getRuntime();
        return runtime ? { jobs: serializeJobs(runtime.list()).jobs } : { jobs: [] };
      },
      subscribe: (listener: () => void) => getRuntime()?.subscribe(() => listener()) ?? (() => {}),
      async action(action: string, payload: unknown) {
        const runtime = getRuntime();
        if (!runtime) throw new Error("Background runtime unavailable");
        const input = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        const jobId = typeof input.jobId === "string" ? input.jobId : "";
        if (!jobId) throw new Error("jobId is required");
        if (action === "stop") {
          await runtime.stopMany([jobId]);
          return { jobs: serializeJobs(runtime.list()).jobs };
        }
        if (action === "tail") {
          const tailLines = typeof input.tailLines === "number" ? Math.max(0, Math.min(200, Math.floor(input.tailLines))) : 100;
          const records = runtime.resolve([jobId]);
          const tail = runtime.tail(jobId);
          if (tail) records[0] = { ...records[0]!, terminalTail: tail };
          const detailed = serializeJobs(records, { includeTails: true, tailLines }).jobs[0];
          return {
            jobs: serializeJobs(runtime.list()).jobs.map((job) =>
              job.jobId === jobId && detailed ? detailed : job,
            ),
          };
        }
        throw new Error(`Unsupported background dashboard action: ${action}`);
      },
    });
  };
  if (supported) {
    pi.events.on(DISCOVER, () => {
      discovered = true;
      announce();
    });
  }
  return announce;
}
