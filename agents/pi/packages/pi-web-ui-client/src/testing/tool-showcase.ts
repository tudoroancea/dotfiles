// Deterministic scripted transcript covering every tool of the local Pi setup.
//
// `toolShowcaseScenario()` returns the initial `SessionSnapshotData`, one older
// history page, and an ordered list of `{ delayMs, operations }` steps. Every tool
// appears first as a call without a result (pending) and then settled; streaming
// tools emit partial results in between; the script also carries tool errors, a
// failed and an aborted agentflow run, a live background agentflow run, a multi-node
// workflow run, every non-tool entry kind, and the running, metadata and queue
// operation domains. It deliberately never emits a `theme` operation, since it exists
// to inspect transcript rendering rather than to repaint the palette.
//
// This module is host-neutral and pure: pacing is data (`delayMs`), so the host owns
// the timers and any speed factor, and entry identities are assigned here while the
// host anchors each append to whatever its live tail is at publish time.

import type { PersistedEntry, SessionOperation, SessionSnapshotData } from "../wire/protocol.ts";
import type { PendingInput, SessionMetadata } from "../wire/schema.ts";

/** An opaque transcript payload; renderers decode these as untrusted input. */
type Payload = Record<string, unknown>;

export interface ToolShowcaseStep {
  /** Authored wait before publishing, in milliseconds at speed 1. */
  delayMs: number;
  operations: SessionOperation[];
}

export interface ToolShowcaseIdentity {
  commandEpoch: string;
  historyGeneration: string;
}

export interface ToolShowcaseScenario {
  snapshot: SessionSnapshotData;
  /** The page a `history-request` anchored at the snapshot's oldest entry returns. */
  historyPage: PersistedEntry[];
  steps: ToolShowcaseStep[];
}

const BASE_TIME = Date.UTC(2026, 0, 2, 3, 4, 5);

/** Pending-to-settled gap: the beat a reviewer watches for every tool call. */
const BEAT = 900;
/** Gap between two partial results of one streaming tool. */
const STREAM = 500;
/** Gap between transcript sections. */
const SECTION = 1_400;

const SHOWCASE_LONG_PATH =
  "/var/folders/3_/hp4nl8v920364pxvzx8rx2m40000gn/T/TemporaryItems/NSIRD_screencaptureui_" +
  "JQfDho/Screenshot 2026-07-26 at 00.06.11.png";

const SHOWCASE_HOSTILE_MARKDOWN =
  "Injection attempt: <script>alert(1)</script> and <img src=x onerror=alert(2)> plus " +
  "[evil link](javascript:alert(3)) and [safe link](https://example.com) and " +
  "![data image](data:text/html;base64,PHNjcmlwdD4=) — literal `<b>tags</b>` stay text.";

/**
 * A 160×90 PNG the scenario references from user, tool-result and attachment blocks.
 * A host serving this scenario must resolve `image/<id>` to these bytes.
 */
export const TOOL_SHOWCASE_IMAGE = {
  id: "mockimagereference00000000000000000001",
  mimeType: "image/png",
  width: 160,
  height: 90,
  byteLength: 251,
  base64:
    "iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAIAAACwpMoFAAAAwklEQVR42u3RMRGAMBQFwchgKJGRCg0UEYO46EmBCCxQ8t/s" +
    "zCm4bdt+KLhmAWABVgngcU8FBBiwAAuwAAuwAAswYMCABViABViABRgwYMACLMACLMACLMCABVg1gdd6FBBgwAIswAIswAIs" +
    "wIABAxZgARZgARZgwIABC7AAC7AAC7AAAxZgARZgARZgfQfu56WAAAMWYAEWYAEWYAEGDBiwAAuwAAuwAAMGDFiABViABViA" +
    "BRiwAKsmsPICDFiA9dteB4KCekYAHg8AAAAASUVORK5CYII=",
} as const;

const imageReference = (): Payload => ({
  type: "image-reference",
  id: TOOL_SHOWCASE_IMAGE.id,
  mimeType: TOOL_SHOWCASE_IMAGE.mimeType,
  width: TOOL_SHOWCASE_IMAGE.width,
  height: TOOL_SHOWCASE_IMAGE.height,
  byteLength: TOOL_SHOWCASE_IMAGE.byteLength,
});

const text = (value: string): Payload[] => [{ type: "text", text: value }];
const lines = (count: number, render: (index: number) => string): string[] =>
  Array.from({ length: count }, (_, index) => render(index));

// --- agentflow fixtures ----------------------------------------------------------

const AF_START = "2026-01-02T03:05:10.000Z";
const AF_END = "2026-01-02T03:06:48.000Z";

function usage(total: number, cost: number, costKnown = true): Payload {
  return {
    input: Math.round(total * 0.68),
    output: Math.round(total * 0.22),
    cacheRead: Math.round(total * 0.08),
    cacheWrite: Math.round(total * 0.02),
    total,
    cost,
    costKnown,
  };
}

function afToolCall(
  id: string,
  name: string,
  status: "running" | "completed" | "failed",
  argumentSummary: string,
  extra: Payload = {},
): Payload {
  return {
    id,
    name,
    status,
    startedAt: AF_START,
    argumentSummary,
    ...(status === "running" ? {} : { completedAt: AF_END }),
    ...extra,
  };
}

function afNode(overrides: Payload = {}): Payload {
  return {
    id: "n1",
    label: "node",
    prompt: "Inspect the transport boundary and report the exact validation rules.",
    cwd: "/Users/tester/project",
    status: "completed",
    queuedAt: AF_START,
    startedAt: AF_START,
    completedAt: AF_END,
    tools: 4,
    toolCalls: [],
    usage: usage(18_400, 0.0412),
    ...overrides,
  };
}

function afRun(overrides: Payload = {}): Payload {
  return {
    runId: "run-mock-1",
    sessionId: "mock-session",
    kind: "agent",
    status: "completed",
    createdAt: AF_START,
    completedAt: AF_END,
    phases: [],
    nodes: [],
    logs: [],
    ...overrides,
  };
}

type FinderStage = "queued" | "running-1" | "running-2" | "completed";

const finderStructuredResult = {
  summary:
    "# Envelope ownership\n\n`protocol.ts` declares the schemas and **session-state.ts** enforces them.",
  findings: [
    {
      path: "packages/pi-web-ui-client/src/wire/protocol.ts",
      range: "1-220",
      relevance: "Declares the strict snapshot and operation envelopes.",
    },
    {
      path: "packages/pi-web-ui-client/src/client/session-state.ts",
      range: "240-390",
      relevance: "Checks generations, revisions, anchors, and recovery.",
    },
    {
      path: "agent/extensions/web-ui/src/web/standalone-transport.ts",
      range: "1-180",
      relevance: "Adapts the standalone host to the shared transport contract.",
    },
  ],
  unresolvedQuestions: ["Should the daemon reuse the same **recovery reason** vocabulary?"],
};

