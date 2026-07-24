import type {
  Options as ClaudeQueryOptions,
  Query as ClaudeQuery,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeResourceSnapshot,
  loadProjectAgentsContext,
  type ClaudeSkill,
} from "../src/claude/resources.ts";
import {
  ClaudeSubagentRunner,
  type ClaudeQueryFactory,
} from "../src/runtime/claude-subagent-runner.ts";
import { RunStore } from "../src/state/run-store.ts";
import type { AgentNodeSpec, LiveRun, RunResult, RunSnapshot } from "../src/types.ts";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function nodeSpec(overrides: Partial<AgentNodeSpec> = {}): AgentNodeSpec {
  return {
    id: "claude_1",
    label: "Claude",
    prompt: "Review the implementation and report the result.",
    config: { model: "fable" },
    ...overrides,
  };
}

function setupStore(node: AgentNodeSpec): { store: RunStore; snapshot: () => RunSnapshot } {
  const store = new RunStore();
  const snapshot: RunSnapshot = {
    runId: "run_1",
    kind: "agent",
    status: "running",
    createdAt: new Date(0).toISOString(),
    phases: [],
    logs: [],
    nodes: [
      {
        id: node.id,
        label: node.label,
        prompt: node.prompt,
        cwd: "/unused",
        status: "running",
        tools: 0,
        toolCalls: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
      },
    ],
  };
  let resolveCompletion!: (value: RunResult) => void;
  const live: LiveRun = {
    snapshot,
    controls: new Map(),
    controller: new AbortController(),
    completion: new Promise<RunResult>((resolve) => {
      resolveCompletion = resolve;
    }),
    resolveCompletion,
    consumed: false,
  };
  store.add(live);
  return { store, snapshot: () => store.get("run_1")! };
}

function queryFrom(messages: SDKMessage[], close: () => unknown = () => undefined): ClaudeQuery {
  const iterator = (async function* () {
    for (const message of messages) yield message;
  })();
  return Object.assign(iterator, { close }) as ClaudeQuery;
}

