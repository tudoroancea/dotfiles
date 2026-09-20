// Deterministic, host-neutral transcript fixtures.
//
// These drive renderer/parity tests without HTTP or Pi and give the standalone
// extension and future daemon a shared reference. Timestamps are fixed so output
// is byte-stable. Hostile payloads (script/HTML injection, dangerous URL schemes,
// oversized paths) exercise the sanitization and wrapping paths.

import type { SessionMetadata, Snapshot } from "../wire/types.ts";
import { questionnaireFixtureEntries } from "./questionnaire-fixtures.ts";

// A transcript entry as it appears on the wire: an opaque record that always
// carries a stable `id`. Renderers treat the remaining fields as untrusted.
interface FixtureEntry {
  id: string;
  [key: string]: unknown;
}

const BASE_TIME = Date.UTC(2026, 0, 2, 3, 4, 5);
export const FIXTURE_IMAGE_ID = "fixtureimagekeyedopaque0000000000000000000001";

/** Stable references/omissions shared by mock-host renderer tests. */
export function imageFixtureEntries(): FixtureEntry[] {
  const reference = {
    type: "image-reference",
    id: FIXTURE_IMAGE_ID,
    mimeType: "image/png",
    width: 2,
    height: 1,
    byteLength: 74,
  } as const;
  const reasons = [
    "invalid-data",
    "unsupported-format",
    "signature-mismatch",
    "animated-image",
    "image-too-large",
    "dimensions-exceeded",
    "pixels-exceeded",
    "count-exceeded",
    "aggregate-bytes-exceeded",
  ] as const;
  return [
    messageEntry("fx-image-user", null, 100, {
      role: "user",
      content: [reference, ...reasons.map((reason) => ({ type: "image-omission", reason }))],
    }),
    messageEntry("fx-image-call", "fx-image-user", 101, {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc-image", name: "read", arguments: { path: "picture.png" } },
      ],
    }),
    messageEntry("fx-image-result", "fx-image-call", 102, {
      role: "toolResult",
      toolCallId: "tc-image",
      toolName: "read",
      content: [reference],
      isError: false,
    }),
  ];
}

function ts(index: number): string {
  return new Date(BASE_TIME + index * 1_000).toISOString();
}

function messageEntry(
  id: string,
  parentId: string | null,
  index: number,
  message: unknown,
): FixtureEntry {
  return { id, parentId, timestamp: ts(index), type: "message", message };
}

export const HOSTILE_MARKDOWN =
  "Injection attempt: <script>alert(1)</script> and <img src=x onerror=alert(2)> plus " +
  "[evil link](javascript:alert(3)) and [safe link](https://example.com) and " +
  "![data image](data:text/html;base64,PHNjcmlwdD4=) — literal `<b>tags</b>` stay text.";

export const LONG_PATH =
  "/var/folders/3_/hp4nl8v920364pxvzx8rx2m40000gn/T/TemporaryItems/NSIRD_screencaptureui_" +
  "JQfDho/Screenshot 2026-07-26 at 00.06.11.png";