/** finder progression: queued, running with a growing tool list, then completed. */
function finderRun(stage: FinderStage): Payload {
  const calls = [
    afToolCall("fc-1", "ffgrep", "completed", "isServerEnvelope in packages/"),
    afToolCall("fc-2", "read", "completed", "src/wire/protocol.ts:1-200"),
    afToolCall("fc-3", "read", "running", "src/client/session-state.ts"),
  ];
  if (stage === "queued") {
    return afRun({
      status: "queued",
      originTool: "agentflow_finder",
      semanticRole: "finder",
      completedAt: undefined,
      nodes: [
        afNode({
          label: "finder",
          semanticRole: "finder",
          status: "queued",
          startedAt: undefined,
          completedAt: undefined,
          toolCalls: [],
          usage: usage(0, 0, false),
        }),
      ],
      logs: ["queued behind 1 run"],
    });
  }
  if (stage === "completed") {
    return afRun({
      originTool: "agentflow_finder",
      semanticRole: "finder",
      resultPreview: JSON.stringify(finderStructuredResult),
      nodes: [
        afNode({
          label: "finder",
          semanticRole: "finder",
          resultPreview: "protocol.ts declares it, session-state.ts enforces it.",
          toolCalls: [
            calls[0],
            calls[1],
            afToolCall("fc-3", "read", "completed", "src/client/session-state.ts"),
          ],
          sessionFile: "/Users/tester/.pi/agentflow/run-mock-1/finder.jsonl",
        }),
      ],
      logs: ["node finder started", "node finder completed"],
    });
  }
  return afRun({
    status: "running",
    originTool: "agentflow_finder",
    semanticRole: "finder",
    completedAt: undefined,
    nodes: [
      afNode({
        label: "finder",
        semanticRole: "finder",
        status: "running",
        completedAt: undefined,
        toolCalls: stage === "running-1" ? [calls[0]] : [calls[0], calls[1], calls[2]],
        usage: usage(6_200, 0.0121),
      }),
    ],
    logs: ["node finder started"],
  });
}

/** A workflow run: several nodes across phases, so the node list renders. */
const workflowRun = (): Payload =>
  afRun({
    runId: "run-mock-workflow",
    kind: "workflow",
    name: "release-audit",
    description: "Audit the release surface across three phases.",
    originTool: "agentflow_workflow",
    status: "running",
    completedAt: undefined,
    currentPhase: "verify",
    phases: ["survey", "verify", "report"],
    artifactDir: "/Users/tester/.pi/agentflow/run-mock-workflow",
    nodes: [
      afNode({
        id: "survey-a",
        label: "survey wire",
        phase: "survey",
        prompt: "List every wire schema the browser validates.",
        resultPreview: "protocol.ts, schema.ts, questionnaire.ts",
        toolCalls: [afToolCall("wf-1", "fffind", "completed", "src/wire/*.ts")],
      }),
      afNode({
        id: "survey-b",
        label: "survey renderers",
        phase: "survey",
        prompt: "List every renderer branch that decodes tool results.",
        resultPreview: "34 branches, 9 of them untyped",
        toolCalls: [afToolCall("wf-2", "ffgrep", "completed", "toolName === in client/")],
        usage: usage(21_900, 0.0503),
      }),
      afNode({
        id: "verify",
        label: "verify parity",
        phase: "verify",
        dependsOn: ["survey-a", "survey-b"],
        prompt: "Compare the TUI and web renderers for each tool.",
        status: "running",
        completedAt: undefined,
        toolCalls: [
          afToolCall("wf-3", "read", "completed", "agent/extensions/agentflow/src/ui/run-card.ts"),
          afToolCall("wf-4", "bash", "running", "nub run --filter pi-web-ui typecheck"),
        ],
        usage: usage(9_800, 0.0233),
      }),
      afNode({
        id: "report",
        label: "write report",
        phase: "report",
        dependsOn: ["verify"],
        prompt: "Write the parity report into the artifact directory.",
        status: "queued",
        startedAt: undefined,
        completedAt: undefined,
        toolCalls: [],
        usage: usage(0, 0, false),
      }),
    ],
    logs: ["phase survey completed", "phase verify started"],
  });

const backgroundAgentRun = (): Payload =>
  afRun({
    runId: "run-mock-background",
    status: "running",
    background: true,
    originTool: "agentflow_agent",
    completedAt: undefined,
    nodes: [
      afNode({
        label: "bundle-watcher",
        status: "running",
        completedAt: undefined,
        prompt: "Watch the bundle build and report the first failure.",
        model: "gpt-5-codex",
        toolCalls: [afToolCall("bg-1", "bash", "running", "nub run build:watch")],
        usage: usage(4_100, 0.0092, false),
      }),
    ],
    logs: ["detached; delivery is pending"],
  });

const abortedRun = (): Payload =>
  afRun({
    runId: "run-mock-aborted",
    status: "aborted",
    originTool: "agentflow_claude",
    error: "Aborted by the parent session before the child produced a result.",
    nodes: [
      afNode({
        label: "claude/opus",
        status: "aborted",
        backend: "claude",
        model: "opus",
        error: "aborted",
        toolCalls: [afToolCall("ab-1", "read", "failed", "missing.ts", { error: "ENOENT" })],
        usage: usage(2_300, 0.0071),
      }),
    ],
    logs: ["abort requested", "child terminated"],
  });

const failedRun = (): Payload =>
  afRun({
    runId: "run-mock-failed",
    status: "failed",
    originTool: "agentflow_delegate",
    semanticRole: "delegate",
    error: "Verification command failed: nub run --filter pi-web-ui typecheck",
    nodes: [
      afNode({
        label: "delegate",
        semanticRole: "delegate",
        status: "failed",
        error: "tsc exited with code 2 after 3 attempts",
        sessionFile: "/Users/tester/.pi/agentflow/run-mock-failed/delegate.jsonl",
        toolCalls: [
          afToolCall("dl-1", "edit", "completed", "src/wire/background.ts"),
          afToolCall("dl-2", "bash", "failed", "nub run typecheck", { error: "exit code 2" }),
        ],
        usage: usage(41_200, 0.1184),
      }),
    ],
    logs: ["node delegate started", "node delegate failed"],
  });

// --- background-processes fixtures ------------------------------------------------

function job(overrides: Payload = {}): Payload {
  return {
    jobId: "bg_1",
    kind: "background_run",
    status: "running",
    command: "nub run --filter pi-web-ui build:watch",
    cwd: "/Users/tester/project",
    createdAt: "2026-01-02T03:05:01.000Z",
    outputBytes: 2_048,
    outputPath: "/tmp/pi-bg/bg_1/output.log",
    metadataPath: "/tmp/pi-bg/bg_1/job.json",
    deliveryState: "pending",
    ...overrides,
  };
}

function serializedJobs(jobs: Payload[], overrides: Payload = {}): Payload {
  return { jobs, text: JSON.stringify({ jobs }), truncated: false, omittedCount: 0, ...overrides };
}

const monitorEvent = (): Payload => ({
  jobId: "bg_2",
  description: "vite build watcher",
  outputPath: "/tmp/pi-bg/bg_2/output.log",
  delivery: 3,
  lines: [
    "vite v6.0.11 building for production...",
    "transforming (184) src/client/renderers.tsx",
    "dist/client/assets/app.js  351.87 kB",
  ],
  firstSequence: 41,
  lastSequence: 47,
  droppedLines: 2,
  droppedBytes: 148,
  splitLines: 1,
  captureBatches: 4,
  captureOnly: false,
});

