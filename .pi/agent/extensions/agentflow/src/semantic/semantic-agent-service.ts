import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AgentTaskResult,
  AgentNodeSpec,
  RunResult,
  RunSnapshot,
  SemanticRole,
} from "../types.ts";
import type { RunEngine } from "../runtime/run-engine.ts";
import { ownershipOverlaps } from "./ownership.ts";
import {
  semanticProfiles,
  validateSemanticInput,
  type DelegateInput,
  type FinderInput,
  type LibrarianInput,
  type LookAtInput,
  type OracleInput,
  type ReviewInput,
  type SemanticInput,
} from "./profiles.ts";

interface ToolInfo {
  name: string;
  sourceInfo?: { path?: string; source?: string };
}

const SEARCH_EXTENSION = fileURLToPath(new URL("../enable-search-tools.ts", import.meta.url));
const SEARCH_ROLES = new Set<SemanticRole>(["finder", "oracle", "delegate", "review"]);
const BACKGROUND_TOOLS = [
  "background_bash",
  "monitor",
  "background_status",
  "background_wait",
  "background_stop",
] as const;

const promptCache = new Map<string, Promise<string>>();
const promptFor = (asset: string): Promise<string> => {
  let prompt = promptCache.get(asset);
  if (!prompt) {
    prompt = readFile(new URL(`./prompts/${asset}`, import.meta.url), "utf8").then((text) =>
      text.trim(),
    );
    promptCache.set(asset, prompt);
  }
  return prompt;
};
const list = (title: string, values: readonly string[] | undefined): string =>
  values?.length ? `\n\n${title}:\n${values.map((value) => `- ${value}`).join("\n")}` : "";

function taskMessage(role: SemanticRole, input: SemanticInput): string {
  if (role === "finder") {
    const value = input as FinderInput;
    return `${value.task}${list("Suggested paths", value.paths)}`;
  }
  if (role === "oracle") {
    const value = input as OracleInput;
    return `${value.question}${list("Files available for selective inspection", value.files)}`;
  }
  if (role === "librarian") return (input as LibrarianInput).question;
  if (role === "look_at") {
    const value = input as LookAtInput;
    return `Read and analyze the main file: ${value.path}\n\nObjective: ${value.objective}${value.context ? `\n\nContext: ${value.context}` : ""}${list("Reference files to read and compare systematically", value.referenceFiles)}`;
  }
  if (role === "review") {
    const value = input as ReviewInput;
    return `${value.task ?? "Review the current integrated working-tree diff."}${value.base ? `\n\nDiff base: ${value.base}` : ""}${list("Limit review to paths", value.paths)}`;
  }
  const value = input as DelegateInput;
  return `${value.task}${list("Exclusive ownership", value.ownership)}${list("Acceptance criteria", value.acceptanceCriteria)}${list("Verification commands", value.verificationCommands)}`;
}

export class SemanticAgentService {
  private sequence = 0;
  private readonly activeDelegateOwnership = new Map<string, string[]>();
  constructor(
    private readonly engine: RunEngine,
    private readonly getTools: () => ToolInfo[],
  ) {}

  private acquireDelegate(key: string, ownership: string[]): void {
    const overlap = [...this.activeDelegateOwnership.entries()].find(([, active]) =>
      ownershipOverlaps(ownership, active),
    );
    if (overlap) throw new Error(`Delegate ownership overlaps active delegate ${overlap[0]}`);
    this.activeDelegateOwnership.set(key, ownership);
  }

  private resolveToolExtension(required: readonly string[]): string | undefined {
    const tools = this.getTools();
    const matches = required.map((name) => tools.find((tool) => tool.name === name));
    if (matches.some((tool) => !tool)) return undefined;
    const paths = new Set(
      matches
        .map((tool) => tool?.sourceInfo)
        .filter((source) => source?.source !== "builtin" && source?.source !== "sdk")
        .map((source) => source?.path)
        .filter((path): path is string => !!path),
    );
    return paths.size === 1 ? [...paths][0] : undefined;
  }