function assistantMessage(): SDKMessage {
  return {
    type: "assistant",
    uuid: "assistant-uuid",
    session_id: "session-id",
    parent_tool_use_id: null,
    message: {
      id: "message-id",
      type: "message",
      role: "assistant",
      model: "claude-fable-5",
      stop_reason: "tool_use",
      stop_sequence: null,
      content: [
        { type: "text", text: "Inspecting the requested file." },
        { type: "tool_use", id: "tool-1", name: "Read", input: { path: "src/main.ts" } },
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
    },
  } as unknown as SDKMessage;
}

function resultMessage(subtype: "success" | "error_during_execution" = "success"): SDKMessage {
  const common = {
    type: "result",
    subtype,
    uuid: "result-uuid",
    session_id: "session-id",
    duration_ms: 100,
    duration_api_ms: 80,
    is_error: subtype !== "success",
    num_turns: 2,
    stop_reason: null,
    total_cost_usd: 0.125,
    usage: {
      input_tokens: 20,
      output_tokens: 8,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 3,
    },
    modelUsage: {},
    permission_denials: [],
  };
  return (subtype === "success"
    ? { ...common, result: "Completed successfully." }
    : { ...common, errors: ["provider stopped"] }) as unknown as SDKMessage;
}

async function createSkill(root: string, name = "frontend-design"): Promise<ClaudeSkill> {
  const baseDir = join(root, name);
  const filePath = join(baseDir, "SKILL.md");
  await mkdir(baseDir, { recursive: true });
  await writeFile(filePath, `---\nname: ${name}\n---\nUse intentional design.\n`);
  return { name, description: "Distinctive interface design", filePath, baseDir };
}

describe("ClaudeSubagentRunner", () => {
  it("uses the controlled options, staged Pi skills, root project context, stream snapshots, and final usage", async () => {
    const root = await temporaryDirectory("agentflow-claude-project-");
    await execFileAsync("git", ["init", "-q", root]);
    await writeFile(join(root, "AGENTS.md"), "ROOT PROJECT RULE\n");
    const cwd = join(root, "packages", "app");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "AGENTS.md"), "NESTED RULE MUST NOT LOAD\n");
    const skill = await createSkill(await temporaryDirectory("agentflow-claude-skill-"));
    skill.description = "Distinctive $& $$ interface design";
    const node = nodeSpec();
    const { store, snapshot } = setupStore(node);
    let captured:
      | { prompt: string; options: ClaudeQueryOptions; stagedSkillTarget: string }
      | undefined;
    const close = vi.fn();
    const factory: ClaudeQueryFactory = ({ prompt, options }) => {
      const skillPath = join(options.additionalDirectories![0]!, ".claude", "skills", skill.name);
      captured = {
        prompt,
        options,
        stagedSkillTarget: realpathSync(skillPath),
      };
      return queryFrom(
        [
          {
            type: "stream_event",
            uuid: "partial-uuid",
            session_id: "session-id",
            parent_tool_use_id: null,
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
          } as unknown as SDKMessage,
          assistantMessage(),
          {
            type: "user",
            uuid: "user-uuid",
            session_id: "session-id",
            parent_tool_use_id: null,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-1",
                  content: [{ type: "text", text: "file contents" }],
                },
              ],
            },
          } as unknown as SDKMessage,
          { type: "system", subtype: "status", status: null } as unknown as SDKMessage,
          resultMessage(),
        ],
        close,
      );
    };

    const runner = new ClaudeSubagentRunner(store, () => [skill], factory, {
      HOME: "/home/test",
      PATH: "/bin",
      SECRET_SHOULD_NOT_LEAK: "secret",
    });
    const result = await runner.run("run_1", node, { cwd } as never, new AbortController().signal);

    expect(result).toEqual({
      text: "Completed successfully.",
      usage: { input: 20, output: 8, cacheRead: 5, cacheWrite: 3, total: 36, cost: 0.125 },
    });
    expect(captured!.prompt).toContain("ROOT PROJECT RULE");
    expect(captured!.prompt).not.toContain("NESTED RULE MUST NOT LOAD");
    expect(captured!.prompt).toContain("----- BEGIN TASK AGENTFLOW-");
    expect(captured!.stagedSkillTarget).toBe(await realpath(skill.baseDir));
    expect(captured!.options).toMatchObject({
      cwd,
      model: "fable",
      tools: ["Read", "Glob", "Grep", "Bash", "Edit", "Write", "WebFetch", "WebSearch", "Skill"],
      allowedTools: ["Read", "Glob", "Grep", "Skill"],
      disallowedTools: ["Agent", "AskUserQuestion"],
      permissionMode: "auto",
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      plugins: [],
      hooks: {},
      persistSession: false,
      includePartialMessages: true,
      skills: [skill.name],
    });
    expect(captured!.options.systemPrompt).toContain("## Agency");
    expect(captured!.options.systemPrompt).toContain(`- ${skill.name}: ${skill.description}`);
    expect(captured!.options.systemPrompt).not.toContain("${activeSkillsIndex}");
    expect(captured!.options.settings).toMatchObject({
      disableAllHooks: true,
      autoMemoryEnabled: false,
      disableClaudeAiConnectors: true,
      disableBundledSkills: true,
      disableSkillShellExecution: true,
      enabledPlugins: {},
    });
    expect(captured!.options.env).toMatchObject({
      HOME: "/home/test",
      PATH: "/bin",
      CLAUDE_AGENT_SDK_CLIENT_APP: "pi-agentflow",
      CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
    });
    expect(captured!.options.env).not.toHaveProperty("SECRET_SHOULD_NOT_LEAK");
    await expect(readFile(captured!.options.additionalDirectories![0]!)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(close).toHaveBeenCalledOnce();
    expect(snapshot().nodes[0]).toMatchObject({
      tools: 1,
      resultPreview: "Completed successfully.",
      usage: result.usage,
      toolCalls: [
        { id: "tool-1", name: "Read", status: "completed", resultPreview: "file contents" },
      ],
    });
  });

  it("reports SDK error results after preserving authoritative usage", async () => {
    const cwd = await temporaryDirectory("agentflow-claude-error-");
    const node = nodeSpec();
    const { store, snapshot } = setupStore(node);
    let options: ClaudeQueryOptions | undefined;
    const runner = new ClaudeSubagentRunner(
      store,
      () => [],
      (params) => {
        options = params.options;
        return queryFrom([resultMessage("error_during_execution")]);
      },
    );

    await expect(
      runner.run("run_1", node, { cwd } as never, new AbortController().signal),
    ).rejects.toThrow("Claude query failed: error_during_execution: provider stopped");
    expect(options!.skills).toEqual([]);
    expect(options!.systemPrompt).toContain("- None");
    expect(snapshot().nodes[0]!.usage).toEqual({
      input: 20,
      output: 8,
      cacheRead: 5,
      cacheWrite: 3,
      total: 36,
      cost: 0.125,
    });
  });

  it("deduplicates interim usage and reports a missing terminal result", async () => {
    const cwd = await temporaryDirectory("agentflow-claude-no-result-");
    const node = nodeSpec();
    const { store, snapshot } = setupStore(node);
    const runner = new ClaudeSubagentRunner(
      store,
      () => [],
      () => queryFrom([assistantMessage(), assistantMessage()]),
    );

    await expect(
      runner.run("run_1", node, { cwd } as never, new AbortController().signal),
    ).rejects.toThrow("Claude query ended without a result message");
    expect(snapshot().nodes[0]!.usage).toEqual({
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      total: 17,
      cost: 0,
    });
    expect(snapshot().nodes[0]!.tools).toBe(1);
  });

  it("rejects missing and duplicate skill assets without leaking staging directories", async () => {
    const before = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith("pi-agentflow-claude-")),
    );
    const cwd = await temporaryDirectory("agentflow-claude-assets-");
    const node = nodeSpec();
    const { store } = setupStore(node);
    const missing = {
      name: "missing",
      description: "missing",
      baseDir: join(cwd, "missing"),
      filePath: join(cwd, "missing", "SKILL.md"),
    };
    const runner = new ClaudeSubagentRunner(store, () => [missing], vi.fn() as never);
    await expect(
      runner.run("run_1", node, { cwd } as never, new AbortController().signal),
    ).rejects.toThrow();

    const skill = await createSkill(cwd, "duplicate");
    const duplicateRunner = new ClaudeSubagentRunner(store, () => [skill, skill], vi.fn() as never);
    await expect(
      duplicateRunner.run("run_1", node, { cwd } as never, new AbortController().signal),
    ).rejects.toThrow("Duplicate Claude skill name: duplicate");
    const after = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith("pi-agentflow-claude-")),
    );
    expect(after).toEqual(before);
  });

  it("links parent abort, bounds a hung close, and cleans staging", async () => {
    vi.useFakeTimers();
    const cwd = await temporaryDirectory("agentflow-claude-abort-");
    const skill = await createSkill(cwd, "abort-skill");
    const node = nodeSpec();
    const { store } = setupStore(node);
    let stagedRoot = "";
    const controller = new AbortController();
    const factory: ClaudeQueryFactory = ({ options }) => {
      stagedRoot = options.additionalDirectories![0]!;
      const iterator = {
        next: () =>
          new Promise<IteratorResult<SDKMessage>>((_, reject) =>
            options.abortController!.signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            ),
          ),
        return: async () => ({ done: true, value: undefined }),
        [Symbol.asyncIterator]() {
          return this;
        },
        close: () => new Promise<never>(() => undefined),
      };
      return iterator as never;
    };
    const runner = new ClaudeSubagentRunner(store, () => [skill], factory);
    const running = runner.run("run_1", node, { cwd } as never, controller.signal);
    await vi.waitFor(() => expect(stagedRoot).not.toBe(""));
    controller.abort();
    await vi.advanceTimersByTimeAsync(500);

    await expect(running).rejects.toThrow(/aborted/i);
    await expect(realpath(stagedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("aborts through the attached child control used by cancel and shutdown", async () => {
    const cwd = await temporaryDirectory("agentflow-claude-control-abort-");
    const node = nodeSpec();
    const { store } = setupStore(node);
    let started = false;
    const factory: ClaudeQueryFactory = ({ options }) => {
      started = true;
      return {
        next: () =>
          new Promise<IteratorResult<SDKMessage>>((_, reject) =>
            options.abortController!.signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            ),
          ),
        return: async () => ({ done: true, value: undefined }),
        [Symbol.asyncIterator]() {
          return this;
        },
        close: vi.fn(),
      } as never;
    };
    const runner = new ClaudeSubagentRunner(store, () => [], factory);
    const running = runner.run("run_1", node, { cwd } as never, new AbortController().signal);
    await vi.waitFor(() => expect(started).toBe(true));

    await store.abort("run_1");

    await expect(running).rejects.toThrow(/aborted/i);
  });

  it("enforces the child deadline and bounds close", async () => {
    vi.useFakeTimers();
    const cwd = await temporaryDirectory("agentflow-claude-deadline-");
    const node = nodeSpec({ config: { model: "sonnet", timeoutMs: 100 } });
    const { store } = setupStore(node);
    let started = false;
    const factory: ClaudeQueryFactory = ({ options }) => {
      started = true;
      return {
        next: () =>
          new Promise<IteratorResult<SDKMessage>>((_, reject) =>
            options.abortController!.signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            ),
          ),
        return: async () => ({ done: true, value: undefined }),
        [Symbol.asyncIterator]() {
          return this;
        },
        close: () => new Promise<never>(() => undefined),
      } as never;
    };
    const runner = new ClaudeSubagentRunner(store, () => [], factory);
    const running = runner.run("run_1", node, { cwd } as never, new AbortController().signal);
    await vi.waitFor(() => expect(started).toBe(true));
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(500);

    await expect(running).rejects.toThrow("Claude child deadline exceeded after 100ms");
  });
});