// --- questionnaire fixtures ------------------------------------------------------

const questionnaireQuestions: Payload[] = [
  {
    id: "scope",
    label: "Scope",
    prompt: "Which scope should the renderer rewrite cover?",
    options: [
      { value: "tools", label: "Tool renderers only", description: "registry plus tool modules" },
      { value: "all", label: "Every renderer", description: "entries, messages and tools" },
    ],
    allowOther: true,
  },
  {
    id: "notes",
    label: "Notes",
    prompt: "Anything else the implementer should know?",
    options: [{ value: "none", label: "Nothing else" }],
    allowOther: true,
  },
];

const questionnaireAnswers: Payload[] = [
  { id: "scope", value: "tools", label: "Tool renderers only", wasCustom: false, index: 1 },
  {
    id: "notes",
    value: "Keep the collapsed row informative <b>literally</b>",
    label: "Keep the collapsed row informative <b>literally</b>",
    wasCustom: true,
  },
];

// --- timeline builder ------------------------------------------------------------

interface ToolResult {
  content: Payload[];
  details?: unknown;
  isError?: boolean;
}

class Timeline {
  /** Entries of the initial snapshot; streamed appends deliberately stay out of it. */
  readonly #seeded: PersistedEntry[] = [];
  /** Parent for the next entry: the id of the most recently created one. */
  #lastId: string | null = null;
  readonly #live = new Map<string, PersistedEntry>();
  readonly #steps: ToolShowcaseStep[] = [];
  #clock = 0;
  #sequence = 0;
  #metadata: SessionMetadata = {
    cwd: "/Users/tester/project",
    home: "/Users/tester",
    contextUsage: { tokens: 24_100, contextWindow: 200_000, percent: 12 },
    sessionCost: 0.0312,
    model: { provider: "openai", id: "gpt-5-codex", name: "GPT-5 Codex" },
    thinkingLevel: "medium",
  };

  #timestamp(): string {
    this.#clock += 1_000;
    return new Date(BASE_TIME + this.#clock).toISOString();
  }

  #entry(body: Payload): { parentId: string | null; entry: PersistedEntry } {
    this.#sequence += 1;
    const id = `mock-${this.#sequence}`;
    const parentId = this.#lastId;
    const payload = { id, parentId, timestamp: this.#timestamp(), ...body };
    this.#lastId = id;
    return { parentId, entry: { id, payload } };
  }

  #liveTail(): SessionOperation {
    return { kind: "live-tail", entries: [...this.#live.values()] };
  }

  #step(delayMs: number, operations: SessionOperation[]): void {
    this.#steps.push({ delayMs, operations });
  }

  /** Adds an entry to the initial snapshot instead of the streamed timeline. */
  seed(body: Payload): void {
    this.#seeded.push(this.#entry(body).entry);
  }

  /** Appends one durable entry, optionally alongside extra operations. */
  append(delayMs: number, body: Payload, extra: SessionOperation[] = []): void {
    const { parentId, entry } = this.#entry(body);
    this.#step(delayMs, [{ kind: "append", afterId: parentId, entries: [entry] }, ...extra]);
  }

  user(delayMs: number, content: Payload[]): void {
    this.append(delayMs, { type: "message", message: { role: "user", content } });
  }

  assistant(delayMs: number, content: Payload[]): void {
    this.append(delayMs, { type: "message", message: { role: "assistant", content } });
  }

  /** A tool call with no result yet: the pending state every renderer must handle. */
  call(delayMs: number, toolCallId: string, name: string, args: Payload): void {
    this.assistant(delayMs, [{ type: "toolCall", id: toolCallId, name, arguments: args }]);
  }

  /** A streaming partial result, shaped the way a host's live projection emits it. */
  partial(delayMs: number, toolCallId: string, toolName: string, result: ToolResult): void {
    const id = `live-tr-${toolCallId}`;
    this.#live.set(id, {
      id,
      payload: {
        type: "message",
        id,
        parentId: null,
        timestamp: this.#timestamp(),
        message: {
          role: "toolResult",
          toolCallId,
          toolName,
          isError: false,
          isPartial: true,
          ...result,
        },
      },
    });
    this.#step(delayMs, [this.#liveTail()]);
  }

  /** The durable result; drops any live partial that was shadowing it. */
  settle(delayMs: number, toolCallId: string, toolName: string, result: ToolResult): void {
    const shadowed = this.#live.delete(`live-tr-${toolCallId}`);
    this.append(
      delayMs,
      {
        type: "message",
        message: { role: "toolResult", toolCallId, toolName, isError: false, ...result },
      },
      shadowed ? [this.#liveTail()] : [],
    );
  }

  /** Call, pending beat, settled result. */
  tool(
    toolCallId: string,
    name: string,
    args: Payload,
    result: ToolResult,
    delayMs = SECTION,
  ): void {
    this.call(delayMs, toolCallId, name, args);
    this.settle(BEAT, toolCallId, name, result);
  }

  running(delayMs: number, isRunning: boolean, workingWord?: string): void {
    this.#step(delayMs, [
      {
        kind: "running",
        running: workingWord === undefined ? { isRunning } : { isRunning, workingWord },
      },
    ]);
  }

  metadata(delayMs: number, patch: Partial<SessionMetadata>): void {
    this.#metadata = { ...this.#metadata, ...patch };
    this.#step(delayMs, [{ kind: "metadata", metadata: this.#metadata }]);
  }

  queue(delayMs: number, items: PendingInput[]): void {
    this.#step(delayMs, [{ kind: "queue", queue: items }]);
  }

  finish({ commandEpoch, historyGeneration }: ToolShowcaseIdentity): ToolShowcaseScenario {
    return {
      snapshot: {
        commandEpoch,
        imageAttachments: {
          supportedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
          maxAttachments: 4,
          maxBytesPerImage: 2 * 1024 * 1024,
          maxTotalBytes: 4 * 1024 * 1024,
          maxWidth: 4096,
          maxHeight: 4096,
          maxPixels: 8_000_000,
          maxTotalPixels: 16_000_000,
        },
        pendingInputBroker: { edit: true, remove: true },
        header: { id: "mock-session", cwd: "/Users/tester/project" },
        leafId: this.#seeded.at(-1)?.id ?? null,
        sessionName: "Mock tool-call gallery",
        systemPrompt: "You are the deterministic mock assistant for renderer inspection.",
        entries: [...this.#seeded],
        liveTail: [],
        history: {
          historyGeneration,
          beforeCursor: "mock-older-page",
          hasMore: true,
          oldestEntryId: this.#seeded[0]?.id ?? null,
        },
        metadata: this.#metadata,
        queue: [],
        running: { isRunning: false },
      },
      historyPage: [
        {
          id: "mock-history-1",
          payload: {
            id: "mock-history-1",
            parentId: null,
            timestamp: new Date(BASE_TIME - 120_000).toISOString(),
            type: "message",
            message: {
              role: "user",
              content: text("An older turn, only reachable through the history page."),
            },
          },
        },
        {
          id: "mock-history-2",
          payload: {
            id: "mock-history-2",
            parentId: "mock-history-1",
            timestamp: new Date(BASE_TIME - 60_000).toISOString(),
            type: "message",
            message: {
              role: "assistant",
              content: text("Understood — loading older history works."),
            },
          },
        },
      ],
      steps: this.#steps,
    };
  }
}

