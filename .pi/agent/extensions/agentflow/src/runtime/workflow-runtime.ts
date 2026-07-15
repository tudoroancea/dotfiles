import { spawn, type Serializable } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AgentNodeSpec,
  JsonSchemaObject,
  RunLimits,
  RunResult,
  SemanticRole,
  SubagentConfig,
} from "../types.ts";
import type { SemanticAgentService } from "../semantic/semantic-agent-service.ts";
import { RunEngine } from "./run-engine.ts";
import { transformWorkflowScript, validateWorkflowScript } from "./workflow-parser.ts";

const MAX_SOURCE = 256_000,
  MAX_ARGS = 128_000,
  MAX_MESSAGE = 512_000;
interface AgentOptions extends SubagentConfig {
  label?: string;
  phase?: string;
  schema?: JsonSchemaObject;
  failFast?: boolean;
  dependsOn?: string[];
}
const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v) ?? "null");
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function assertNoTrustedPolicySelection(options: Record<string, unknown>): void {
  for (const protectedKey of ["semanticRole", "capabilityPolicy", "policy"])
    if (protectedKey in options)
      throw new Error(`agent() cannot select trusted semantic policy via ${protectedKey}`);
}

export async function executeWorkflow(input: {
  script: string;
  args?: unknown;
  limits?: RunLimits;
  background?: boolean;
  ctx: ExtensionContext;
  signal?: AbortSignal;
  onUpdate?: (snapshot: any) => void;
  engine: RunEngine;
  semanticService: SemanticAgentService;
}): Promise<RunResult | { runId: string; snapshot: any }> {
  if (Buffer.byteLength(input.script) > MAX_SOURCE)
    throw new Error(`Workflow source exceeds ${MAX_SOURCE} bytes`);
  if (size(input.args) > MAX_ARGS) throw new Error(`Workflow args exceed ${MAX_ARGS} bytes`);
  const meta = validateWorkflowScript(input.script);
  const runId = input.engine.startRun(
    {
      kind: "workflow",
      name: meta.name,
      description: meta.description,
      limits: input.limits,
      background: input.background,
      originTool: "agentflow_workflow",
    },
    input.ctx,
    input.background ? undefined : input.signal,
    input.onUpdate,
  );
  try {
    await input.engine.setArtifact(runId, input.script, input.args);
  } catch (error) {
    return input.engine.finish(
      runId,
      "failed",
      undefined,
      `Artifact initialization failed: ${errorText(error)}`,
    );
  }
  const alreadySettled = input.engine.getResult(runId);
  if (alreadySettled) return alreadySettled;
  const execution = runSandbox(
    runId,
    meta.phases.map((p) => p.title),
    input,
  ).then(
    (value) => input.engine.finish(runId, "completed", value),
    async (error) => {
      const aborted = input.engine.isRunAborted(runId);
      await input.engine.abortAndWait(runId);
      return input.engine.finish(
        runId,
        aborted ? "aborted" : "failed",
        undefined,
        errorText(error),
      );
    },
  );
  if (input.background) {
    void execution;
    return { runId, snapshot: input.engine.getSnapshot(runId) };
  }
  return execution;
}