  private resolveResearchExtensions(): string[] {
    const tools = this.getTools();
    const required = semanticProfiles.librarian.tools;
    const missing = required.filter((name) => !tools.some((tool) => tool.name === name));
    if (missing.length)
      throw new Error(`Librarian capabilities unavailable: ${missing.join(", ")}`);
    const paths = required
      .map((name) => tools.find((tool) => tool.name === name)?.sourceInfo)
      .filter((source) => source?.source !== "builtin" && source?.source !== "sdk")
      .map((source) => source?.path)
      .filter((path): path is string => !!path);
    if (!paths.length)
      throw new Error("Librarian research tools are not backed by loadable extensions");
    return [...new Set(paths)];
  }

  async createNode(
    role: SemanticRole,
    rawInput: unknown,
    id?: string,
    originTool = `agentflow_${role}`,
  ): Promise<AgentNodeSpec> {
    const input = validateSemanticInput(role, rawInput);
    const profile = semanticProfiles[role];
    const delegateInput = role === "delegate" ? (input as DelegateInput) : undefined;
    const session = delegateInput?.continuationSessionFile
      ? {
          mode: "existing" as const,
          file: delegateInput.continuationSessionFile,
          inheritParentContext: true,
        }
      : {
          mode: role === "delegate" ? ("file" as const) : ("memory" as const),
          name: delegateInput
            ? `delegate: ${delegateInput.task.replace(/\s+/g, " ").trim().slice(0, 80)}`
            : undefined,
          inheritParentContext: true,
        };
    const backgroundExtension =
      role === "delegate" ? this.resolveToolExtension(BACKGROUND_TOOLS) : undefined;
    const extensions =
      role === "librarian"
        ? this.resolveResearchExtensions()
        : [
            ...(SEARCH_ROLES.has(role) ? [SEARCH_EXTENSION] : []),
            ...(backgroundExtension ? [backgroundExtension] : []),
          ];
    return {
      id: id ?? `${role}_${++this.sequence}`,
      label: role,
      prompt: taskMessage(role, input),
      originTool,
      semanticRole: role,
      config: {
        appendSystemPrompt: await promptFor(profile.promptAsset),
        usePiSystemPrompt: true,
        model: profile.modelId,
        inheritModelProvider: profile.modelId !== undefined,
        thinking: profile.thinking,
        tools: [...profile.tools, ...(backgroundExtension ? BACKGROUND_TOOLS : [])],
        skills: false,
        extensions: extensions.length ? extensions : false,
        extensionMode: backgroundExtension ? "rpc" : "print",
        session,
        outputSchema: profile.outputSchema,
        timeoutMs: profile.timeoutMs,
      },
    };
  }

  async launch(
    role: SemanticRole,
    input: unknown,
    ctx: ExtensionContext,
    options: {
      background: boolean;
      signal?: AbortSignal;
      onUpdate?: (snapshot: RunSnapshot) => void;
    },
  ): Promise<RunResult | { runId: string; snapshot: RunSnapshot }> {
    const validated = validateSemanticInput(role, input);
    const lease = role === "delegate" ? `direct_${++this.sequence}` : undefined;
    if (lease) this.acquireDelegate(lease, [...(validated as DelegateInput).ownership]);
    try {
      const result = await this.engine.launchAgent(
        await this.createNode(role, validated),
        ctx,
        options,
      );
      if (lease && options.background)
        void this.engine
          .observeCompletion(result.runId)
          .finally(() => this.activeDelegateOwnership.delete(lease));
      else if (lease) this.activeDelegateOwnership.delete(lease);
      return result;
    } catch (error) {
      if (lease) this.activeDelegateOwnership.delete(lease);
      throw error;
    }
  }

  async runInWorkflow(
    runId: string,
    role: SemanticRole,
    input: unknown,
    id: string,
  ): Promise<AgentTaskResult> {
    let leased = false;
    try {
      const validated = validateSemanticInput(role, input);
      if (role === "delegate") {
        this.acquireDelegate(id, [...(validated as DelegateInput).ownership]);
        leased = true;
      }
      return await this.engine.runTask(
        runId,
        await this.createNode(role, validated, id, "agentflow_workflow"),
      );
    } catch (error) {
      return {
        ok: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        aborted: this.engine.isRunAborted(runId),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
      };
    } finally {
      if (leased) this.activeDelegateOwnership.delete(id);
    }
  }
}