// --- the scripted sections -------------------------------------------------------

function builtins(t: Timeline): void {
  t.running(SECTION, true, "Inspecting");
  t.call(0, "tc-bash", "bash", {
    command: "rg -n 'isServerEnvelope' packages/pi-web-ui-client/src | head -20",
    timeout: 30,
  });
  t.partial(STREAM, "tc-bash", "bash", {
    content: text(
      "packages/pi-web-ui-client/src/wire/protocol.ts:392:export const isServerEnvelope",
    ),
  });
  t.partial(STREAM, "tc-bash", "bash", {
    content: text(
      [
        "packages/pi-web-ui-client/src/wire/protocol.ts:392:export const isServerEnvelope",
        "packages/pi-web-ui-client/src/client/session-state.ts:143:  if (!Check(Operation",
      ].join("\n"),
    ),
  });
  t.settle(BEAT, "tc-bash", "bash", {
    content: text(
      [
        "packages/pi-web-ui-client/src/wire/protocol.ts:392:export const isServerEnvelope",
        "packages/pi-web-ui-client/src/client/session-state.ts:143:  if (!Check(Operation",
        "agent/extensions/web-ui/src/standalone/server/sse.ts:113:      if (!isServerEnvelope(",
        "agent/extensions/web-ui/src/web/standalone-transport.ts:91:    if (!validate(handlers,",
        "4 files matched",
      ].join("\n"),
    ),
  });

  t.tool(
    "tc-bash-fail",
    "bash",
    { command: "nub run --filter pi-web-ui typecheck" },
    {
      content: text(
        [
          "src/standalone/server/journal.ts(214,7): error TS2345: Argument of type",
          "'SessionSnapshotData | undefined' is not assignable to parameter of type",
          "'SessionSnapshotData'.",
          "Found 1 error in src/standalone/server/journal.ts:214",
        ].join("\n"),
      ),
      isError: true,
    },
    BEAT,
  );

  t.tool(
    "tc-read",
    "read",
    { path: "packages/pi-web-ui-client/src/wire/protocol.ts", offset: 90, limit: 20 },
    {
      content: text(lines(20, (index) => `${90 + index}\tconst line = ${index};`).join("\n")),
      details: {
        truncation: {
          truncated: true,
          truncatedBy: "lines",
          outputLines: 20,
          totalLines: 402,
          maxLines: 2_000,
        },
      },
    },
    BEAT,
  );

  t.tool(
    "tc-read-image",
    "read",
    { path: SHOWCASE_LONG_PATH },
    { content: [...text("Read 1 image (160×90 PNG)."), imageReference()] },
    BEAT,
  );

  t.tool(
    "tc-read-missing",
    "read",
    { path: "packages/pi-web-ui-client/src/wire/absent.ts" },
    {
      content: text("Error: ENOENT: no such file or directory, open 'src/wire/absent.ts'"),
      isError: true,
    },
    BEAT,
  );

  t.tool(
    "tc-write",
    "write",
    {
      path: "agent/extensions/web-ui/mock/notes.md",
      content: "# Mock notes\n\n- pending and settled\n- partial results\n- errors\n",
    },
    { content: text("Wrote 5 lines to agent/extensions/web-ui/mock/notes.md") },
    BEAT,
  );

  t.tool(
    "tc-edit",
    "edit",
    {
      path: "packages/pi-web-ui-client/src/client/renderers.tsx",
      edits: [
        { oldText: "const dkey = `tool:${id}`;", newText: "const dkey = `tool:${id}:${name}`;" },
        { oldText: "args.file_path ?? args.path", newText: "args.path" },
      ],
    },
    {
      content: text("Applied 2 edits to packages/pi-web-ui-client/src/client/renderers.tsx"),
      details: {
        diff: [
          "--- a/packages/pi-web-ui-client/src/client/renderers.tsx",
          "+++ b/packages/pi-web-ui-client/src/client/renderers.tsx",
          "@@ -412,7 +412,7 @@",
          "   const { expanded, toggle } = useDisclosure(dkey);",
          "-  const dkey = `tool:${id}`;",
          "+  const dkey = `tool:${id}:${name}`;",
          "   return <ToolBox onClick={toggle}>",
          "@@ -918,7 +918,7 @@",
          "-  const path = str(args.file_path ?? args.path);",
          "+  const path = str(args.path);",
        ].join("\n"),
      },
    },
    BEAT,
  );

  t.tool(
    "tc-ls",
    "ls",
    { path: "agent/extensions/web-ui/src/standalone/server", limit: 100 },
    {
      content: text(
        [
          "auth.ts",
          "history.ts",
          "http.ts",
          "images.ts",
          "index.ts",
          "journal.ts",
          "metrics.ts",
          "routes.ts",
          "sse.ts",
          "static.ts",
          "types.ts",
        ].join("\n"),
      ),
    },
    BEAT,
  );

  t.tool(
    "tc-grep",
    "grep",
    {
      pattern: "isPartial",
      path: "packages/pi-web-ui-client/src",
      glob: "*.ts",
      ignoreCase: false,
      literal: true,
      context: 1,
      limit: 50,
    },
    {
      content: text(
        [
          "src/wire/questionnaire.ts:355:      : rawResult === undefined || result?.isPartial === true",
          "src/client/transcript-index.ts:71:  const partial = message.isPartial === true;",
          "",
          "[50 matches limit reached]",
        ].join("\n"),
      ),
    },
    BEAT,
  );

  t.tool(
    "tc-find",
    "find",
    { pattern: "**/session-fixtures.ts", path: "packages", limit: 20 },
    { content: text("packages/pi-web-ui-client/src/testing/session-fixtures.ts") },
    BEAT,
  );

  t.metadata(BEAT, {
    contextUsage: { tokens: 51_800, contextWindow: 200_000, percent: 26 },
    sessionCost: 0.1874,
  });
  t.assistant(BEAT, [
    { type: "thinking", thinking: "The builtins are covered; move on to the fff pair." },
    {
      type: "text",
      text: "The builtin surface is mapped. `bash`, `read`, `write`, `edit`, `ls`, `grep` and\n`find` all decode, including the failing `bash` and the missing-file `read`.",
    },
  ]);
  t.running(BEAT, false);
}