describe("Claude project resources", () => {
  it("rejects an oversized root AGENTS.md", async () => {
    const cwd = await temporaryDirectory("agentflow-claude-large-agents-");
    await writeFile(join(cwd, "AGENTS.md"), "x".repeat(64 * 1024 + 1));

    await expect(loadProjectAgentsContext(cwd)).rejects.toThrow(
      "project AGENTS.md exceeds the 65536 byte limit",
    );
  });
});

describe("ClaudeResourceSnapshot", () => {
  it("captures only immutable plain skill metadata and clears it", () => {
    const source = {
      name: "design",
      description: "Design skill",
      filePath: "/skills/design/SKILL.md",
      baseDir: "/skills/design",
      sourceInfo: { source: "test" },
      disableModelInvocation: false,
    };
    const snapshot = new ClaudeResourceSnapshot();
    snapshot.capture([source] as never);
    source.description = "mutated";

    expect(snapshot.getSkills()).toEqual([
      {
        name: "design",
        description: "Design skill",
        filePath: "/skills/design/SKILL.md",
        baseDir: "/skills/design",
      },
    ]);
    expect(Object.isFrozen(snapshot.getSkills()[0])).toBe(true);
    snapshot.clear();
    expect(snapshot.getSkills()).toEqual([]);
  });
});