// A broad, deterministic set of entries covering every renderer branch.
export function broadFixtureEntries(): FixtureEntry[] {
  return [
    messageEntry("fx-user-md", null, 0, {
      role: "user",
      content: [
        { type: "text", text: "# Heading\n\nA **user** message with a list:\n\n- one\n- two" },
      ],
    }),
    messageEntry("fx-assistant", "fx-user-md", 1, {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Private reasoning about the request." },
        {
          type: "text",
          text: "A visible assistant response with `code` and a [link](https://example.com).",
        },
      ],
    }),
    messageEntry("fx-hostile", "fx-assistant", 2, {
      role: "assistant",
      content: [{ type: "text", text: HOSTILE_MARKDOWN }],
    }),
    messageEntry("fx-bash-call", "fx-hostile", 3, {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-bash",
          name: "bash",
          arguments: { command: "ls -la\ngrep foo", timeout: 30 },
        },
      ],
    }),
    messageEntry("fx-bash-result", "fx-bash-call", 4, {
      role: "toolResult",
      toolCallId: "tc-bash",
      toolName: "bash",
      content: [{ type: "text", text: "total 4\nline 2\nline 3\nline 4" }],
      isError: false,
    }),
    messageEntry("fx-read-call", "fx-bash-result", 5, {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-read",
          name: "read",
          arguments: { path: LONG_PATH, offset: 1, limit: 20 },
        },
      ],
    }),
    messageEntry("fx-read-result", "fx-read-call", 6, {
      role: "toolResult",
      toolCallId: "tc-read",
      toolName: "read",
      content: [
        {
          type: "text",
          text: Array.from({ length: 30 }, (_, i) => `read line ${i}`).join("\n"),
        },
      ],
      details: {
        truncation: {
          truncated: true,
          truncatedBy: "lines",
          outputLines: 20,
          totalLines: 30,
          maxLines: 2000,
        },
      },
      isError: false,
    }),
    messageEntry("fx-write-call", "fx-read-result", 7, {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-write",
          name: "write",
          arguments: { path: "/tmp/out.txt", content: "alpha\nbeta\ngamma" },
        },
      ],
    }),
    messageEntry("fx-write-result", "fx-write-call", 8, {
      role: "toolResult",
      toolCallId: "tc-write",
      toolName: "write",
      content: [{ type: "text", text: "Wrote 3 lines" }],
      isError: false,
    }),
    messageEntry("fx-edit-call", "fx-write-result", 9, {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-edit",
          name: "edit",
          arguments: { path: "/tmp/out.txt", edits: [{ oldText: "a", newText: "b" }] },
        },
      ],
    }),
    messageEntry("fx-edit-result", "fx-edit-call", 10, {
      role: "toolResult",
      toolCallId: "tc-edit",
      toolName: "edit",
      content: [{ type: "text", text: "applied" }],
      details: { diff: "--- a/tmp/out.txt\n+++ b/tmp/out.txt\n-alpha\n+ALPHA\n context" },
      isError: false,
    }),
    messageEntry("fx-af-call", "fx-edit-result", 11, {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-af",
          name: "agentflow_review",
          arguments: { task: "Review the screenshots at " + LONG_PATH },
        },
      ],
    }),
    messageEntry("fx-af-result", "fx-af-call", 12, {
      role: "toolResult",
      toolCallId: "tc-af",
      toolName: "agentflow_review",
      content: [{ type: "text", text: `- Fully captured screenshot at:\n  ${LONG_PATH}` }],
      details: {
        snapshot: {
          runId: "run-1",
          status: "completed",
          semanticRole: "review",
          nodes: [
            {
              status: "completed",
              backend: "claude",
              model: "opus",
              tools: 3,
              usage: { total: 12_345, cost: 0.0421 },
              resultPreview: JSON.stringify({ findings: [{ a: 1 }, { b: 2 }] }),
              toolCalls: [
                { id: "n1", name: "read", status: "completed", argumentSummary: "file.ts" },
              ],
            },
          ],
        },
      },
      isError: false,
    }),
    messageEntry("fx-bg-call", "fx-af-result", 13, {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-bg",
          name: "background_run",
          arguments: { command: "npm test", description: "run tests" },
        },
      ],
    }),
    messageEntry("fx-bg-result", "fx-bg-call", 14, {
      role: "toolResult",
      toolCallId: "tc-bg",
      toolName: "background_run",
      content: [{ type: "text", text: "started" }],
      details: {
        jobs: [
          {
            jobId: "bg_1",
            kind: "background_run",
            command: "npm test",
            description: "run tests",
            cwd: "/Users/tester/project",
            status: "running",
            durationMs: 1500,
            outputBytes: 4096,
            outputPath: "/tmp/bg/output.log",
            metadataPath: "/tmp/bg/job.json",
            deliveryState: "pending",
            tail: "PASS suite\nPASS other",
          },
        ],
        truncated: false,
        omittedCount: 0,
      },
      isError: false,
    }),
    messageEntry("fx-bash-exec", "fx-bg-result", 15, {
      role: "bashExecution",
      command: "echo hi",
      output: "hi",
      exitCode: 0,
      cancelled: false,
    }),
    {
      id: "fx-model",
      parentId: "fx-bash-exec",
      timestamp: ts(16),
      type: "model_change",
      provider: "anthropic",
      modelId: "claude-opus",
    },
    {
      id: "fx-think",
      parentId: "fx-model",
      timestamp: ts(17),
      type: "thinking_level_change",
      thinkingLevel: "high",
    },
    {
      id: "fx-compaction",
      parentId: "fx-think",
      timestamp: ts(18),
      type: "compaction",
      summary: "Earlier work was summarized here.",
      tokensBefore: 12_345,
    },
    {
      id: "fx-branch",
      parentId: "fx-compaction",
      timestamp: ts(19),
      type: "branch_summary",
      summary: "**Branch** summary content.",
    },
    {
      id: "fx-custom",
      parentId: "fx-branch",
      timestamp: ts(20),
      type: "custom_message",
      display: true,
      customType: "note",
      content: "A displayed custom message.",
    },
    {
      id: "fx-bg-completion",
      parentId: "fx-custom",
      timestamp: ts(21),
      type: "custom_message",
      display: true,
      customType: "background-process-completion",
      content:
        '{"jobs":[{"jobId":"bg_1","kind":"background_run","status":"completed","command":"sleep 30","description":"Wait for …","cwd":"/Users/tester/project","durationMs":30020,"exitCode":0,"outputBytes":0,"outputPath":"/tmp/bg/output.log","metadataPath":"/tmp/bg/job.json","deliveryState":"sent","tail":"(no output)"}],"truncated":false,"omittedCount":0}',
      details: {
        jobs: [
          {
            jobId: "bg_1",
            kind: "background_run",
            status: "completed",
            command: "sleep 30",
            description: "Wait for 30 seconds",
            cwd: "/Users/tester/project",
            durationMs: 30020,
            exitCode: 0,
            outputBytes: 0,
            outputPath: "/tmp/bg/output.log",
            metadataPath: "/tmp/bg/job.json",
            deliveryState: "sent",
            tail: "(no output)",
          },
        ],
        truncated: false,
        omittedCount: 0,
      },
    },
    {
      id: "fx-bg-monitor",
      parentId: "fx-bg-completion",
      timestamp: ts(22),
      type: "custom_message",
      display: true,
      customType: "background-monitor-event",
      content:
        "monitor bg_2 (ping loop)\nsource sequences: 1-3\ndropped: 0 lines / 0 bytes\n\nline one\nline two",
      details: {
        jobId: "bg_2",
        description: "ping loop",
        outputPath: "/tmp/bg2/output.log",
        delivery: 1,
        lines: ["line one", "line two"],
        firstSequence: 1,
        lastSequence: 3,
        droppedLines: 0,
        droppedBytes: 0,
        splitLines: 0,
        captureBatches: 1,
        captureOnly: false,
      },
    },
    messageEntry("fx-skill", "fx-bg-monitor", 23, {
      role: "user",
      content: [
        {
          type: "text",
          text: '<skill name="demo" location="/skills/demo">\nSkill body content here.\n</skill>\n\nPlease apply the demo skill.',
        },
      ],
    }),
    ...questionnaireFixtureEntries(),
  ];
}