function fff(t: Timeline): void {
  t.running(SECTION, true, "Searching");
  t.call(0, "tc-ffgrep", "ffgrep", {
    pattern: "decodeAgentflowRunViews",
    path: "packages/pi-web-ui-client/src",
    exclude: ["**/dist/**", "**/node_modules/**"],
    caseSensitive: true,
    context: 2,
    limit: 40,
    cursor: "ffgrep:page-2",
  });
  t.partial(STREAM, "tc-ffgrep", "ffgrep", {
    content: text(
      ["src/wire/agentflow.ts", " 343: export function decodeAgentflowRunViews("].join("\n"),
    ),
  });
  t.settle(BEAT, "tc-ffgrep", "ffgrep", {
    content: text(
      [
        "src/wire/agentflow.ts",
        " 342- /** Read the run snapshots out of an Agentflow tool result. */",
        " 343: export function decodeAgentflowRunViews(",
        " 344-   toolName: string,",
        "",
        "src/wire/index.ts",
        ' 14: export { decodeAgentflowRunViews } from "./agentflow.ts";',
        "",
        "src/client/tools/agentflow.tsx",
        " 264:   () => decodeAgentflowRunViews(name, { details: result.details }),",
      ].join("\n"),
    ),
  });

  t.tool(
    "tc-fffind",
    "fffind",
    {
      pattern: "**/tools/*.tsx",
      path: "packages/pi-web-ui-client/src/client",
      exclude: ["**/*.test.tsx"],
      limit: 25,
    },
    {
      content: text(
        [
          "packages/pi-web-ui-client/src/client/tools/agentflow.tsx",
          "packages/pi-web-ui-client/src/client/tools/background.tsx",
          "packages/pi-web-ui-client/src/client/tools/builtin.tsx",
        ].join("\n"),
      ),
    },
    BEAT,
  );
  t.running(BEAT, false);
}

function userImageTurn(t: Timeline): void {
  t.user(SECTION, [
    {
      type: "text",
      text: `Here is the screenshot of the collapsed row:\n\n${SHOWCASE_HOSTILE_MARKDOWN}`,
    },
    imageReference(),
    { type: "image-omission", reason: "image-too-large" },
  ]);
  t.assistant(BEAT, [
    {
      type: "text",
      text: "Got the screenshot. The second attachment was dropped by the host as oversized,\nwhich is the `image-omission` block right after it.",
    },
  ]);
}

function agentflow(t: Timeline): void {
  t.running(SECTION, true, "Delegating");

  t.call(0, "tc-af-finder", "agentflow_finder", {
    task: "Locate every place the browser validates a wire envelope.",
    paths: ["packages/pi-web-ui-client/src", "agent/extensions/web-ui/src"],
    mode: "foreground",
  });
  t.partial(STREAM, "tc-af-finder", "agentflow_finder", {
    content: text("run-mock-1 queued"),
    details: { snapshot: finderRun("queued") },
  });
  t.partial(STREAM, "tc-af-finder", "agentflow_finder", {
    content: text("run-mock-1 running"),
    details: { snapshot: finderRun("running-1") },
  });
  t.partial(STREAM, "tc-af-finder", "agentflow_finder", {
    content: text("run-mock-1 running · 3 tool calls"),
    details: { snapshot: finderRun("running-2") },
  });
  t.settle(BEAT, "tc-af-finder", "agentflow_finder", {
    content: text(
      "protocol.ts declares the schemas, session-state.ts enforces them, and\nstandalone-transport.ts is the only browser-side caller.",
    ),
    details: { snapshot: finderRun("completed"), result: finderStructuredResult },
  });

  t.tool(
    "tc-af-oracle",
    "agentflow_oracle",
    {
      question: "Why does an operation batch need both fromRevision and revision?",
      files: ["packages/pi-web-ui-client/src/client/session-state.ts"],
      mode: "foreground",
    },
    {
      content: text(
        "`fromRevision` proves contiguity against the reducer's current revision, while\n`revision` is the new watermark. Without both, a gap is indistinguishable from a\nreplay.",
      ),
      details: {
        snapshot: afRun({
          runId: "run-mock-oracle",
          originTool: "agentflow_oracle",
          semanticRole: "oracle",
          resultPreview: "Contiguity plus watermark; a gap would otherwise look like a replay.",
          nodes: [
            afNode({
              label: "oracle",
              semanticRole: "oracle",
              toolCalls: [afToolCall("or-1", "read", "completed", "session-state.ts:140-200")],
              usage: usage(12_700, 0.0298),
            }),
          ],
        }),
      },
    },
    BEAT,
  );

  t.tool(
    "tc-af-librarian",
    "agentflow_librarian",
    { question: "How does typebox's Check treat additionalProperties: false?", mode: "foreground" },
    {
      content: text("Unknown keys fail the check outright; there is no stripping pass."),
      details: {
        snapshot: afRun({
          runId: "run-mock-librarian",
          originTool: "agentflow_librarian",
          semanticRole: "librarian",
          resultPreview: "Unknown keys fail; typebox never strips.",
          nodes: [
            afNode({
              label: "librarian",
              semanticRole: "librarian",
              tools: 2,
              toolCalls: [afToolCall("lb-1", "web_search", "completed", "typebox Check strict")],
              usage: usage(8_400, 0.0171),
            }),
          ],
        }),
      },
    },
    BEAT,
  );

  t.tool(
    "tc-af-look",
    "agentflow_look_at",
    {
      path: SHOWCASE_LONG_PATH,
      objective: "Say whether the collapsed tool row shows a result summary.",
      context: "The row should read as live, not as a dead line.",
      referenceFiles: [
        "packages/pi-web-ui-client/src/client/renderers.tsx",
        "agent/extensions/agentflow/src/ui/run-card.ts",
      ],
      mode: "foreground",
    },
    {
      content: text("The collapsed row shows the header only; there is no result summary."),
      details: {
        snapshot: afRun({
          runId: "run-mock-look",
          originTool: "agentflow_look_at",
          semanticRole: "look_at",
          resultPreview: "No collapsed summary; the row looks dead.",
          nodes: [
            afNode({
              label: "look_at",
              semanticRole: "look_at",
              tools: 1,
              toolCalls: [afToolCall("lk-1", "read", "completed", "screenshot.png")],
              usage: usage(6_900, 0.0148),
            }),
          ],
        }),
      },
    },
    BEAT,
  );

  t.tool(
    "tc-af-delegate",
    "agentflow_delegate",
    {
      task: "Add a bounded typed decoder for SerializedJobs and wire it into the renderers.",
      ownership: [
        "packages/pi-web-ui-client/src/wire/background.ts",
        "packages/pi-web-ui-client/src/client/tools/background.tsx",
      ],
      acceptanceCriteria: [
        "Every JobSnapshot field is rendered exactly once.",
        "The monitor block decodes without any inline record() call.",
      ],
      verificationCommands: [
        "nub run --filter @dotfiles/pi-web-ui-client test",
        "nub run --filter pi-web-ui typecheck",
      ],
      continuationSessionFile: "/Users/tester/.pi/sessions/mock-delegate.jsonl",
      mode: "foreground",
    },
    {
      content: text("Error: the delegate run failed its verification commands."),
      details: { snapshot: failedRun() },
      isError: true,
    },
    BEAT,
  );

  t.tool(
    "tc-af-review",
    "agentflow_review",
    {
      task: "Review the mock server for protocol conformance.",
      base: "main",
      paths: ["agent/extensions/web-ui/mock"],
      mode: "foreground",
    },
    {
      content: text(
        "- The append anchor is always the previous entry id.\n- Every partial result clears when the durable result lands.",
      ),
      details: {
        snapshot: afRun({
          runId: "run-mock-review",
          originTool: "agentflow_review",
          semanticRole: "review",
          resultPreview: JSON.stringify({ findings: [{ severity: "info", count: 2 }] }),
          nodes: [
            afNode({
              label: "review",
              semanticRole: "review",
              backend: "claude",
              model: "opus",
              tools: 5,
              toolCalls: [
                afToolCall("rv-1", "bash", "completed", "git diff --stat main"),
                afToolCall("rv-2", "read", "completed", "mock/server.mjs"),
              ],
              usage: usage(33_100, 0.0912),
            }),
          ],
        }),
      },
    },
    BEAT,
  );

  t.tool(
    "tc-af-claude",
    "agentflow_claude",
    {
      task: "Give a second opinion on the operation-batch coalescing rules.",
      model: "opus",
      mode: "foreground",
    },
    {
      content: text("Coalescing is safe only for replaceable frames; appends must stay ordered."),
      details: {
        snapshot: afRun({
          runId: "run-mock-claude",
          originTool: "agentflow_claude",
          resultPreview: "Only replaceable frames may coalesce.",
          nodes: [
            afNode({
              label: "claude/opus",
              backend: "claude",
              model: "opus",
              tools: 3,
              toolCalls: [afToolCall("cl-1", "read", "completed", "sse.ts:143-173")],
              usage: usage(27_600, 0.0844),
            }),
          ],
        }),
      },
    },
    BEAT,
  );

  t.tool(
    "tc-af-agent",
    "agentflow_agent",
    {
      prompt: "Watch the bundle build and report the first failure.",
      label: "bundle-watcher",
      model: "gpt-5-codex",
      thinking: "low",
      cwd: "/Users/tester/project",
      mode: "background",
    },
    {
      content: text("Started run-mock-background in the background; delivery is pending."),
      details: { snapshot: backgroundAgentRun() },
    },
    BEAT,
  );

  t.tool(
    "tc-af-workflow",
    "agentflow_workflow",
    {
      script:
        'export const meta = { name: "release-audit" };\nexport default async function run(ctx) {\n  const survey = await ctx.phase("survey", [ctx.finder("wire"), ctx.finder("renderers")]);\n  await ctx.phase("verify", [ctx.review(survey)]);\n}\n',
      args: { base: "main" },
      limits: { maxAgents: 6, concurrency: 2, timeoutMs: 900_000, tokenBudget: 400_000 },
      mode: "foreground",
    },
    {
      content: text("release-audit is in the verify phase; 2 of 4 nodes completed."),
      details: { snapshot: workflowRun() },
    },
    BEAT,
  );

  t.tool(
    "tc-af-status",
    "agentflow_status",
    { runId: "run-mock-workflow" },
    {
      content: text("run-mock-workflow · running · phase verify"),
      details: { snapshot: workflowRun() },
    },
    BEAT,
  );

  t.tool(
    "tc-af-wait",
    "agentflow_wait",
    { runIds: ["run-mock-review", "run-mock-aborted"] },
    {
      content: text("1 run completed, 1 run aborted."),
      details: {
        results: [
          {
            runId: "run-mock-review",
            status: "completed",
            result: { findings: [{ severity: "info", note: "anchors are correct" }] },
            snapshot: afRun({
              runId: "run-mock-review",
              originTool: "agentflow_review",
              semanticRole: "review",
              resultPreview: "2 informational findings.",
              nodes: [
                afNode({
                  label: "review",
                  semanticRole: "review",
                  toolCalls: [afToolCall("rv-1", "bash", "completed", "git diff --stat main")],
                  usage: usage(33_100, 0.0912),
                }),
              ],
            }),
          },
          {
            runId: "run-mock-aborted",
            status: "aborted",
            error: "Aborted by the parent session.",
            snapshot: abortedRun(),
          },
        ],
      },
    },
    BEAT,
  );

  t.tool(
    "tc-af-cancel",
    "agentflow_cancel",
    { runIds: ["run-mock-background"] },
    {
      content: text("Cancelled run-mock-background."),
      details: {
        snapshots: [
          afRun({
            runId: "run-mock-background",
            status: "aborted",
            background: true,
            originTool: "agentflow_agent",
            error: "Cancelled on request.",
            nodes: [
              afNode({
                label: "bundle-watcher",
                status: "aborted",
                error: "cancelled",
                toolCalls: [
                  afToolCall("bg-1", "bash", "failed", "nub run build:watch", {
                    error: "terminated",
                  }),
                ],
                usage: usage(4_100, 0.0092),
              }),
            ],
            logs: ["cancel requested", "child terminated"],
          }),
        ],
      },
    },
    BEAT,
  );

  t.tool(
    "tc-af-steer",
    "agentflow_steer",
    {
      runId: "run-mock-workflow",
      nodeId: "verify",
      message: "Skip the WebKit run; Chromium parity is enough for this audit.",
    },
    { content: text("Steering delivered to node verify."), details: { nodeId: "verify" } },
    BEAT,
  );

  t.append(SECTION, {
    type: "custom_message",
    display: true,
    customType: "agentflow-result",
    content: "run-mock-1 (finder) completed: 3 files own the envelope contract.",
    details: {
      snapshot: finderRun("completed"),
      result: finderStructuredResult,
      costId: "agentflow:run-mock-1",
      cost: 0.0412,
    },
  });
  t.running(BEAT, false);
}