async function runSandbox(
  runId: string,
  declaredPhases: string[],
  input: Parameters<typeof executeWorkflow>[0],
): Promise<unknown> {
  const token = randomBytes(24).toString("hex");
  const worker = fileURLToPath(new URL("./sandbox-worker.mjs", import.meta.url));
  const child = spawn(process.execPath, ["--permission", worker, token], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {},
    windowsHide: true,
  });
  const runSignal = input.engine.getRunAbortSignal(runId);
  let sequence = 0;
  let settled = false;
  const pendingTasks = new Set<Promise<unknown>>();
  const sandboxTimer = setTimeout(() => {
    void input.engine.cancel([runId], false);
  }, input.limits?.timeoutMs ?? 600_000);
  const terminate = () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1000).unref();
    }
  };
  runSignal.addEventListener("abort", terminate, { once: true });
  return new Promise((resolve, reject) => {
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(sandboxTimer);
      terminate();
      reject(e);
    };
    const send = (message: Serializable) => {
      if (settled) return;
      if (!child.connected) return fail(new Error("Workflow sandbox IPC disconnected"));
      try {
        child.send(message, (error) => {
          if (error) fail(new Error(`Workflow sandbox IPC send failed: ${error.message}`));
        });
      } catch (error) {
        fail(error);
      }
    };
    child.stderr?.on("data", (d) => {
      if (d.length > MAX_MESSAGE) fail(new Error("Sandbox stderr limit exceeded"));
    });
    child.on("error", fail);
    child.on("disconnect", () => fail(new Error("Workflow sandbox IPC disconnected")));
    child.on("exit", (code, sig) => {
      if (!settled) fail(new Error(`Workflow sandbox exited (${sig ?? code})`));
    });
    child.on("message", (raw: any) => {
      try {
        if (!raw || raw.token !== token || size(raw) > MAX_MESSAGE)
          return fail(new Error("Invalid or oversized sandbox message"));
        if (raw.type === "event") {
          if (raw.eventType === "phase") {
            if (
              typeof raw.value !== "string" ||
              (declaredPhases.length && !declaredPhases.includes(raw.value))
            )
              return fail(new Error(`Undeclared phase: ${raw.value}`));
            input.engine.addPhase(runId, raw.value);
          } else input.engine.log(runId, String(raw.value));
          return;
        }
        if (raw.type === "request") {
          const semanticRoles: SemanticRole[] = [
            "finder",
            "oracle",
            "librarian",
            "look_at",
            "delegate",
            "review",
          ];
          if (semanticRoles.includes(raw.requestType)) {
            if (!raw.payload || typeof raw.payload !== "object" || Array.isArray(raw.payload))
              return fail(new Error(`Invalid ${raw.requestType} request`));
            const role = raw.requestType as SemanticRole;
            const id = `task_${++sequence}`;
            const task = input.semanticService.runInWorkflow(runId, role, raw.payload, id);
            pendingTasks.add(task);
            void task.then(
              (result) => {
                pendingTasks.delete(task);
                send({ token, type: "response", id: raw.id, result });
              },
              (error) => {
                pendingTasks.delete(task);
                fail(error);
              },
            );
            return;
          }
          if (
            raw.requestType !== "agent" ||
            typeof raw.payload?.prompt !== "string" ||
            !raw.payload.prompt.trim()
          )
            return fail(new Error("Invalid agent request"));
          if (
            raw.payload.options !== undefined &&
            (!raw.payload.options ||
              typeof raw.payload.options !== "object" ||
              Array.isArray(raw.payload.options))
          )
            return fail(new Error("agent() options must be an object"));
          const options = (raw.payload.options ?? {}) as AgentOptions & Record<string, unknown>;
          try {
            assertNoTrustedPolicySelection(options);
          } catch (error) {
            return fail(error);
          }
          if (options.label !== undefined && typeof options.label !== "string")
            return fail(new Error("agent() label must be a string"));
          if (options.phase !== undefined && typeof options.phase !== "string")
            return fail(new Error("agent() phase must be a string"));
          if (options.failFast !== undefined && typeof options.failFast !== "boolean")
            return fail(new Error("agent() failFast must be boolean"));
          const id = `task_${++sequence}`;
          const label = options.label?.trim() || id;
          const config: SubagentConfig = {
            systemPrompt: options.systemPrompt,
            appendSystemPrompt: options.appendSystemPrompt,
            model: options.model,
            thinking: options.thinking,
            tools: options.tools,
            skills: options.skills,
            extensions: options.extensions,
            cwd: options.cwd,
            session: options.session,
            outputSchema: options.schema ?? options.outputSchema,
            timeoutMs: options.timeoutMs,
            toolTimeoutMs: options.toolTimeoutMs,
            trustProject: options.trustProject,
          };
          const node: AgentNodeSpec = {
            id,
            label,
            prompt: raw.payload.prompt,
            phase: options.phase,
            dependsOn: options.dependsOn,
            originTool: "agentflow_workflow",
            config,
          };
          const task = input.engine.runTask(runId, node);
          pendingTasks.add(task);
          void task.then(
            (result) => {
              pendingTasks.delete(task);
              if (!result.ok && options.failFast)
                return fail(new Error(result.error ?? "Agent task failed"));
              send({ token, type: "response", id: raw.id, result });
            },
            (error) => {
              pendingTasks.delete(task);
              fail(error);
            },
          );
          return;
        }
        if (raw.type === "done") {
          if (runSignal.aborted) return fail(new DOMException("Run aborted", "AbortError"));
          if (pendingTasks.size > 0)
            return fail(
              new Error(
                `Workflow returned while ${pendingTasks.size} agent task(s) were still settling`,
              ),
            );
          if (size(raw.result) > MAX_MESSAGE)
            return fail(new Error("Workflow result exceeds size limit"));
          settled = true;
          clearTimeout(sandboxTimer);
          terminate();
          resolve(raw.result);
        } else if (raw.type === "failed") fail(new Error(String(raw.error)));
      } catch (error) {
        fail(error);
      }
    });
    const limits = input.engine.getLimits(runId);
    send({
      token,
      type: "init",
      code: transformWorkflowScript(input.script),
      args: structuredClone(input.args),
      cwd: input.ctx.cwd,
      budget: { limit: limits.tokenBudget },
      vmTimeoutMs: 1000,
    });
  });
}
