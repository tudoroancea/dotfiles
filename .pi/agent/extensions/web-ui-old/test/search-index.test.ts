import { describe, expect, it } from "vitest";
import type { PersistedEntry } from "../src/shared/wire.js";
import { extractSearchText, LoadedEntrySearchIndex } from "../src/web/search-index.js";

function messageEntry(
  id: string,
  role: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
): PersistedEntry {
  return {
    id,
    parentId: null,
    timestamp: id,
    entryType: "message",
    payload: { message: { role, content, ...extra } },
  };
}

function textEntry(id: string, text: string, role = "user"): PersistedEntry {
  return messageEntry(id, role, [{ type: "text", text }]);
}

function toolCallEntry(id: string, callId: string, name: string, args: unknown): PersistedEntry {
  return messageEntry(id, "assistant", [{ type: "toolCall", id: callId, name, arguments: args }]);
}

function toolResultEntry(
  id: string,
  callId: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
): PersistedEntry {
  return messageEntry(id, "toolResult", content, { toolCallId: callId, ...extra });
}

describe("extractSearchText", () => {
  it("collects prose, thinking, and error text from a message row", () => {
    const entry = messageEntry(
      "m1",
      "assistant",
      [
        "leading string",
        { type: "text", text: "hello world" },
        { type: "thinking", thinking: "quiet reasoning" },
        { type: "reasoning", text: "more thought" },
      ],
      { errorMessage: "boom failed" },
    );
    const text = extractSearchText(entry);
    expect(text).toContain("leading string");
    expect(text).toContain("hello world");
    expect(text).toContain("quiet reasoning");
    expect(text).toContain("more thought");
    expect(text).toContain("boom failed");
  });

  it("indexes tool-call argument values a row renders", () => {
    const entry = toolCallEntry("m2", "call-1", "bash", {
      command: "grep needle haystack",
      cwd: "/tmp/project",
    });
    const text = extractSearchText(entry);
    expect(text).toContain("bash");
    expect(text).toContain("grep needle haystack");
    expect(text).toContain("/tmp/project");
  });

  it("indexes write/edit argument text", () => {
    const entry = toolCallEntry("m3", "call-2", "write", {
      file_path: "src/app.ts",
      content: "export const answer = 42;",
    });
    const text = extractSearchText(entry);
    expect(text).toContain("src/app.ts");
    expect(text).toContain("export const answer = 42;");
  });

  it("indexes tool-result output and generic details", () => {
    const entry = toolResultEntry("r1", "call-3", [{ type: "text", text: "compiled ok" }], {
      toolName: "bash",
      details: { exitCode: 0, stderr: "warning: deprecated flag" },
    });
    const text = extractSearchText(entry);
    expect(text).toContain("compiled ok");
    expect(text).toContain("bash");
    expect(text).toContain("exitCode");
    expect(text).toContain("warning: deprecated flag");
  });

  it("indexes custom_message details and normalized custom type", () => {
    const entry: PersistedEntry = {
      id: "c1",
      parentId: null,
      timestamp: "c1",
      entryType: "custom_message",
      payload: {
        customType: "agentflow-result",
        content: [{ type: "text", text: "flow output" }],
        details: { jobs: [{ jobId: "job-7", status: "done" }] },
      },
    };
    const text = extractSearchText(entry);
    expect(text).toContain("agentflow result");
    expect(text).toContain("flow output");
    expect(text).toContain("job-7");
    expect(text).toContain("done");
  });

  it("indexes questionnaire-like answers held in details", () => {
    const entry = toolResultEntry("r2", "call-4", [], {
      toolName: "questionnaire",
      details: { answers: [{ id: "color", label: "cerulean blue" }] },
    });
    const text = extractSearchText(entry);
    expect(text).toContain("color");
    expect(text).toContain("cerulean blue");
  });

  it("indexes renderable fallback payloads", () => {
    const entry: PersistedEntry = {
      id: "f1",
      parentId: null,
      timestamp: "f1",
      entryType: "diagnostic",
      payload: { level: "warn", note: "unexpected token near line 4" },
    };
    const text = extractSearchText(entry);
    expect(text).toContain("level");
    expect(text).toContain("warn");
    expect(text).toContain("unexpected token near line 4");
  });

  it("excludes non-renderable and internal entries", () => {
    expect(
      extractSearchText({
        id: "s1",
        parentId: null,
        timestamp: "s1",
        entryType: "custom",
        payload: { customType: "web-ui-startup" },
      }),
    ).toBe("");
    expect(
      extractSearchText({
        id: "h1",
        parentId: null,
        timestamp: "h1",
        entryType: "custom_message",
        payload: {
          customType: "hidden",
          content: [{ type: "text", text: "hidden" }],
          display: false,
        },
      }),
    ).toBe("");
  });

  it("never indexes image base64 payloads, including deeply nested ones", () => {
    const base64 = "QUJDQUJDQUJDQUJD".repeat(64);
    const contentImage = messageEntry("img", "user", [
      { type: "text", text: "see attachment" },
      { type: "image", mimeType: "image/png", data: base64 },
    ]);
    const contentText = extractSearchText(contentImage);
    expect(contentText).toContain("see attachment");
    expect(contentText).not.toContain(base64);
    expect(contentText).not.toContain("QUJD");

    const nestedImage = toolResultEntry(
      "r3",
      "call-5",
      [{ type: "text", text: "captured screen" }],
      {
        details: { screenshot: { type: "image", mimeType: "image/png", data: base64 } },
      },
    );
    const nestedText = extractSearchText(nestedImage);
    expect(nestedText).toContain("captured screen");
    expect(nestedText).toContain("screenshot");
    expect(nestedText).not.toContain(base64);
    expect(nestedText).not.toContain("QUJD");
  });

  it("bounds recursively collected detail text", () => {
    const entry = toolResultEntry("bounded", "call-bounded", [], {
      details: { output: `${"a".repeat(25_000)}unreachable-suffix` },
    });
    const text = extractSearchText(entry);
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(text).not.toContain("unreachable-suffix");
  });

  it("strips ANSI and control sequences from indexed text", () => {
    const entry = textEntry("a1", "red[31mtext[0mbell");
    expect(extractSearchText(entry)).toBe("redtextbell");
  });
});