function backgroundProcesses(t: Timeline): void {
  t.running(SECTION, true, "Watching");

  t.tool(
    "tc-bg-run",
    "background_run",
    {
      command: "nub run --filter pi-web-ui build:watch",
      description: "Rebuild the browser bundle on every change",
      timeout: 1_800,
    },
    { content: text("Started bg_1."), details: serializedJobs([job()]) },
    BEAT,
  );

  t.call(0, "tc-bg-stream", "background_event_stream", {
    command: "nub run --filter pi-web-ui build:watch -- --logLevel info",
    description: "vite build watcher",
    timeout: 3_600,
    persistent: true,
  });
  t.partial(STREAM, "tc-bg-stream", "background_event_stream", {
    content: text("Started bg_2; awaiting the first monitor delivery."),
    details: serializedJobs([
      job({
        jobId: "bg_2",
        kind: "background_event_stream",
        description: undefined,
        createdAt: undefined,
        outputBytes: 0,
        outputPath: "/tmp/pi-bg/bg_2/output.log",
        metadataPath: "/tmp/pi-bg/bg_2/job.json",
      }),
    ]),
  });
  t.settle(BEAT, "tc-bg-stream", "background_event_stream", {
    content: text("Started bg_2; 3 deliveries so far."),
    details: serializedJobs([
      job({
        jobId: "bg_2",
        kind: "background_event_stream",
        description: undefined,
        createdAt: undefined,
        outputBytes: 18_402,
        outputPath: "/tmp/pi-bg/bg_2/output.log",
        metadataPath: "/tmp/pi-bg/bg_2/job.json",
        deliveryState: "sent",
        deliveryAttemptedAt: "2026-01-02T03:05:44.000Z",
        monitor: {
          deliveries: 3,
          droppedLines: 2,
          droppedBytes: 148,
          splitLines: 1,
          captureOnly: false,
        },
        tail: "dist/client/assets/app.js  351.87 kB\nbuilt in 1.42s",
      }),
    ]),
  });

  t.append(SECTION, {
    type: "custom_message",
    display: true,
    customType: "background-monitor-event",
    content: [
      "monitor bg_2 (vite build watcher)",
      "source sequences: 41-47",
      "dropped: 2 lines / 148 bytes",
      "split source lines: 1",
      "coalesced capture batches: 4",
      "output: /tmp/pi-bg/bg_2/output.log",
      "",
      "vite v6.0.11 building for production...",
      "transforming (184) src/client/renderers.tsx",
      "dist/client/assets/app.js  351.87 kB",
    ].join("\n"),
    details: monitorEvent(),
  });

  t.tool(
    "tc-bg-status",
    "background_status",
    { jobId: "bg_1", tailLines: 40 },
    {
      content: text("bg_1 completed with exit code 0."),
      details: serializedJobs([
        job({
          status: "completed",
          completedAt: "2026-01-02T03:06:02.000Z",
          durationMs: 61_040,
          exitCode: 0,
          outputBytes: 9_310,
          deliveryState: "consumed",
          deliveryAttemptedAt: "2026-01-02T03:06:02.500Z",
          tail: "watching for file changes...\nbuild completed in 1.19s",
          tailTruncated: true,
        }),
      ]),
    },
    BEAT,
  );

  t.tool(
    "tc-bg-wait",
    "background_wait",
    { jobIds: ["bg_1", "bg_3"], timeout: 120 },
    {
      content: text("bg_1 completed; bg_3 timed out."),
      details: serializedJobs([
        job({
          status: "completed",
          completedAt: "2026-01-02T03:06:02.000Z",
          durationMs: 61_040,
          exitCode: 0,
          deliveryState: "consumed",
          tail: "build completed in 1.19s",
        }),
        job({
          jobId: "bg_3",
          status: "timed_out",
          command: "playwright test --project=webkit",
          description: "WebKit end-to-end suite",
          createdAt: "2026-01-02T03:05:10.000Z",
          completedAt: "2026-01-02T03:07:10.000Z",
          durationMs: 120_000,
          exitCode: null,
          error: "Job exceeded its 120s timeout and was terminated.",
          requestedTerminalCause: "timeout",
          outputBytes: 44_120,
          outputPath: "/tmp/pi-bg/bg_3/output.log",
          metadataPath: "/tmp/pi-bg/bg_3/job.json",
          deliveryState: "failed",
          deliveryError: "Session was busy; delivery will retry.",
          deliveryPersistenceError: "Could not persist the delivery marker.",
          tail: "1) [webkit] transcript.spec.ts:44:3 › renders the tool gallery\n   Timeout of 30000ms exceeded.",
        }),
      ]),
    },
    BEAT,
  );

  t.tool(
    "tc-bg-stop",
    "background_stop",
    { jobIds: ["bg_2"] },
    {
      content: text("Stopped bg_2."),
      details: serializedJobs(
        [
          job({
            jobId: "bg_2",
            kind: "background_event_stream",
            status: "cancelled",
            description: undefined,
            createdAt: undefined,
            completedAt: "2026-01-02T03:07:31.000Z",
            durationMs: 149_002,
            exitCode: null,
            requestedTerminalCause: "stop",
            outputBytes: 22_884,
            outputPath: "/tmp/pi-bg/bg_2/output.log",
            metadataPath: "/tmp/pi-bg/bg_2/job.json",
            deliveryState: "sent",
            monitorDeliveryPersistenceError: "Monitor delivery marker could not be persisted.",
            monitor: {
              deliveries: 5,
              droppedLines: 2,
              droppedBytes: 148,
              splitLines: 1,
              captureOnly: true,
              deliveryError: "Live delivery limit reached.",
              completionOutput: "remaining",
            },
            tail: "watcher terminated",
          }),
        ],
        {
          truncated: true,
          omittedCount: 3,
          omittedJobs: {
            count: 3,
            firstJobId: "bg_4",
            lastJobId: "bg_6",
            guidance: "Call background_status with a jobId to inspect the omitted jobs.",
          },
        },
      ),
    },
    BEAT,
  );

  t.append(SECTION, {
    type: "custom_message",
    display: true,
    customType: "background-process-completion",
    content: JSON.stringify({
      jobs: [{ jobId: "bg_1", status: "completed", exitCode: 0 }],
      truncated: false,
      omittedCount: 0,
    }),
    details: serializedJobs([
      job({
        status: "completed",
        completedAt: "2026-01-02T03:06:02.000Z",
        durationMs: 61_040,
        exitCode: 0,
        deliveryState: "sent",
        deliveryAttemptedAt: "2026-01-02T03:06:03.000Z",
        tail: "build completed in 1.19s",
      }),
    ]),
  });
  t.running(BEAT, false);
}