export const BASE_METADATA: SessionMetadata = {
  cwd: "/Users/tester/project",
  home: "/Users/tester",
  contextUsage: { tokens: 32_000, contextWindow: 128_000, percent: 25 },
  sessionCost: 0.0123,
  model: { provider: "test", id: "fixture-model", name: "Fixture Model" },
  thinkingLevel: "high",
};

/** A deterministic full snapshot exercising every renderer branch and hostile input. */
export function broadSnapshot(): Snapshot {
  const entries = broadFixtureEntries();
  return {
    header: { id: "fixture-session-broad" },
    leafId: entries.at(-1)!.id,
    sessionName: "Broad fixture",
    isRunning: false,
    workingWord: undefined,
    theme: undefined,
    systemPrompt: "You are the deterministic test assistant.",
    metadata: BASE_METADATA,
    pendingInputs: [],
    entries,
  };
}

/** Generate a deterministic multi-thousand-entry session snapshot. */
export function generateLargeSession(count = 5_000): Snapshot {
  const entries: FixtureEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const parentId = index === 0 ? null : `large-${index - 1}`;
    if (index % 2 === 0) {
      entries.push(
        messageEntry(`large-${index}`, parentId, index, {
          role: "user",
          content: [{ type: "text", text: `Large session message ${index}` }],
        }),
      );
    } else {
      entries.push(
        messageEntry(`large-${index}`, parentId, index, {
          role: "assistant",
          content: [{ type: "text", text: `Assistant reply ${index} with **markdown**.` }],
        }),
      );
    }
  }
  return {
    header: { id: "fixture-session-large" },
    leafId: count ? `large-${count - 1}` : null,
    sessionName: "Large fixture",
    isRunning: false,
    workingWord: undefined,
    theme: undefined,
    systemPrompt: "",
    metadata: BASE_METADATA,
    pendingInputs: [],
    entries,
  };
}