describe("LoadedEntrySearchIndex", () => {
  it("appends and prepends in chronological order", () => {
    const index = new LoadedEntrySearchIndex();
    index.append([textEntry("b", "target middle"), textEntry("c", "target tail")]);
    index.prepend([textEntry("a", "target head")]);

    const result = index.query("target");
    expect(result.matches.map((match) => match.entryId)).toEqual(["a", "b", "c"]);
    expect(result.totalMatches).toBe(3);
  });

  it("deduplicates by stable entry ID across overlapping loads", () => {
    const index = new LoadedEntrySearchIndex();
    index.append([textEntry("x", "alpha"), textEntry("y", "alpha")]);
    index.append([textEntry("y", "alpha"), textEntry("z", "alpha")]);
    index.prepend([textEntry("x", "alpha")]);

    const result = index.query("alpha");
    expect(result.matches.map((match) => match.entryId)).toEqual(["x", "y", "z"]);
    expect(index.size).toBe(3);
  });

  it("counts multiple occurrences case-insensitively", () => {
    const index = new LoadedEntrySearchIndex();
    index.append([textEntry("m", "Match match MATCH once")]);
    expect(index.query("match").totalMatches).toBe(3);
  });

  it("treats whitespace-only queries as empty even when text contains spaces", () => {
    const index = new LoadedEntrySearchIndex();
    index.append([textEntry("m", "a query with   several   spaces")]);
    // The corpus literally contains runs of whitespace, so an unguarded search
    // would match; a blank query must still report nothing.
    expect(index.query("   ")).toMatchObject({ matches: [], totalMatches: 0 });
    expect(index.query(" \t\n")).toMatchObject({ matches: [], totalMatches: 0 });
    expect(index.query("").matches).toEqual([]);
  });

  it("keeps tool-call arguments off the invoking assistant's own row", () => {
    const index = new LoadedEntrySearchIndex();
    index.append([
      messageEntry("a1", "assistant", [
        { type: "text", text: "running the search now" },
        { type: "toolCall", id: "call-9", name: "grep", arguments: { pattern: "needle" } },
      ]),
    ]);
    const assistantRow = index.query("running the search").matches;
    expect(assistantRow).toHaveLength(1);
    expect(assistantRow[0]?.rowKey).toBe("entry:a1");

    const toolRow = index.query("needle").matches;
    expect(toolRow).toHaveLength(1);
    expect(toolRow[0]?.rowKey).toBe("tool:call-9");
  });

  it("merges a call and result into one match when the call loads first", () => {
    const index = new LoadedEntrySearchIndex();
    index.append([toolCallEntry("a1", "call-7", "bash", { command: "make build" })]);
    index.append([
      toolResultEntry("r1", "call-7", [{ type: "text", text: "build finished" }], {
        toolName: "bash",
      }),
    ]);

    // Both the argument and the output text discover the same single row.
    const byArg = index.query("make build").matches;
    const byOutput = index.query("build finished").matches;
    expect(byArg).toHaveLength(1);
    expect(byOutput).toHaveLength(1);
    expect(byArg[0]?.rowKey).toBe("tool:call-7");
    // The tool-result row is the navigation anchor once loaded.
    expect(byArg[0]?.entryId).toBe("r1");
    // "build" occurs in the argument and the output: one merged count.
    expect(index.query("build").matches).toHaveLength(1);
    expect(index.query("build").matches[0]?.count).toBe(2);
  });

  it("merges a call and result into one match when the result loads first via prepend", () => {
    const index = new LoadedEntrySearchIndex();
    // Result already loaded in the tail; the invoking call arrives in an older page.
    index.append([
      toolResultEntry("r1", "call-8", [{ type: "text", text: "shared token output" }], {
        toolName: "bash",
      }),
    ]);
    index.prepend([toolCallEntry("a1", "call-8", "bash", { command: "shared token command" })]);

    const merged = index.query("shared token");
    expect(merged.matches).toHaveLength(1);
    expect(merged.matches[0]?.rowKey).toBe("tool:call-8");
    expect(merged.matches[0]?.entryId).toBe("r1");
    expect(merged.matches[0]?.count).toBe(2);
    expect(merged.totalMatches).toBe(2);
  });

  it("uses the shared tool-result row key so results can mount their row", () => {
    const index = new LoadedEntrySearchIndex();
    index.append([toolResultEntry("r1", "call-42", [{ type: "text", text: "compiled ok" }])]);
    expect(index.query("compiled").matches[0]?.rowKey).toBe("tool:call-42");
  });

  it("resets atomically, discarding the whole loaded window", () => {
    const index = new LoadedEntrySearchIndex();
    index.append([textEntry("k", "keeper")]);
    index.reset();
    expect(index.size).toBe(0);
    expect(index.query("keeper").matches).toEqual([]);
    index.append([textEntry("k", "keeper")]);
    expect(index.query("keeper").matches).toHaveLength(1);
  });
});