function questionnaire(t: Timeline): void {
  t.call(SECTION, "tc-questionnaire", "questionnaire", { questions: questionnaireQuestions });
  t.partial(BEAT, "tc-questionnaire", "questionnaire", {
    content: text("Awaiting the remaining answer."),
    details: { questions: questionnaireQuestions, answers: [questionnaireAnswers[0]] },
  });
  t.settle(BEAT, "tc-questionnaire", "questionnaire", {
    content: text("Questionnaire completed"),
    details: { questions: questionnaireQuestions, answers: questionnaireAnswers, cancelled: false },
  });
}

function webAccess(t: Timeline): void {
  t.running(SECTION, true, "Researching");

  t.call(0, "tc-web-search", "web_search", {
    queries: [
      "server-sent events reconnect semantics browsers 2026",
      "EventSource retry backoff specification",
    ],
    numResults: 5,
    provider: "exa",
    recencyFilter: "year",
    domainFilter: ["developer.mozilla.org", "-example.invalid"],
  });
  t.partial(STREAM, "tc-web-search", "web_search", {
    content: text("Query 1 of 2 synthesized; fetching the second."),
    details: {
      phase: "searching",
      progress: 0.5,
      currentQuery: "EventSource retry backoff specification",
    },
  });
  t.settle(BEAT, "tc-web-search", "web_search", {
    content: text("EventSource reconnects automatically using the retry field."),
    details: {
      queryCount: 2,
      successfulQueries: 2,
      totalResults: 3,
      fetchId: "mock-fetch-1",
      curated: true,
      curatedFrom: 2,
      curatedQueries: [
        {
          query: "server-sent events reconnect semantics browsers 2026",
          provider: "exa",
          answer: "EventSource reconnects automatically using the `retry` field.",
          sources: [
            {
              title: "Using server-sent events",
              url: "https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events",
            },
          ],
          error: null,
        },
        {
          query: "EventSource retry backoff specification",
          provider: "exa",
          answer: "The specification leaves the backoff curve to the user agent.",
          sources: [
            {
              title: "HTML Living Standard",
              url: "https://html.spec.whatwg.org/multipage/server-sent-events.html",
            },
          ],
          error: null,
        },
      ],
      summary: {
        text: "## Approved summary\n\nEventSource reconnects using a configurable retry delay.",
        workflow: "summary-review",
        model: "openai/gpt-5-mini",
        durationMs: 420,
        tokenEstimate: 96,
        fallbackUsed: false,
        phase: "summary-model",
        edited: true,
      },
    },
  });

  t.tool(
    "tc-fetch",
    "fetch_content",
    {
      urls: ["https://developer.mozilla.org/en-US/docs/Web/API/EventSource"],
      prompt: "Extract only the reconnection rules.",
      timestamp: "2026-01-02",
      frames: 2,
      model: "gpt-5-mini",
    },
    {
      content: [
        ...text(
          "Reconnection: the user agent waits the reconnection time, then reissues the request\nwith Last-Event-ID. A 204 stops reconnection.",
        ),
        imageReference(),
      ],
      details: {
        urls: ["https://developer.mozilla.org/en-US/docs/Web/API/EventSource"],
        urlCount: 1,
        successful: 1,
        totalChars: 4_120,
        title: "EventSource",
        responseId: "mock-fetch-1",
        truncated: false,
        imageCount: 1,
        duration: 1.8,
      },
    },
    BEAT,
  );

  t.tool(
    "tc-get-search",
    "get_search_content",
    {
      responseId: "mock-search-1",
      query: "server-sent events reconnect semantics browsers 2026",
      url: "https://developer.mozilla.org/en-US/docs/Web/API/EventSource",
      offset: 0,
      limit: 400,
    },
    {
      content: text(
        lines(6, (index) => `stored line ${index + 1} of the cached article body`).join("\n"),
      ),
      details: {
        title: "EventSource",
        contentLength: 2_400,
        offset: 0,
        returnedChars: 400,
        nextOffset: 400,
        truncated: true,
      },
    },
    BEAT,
  );

  t.tool(
    "tc-source-check",
    "source_check",
    {
      claim: "EventSource retries with exponential backoff by specification.",
      queries: ["EventSource reconnection time specification"],
      numResults: 4,
      fetchContent: true,
      provider: "auto",
    },
    {
      content: text(
        [
          "Verdict: unsupported.",
          "The specification defines a reconnection time but does not mandate exponential",
          "backoff; browsers choose their own curve.",
          "Artifact responseId: mock-source-check-1",
        ].join("\n"),
      ),
      details: {
        responseId: "mock-source-check-1",
        artifact: {
          query: "EventSource retries with exponential backoff by specification.",
          claims: [
            {
              claim: "EventSource retries with exponential backoff by specification.",
              status: "unsupported",
              confidence: 0.94,
              rationale: "The standard defines a reconnection time, not exponential backoff.",
            },
          ],
          sources: [
            {
              rank: 1,
              quality: "primary",
              title: "HTML Living Standard",
              url: "https://html.spec.whatwg.org/multipage/server-sent-events.html",
            },
          ],
          errors: [],
        },
      },
    },
    BEAT,
  );
  t.running(BEAT, false);
}

function miscEntries(t: Timeline): void {
  t.append(SECTION, {
    type: "message",
    message: {
      role: "bashExecution",
      command: "git status --short",
      output:
        " M packages/pi-web-ui-client/src/client/renderers.tsx\n?? agent/extensions/web-ui/mock/",
      exitCode: 0,
      cancelled: false,
    },
  });
  t.append(BEAT, { type: "model_change", provider: "anthropic", modelId: "claude-opus-4-6" });
  t.append(BEAT, { type: "thinking_level_change", thinkingLevel: "xhigh" });
  t.append(BEAT, {
    type: "compaction",
    summary: "The builtin and fff exploration was compacted into a single summary.",
    tokensBefore: 148_320,
  });
  t.append(BEAT, {
    type: "branch_summary",
    summary: "**Branch summary:** the renderer rewrite branched off after the survey.",
  });
  t.append(BEAT, {
    type: "custom_message",
    display: true,
    customType: "note",
    content: "A plain displayed custom message, rendered as markdown with a `code span`.",
  });

  t.tool(
    "tc-unknown",
    "herdr_snapshot",
    { target: "cluster-7", includeMetrics: true, budget: { tokens: 4_000 } },
    {
      content: text(
        "cluster-7: 3 nodes healthy, 1 draining.\n(no renderer is registered for this tool)",
      ),
      details: { nodes: 4, draining: 1 },
    },
    BEAT,
  );

  t.queue(SECTION, [
    {
      id: "queued-1",
      content: "Then rewrite the TUI renderers the same way.",
      delivery: "followUp",
      itemVersion: 1,
      editable: true,
    },
    {
      id: "queued-2",
      content: "And add an image attachment to the next turn.",
      delivery: "steer",
      itemVersion: 1,
      editable: true,
      attachmentCount: 2,
      state: "held",
    },
  ]);
  t.queue(SECTION, [
    {
      id: "queued-2",
      content: "And add an image attachment to the next turn.",
      delivery: "steer",
      itemVersion: 2,
      editable: true,
      attachmentCount: 2,
      state: "releasing",
    },
  ]);
  t.queue(BEAT, []);
  t.metadata(BEAT, {
    contextUsage: { tokens: 132_400, contextWindow: 200_000, percent: 66 },
    sessionCost: 0.9142,
    thinkingLevel: "xhigh",
    model: { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
  });
}

/** Ends mid-turn: a pending call plus a live partial, exactly as a live session looks. */
function pendingTail(t: Timeline): void {
  t.running(SECTION, true, "Finishing");
  t.assistant(BEAT, [
    { type: "thinking", thinking: "One last verification run before reporting back." },
    { type: "text", text: "Re-running the bundle check to confirm nothing regressed." },
  ]);
  t.call(BEAT, "tc-tail-bash", "bash", {
    command: "nub run --filter pi-web-ui build:check",
    timeout: 600,
  });
  t.partial(SECTION, "tc-tail-bash", "bash", {
    content: text("vite v6.0.11 building for production..."),
  });
  t.call(SECTION, "tc-tail-pending", "grep", {
    pattern: "TODO",
    path: "agent/extensions/web-ui/mock",
  });
}

/**
 * Builds the scenario. `identity` supplies the host-owned generation identifiers that
 * the snapshot must carry; the host also owns `generation` and every revision number.
 */
export function toolShowcaseScenario(identity: ToolShowcaseIdentity): ToolShowcaseScenario {
  const t = new Timeline();
  t.seed({
    type: "message",
    message: {
      role: "user",
      content: text(
        [
          "# Renderer inspection",
          "",
          "Walk the **whole** tool surface so I can check every collapsed and expanded row:",
          "",
          "- builtins, fff, agentflow, background processes",
          "- questionnaire and web access",
          "- one unknown tool for the generic fallback",
          "",
          "```sh",
          "nub run --filter pi-web-ui mock -- --speed=0.25",
          "```",
          "",
          "See the [protocol contract](https://example.com/protocol) for the frame rules.",
        ].join("\n"),
      ),
    },
  });
  t.seed({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Start with the builtins, then widen out per extension." },
        {
          type: "text",
          text: "I'll go extension by extension. Each tool appears first without a result, then\nsettles a beat later.",
        },
      ],
    },
  });

  builtins(t);
  fff(t);
  userImageTurn(t);
  agentflow(t);
  backgroundProcesses(t);
  questionnaire(t);
  webAccess(t);
  miscEntries(t);
  pendingTail(t);

  return t.finish(identity);
}
