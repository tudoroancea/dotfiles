// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnsiOutput } from "../src/web/components/AnsiOutput.js";
import { ToolCall } from "../src/web/components/ToolCall.js";
import { highlightCode, resolveLanguage } from "../src/web/lib/highlight.js";
import { normalizeTool } from "../src/web/lib/tool-model.js";

afterEach(cleanup);

const tool = (
  name: string,
  args: Record<string, unknown>,
  result?: { content?: unknown[]; details?: Record<string, unknown>; isError?: boolean },
) =>
  normalizeTool({
    toolName: name,
    args,
    ...(result ? { result: { content: result.content ?? [], details: result.details } } : {}),
    status: result?.isError ? "error" : result ? "completed" : "running",
    ...(result?.isError ? { isError: true } : {}),
  });

describe("exporter-faithful tool presentation", () => {
  it("renders bash as `$ command` with per-line terminal output and a success tint", () => {
    const { container } = render(
      <ToolCall
        view={tool(
          "bash",
          { command: "ls -a" },
          { content: [{ type: "text", text: "file-a\nfile-b" }] },
        )}
      />,
    );
    // Exporter shows a "$" name and the command; status is a background tint class.
    expect(container.querySelector(".tool__glyph")?.textContent).toBe("$");
    expect(container.querySelector(".tool")?.className).toContain("tool--completed");
    const lines = [...container.querySelectorAll(".ansi-line")].map((line) => line.textContent);
    expect(lines).toEqual(["file-a", "file-b"]);
    // Terminal output is never a code element in the exporter's plain path.
    expect(container.querySelector(".tool__body code")).toBeNull();
  });

  it("matches exporter string coercion diagnostics for malformed and missing built-in args", () => {
    const { container, rerender } = render(<ToolCall view={tool("bash", { command: 42 })} />);
    expect(container.querySelector(".tool__command")?.textContent).toBe("[invalid arg]");
    expect(container.querySelector(".tool__command")?.classList.contains("tool__error")).toBe(true);

    for (const name of ["read", "write", "edit"]) {
      rerender(<ToolCall view={tool(name, { path: { unsafe: true }, content: "ok" })} />);
      expect(container.querySelector(".tool__path")?.textContent).toBe("[invalid arg]");
      expect(container.querySelector(".tool__path")?.classList.contains("tool__error")).toBe(true);

      rerender(<ToolCall view={tool(name, name === "write" ? { content: "ok" } : {})} />);
      expect(container.querySelector(".tool__path")?.textContent).toBe("");
    }

    rerender(<ToolCall view={tool("write", { path: "out.txt", content: 7 })} />);
    expect(container.querySelector(".tool__body")?.textContent).toBe(
      "[invalid content arg - expected string]",
    );
    rerender(<ToolCall view={tool("write", { path: "out.txt", content: null })} />);
    expect(container.querySelector(".tool__body")).toBeNull();
  });

  it("renders read as `read <path>:start-end` with an accent path", () => {
    const { container } = render(
      <ToolCall
        view={tool(
          "read",
          { path: "/repo/README.md", offset: 1, limit: 20 },
          { content: [{ type: "text", text: "line 1" }] },
        )}
      />,
    );
    expect(container.querySelector(".tool__glyph")?.textContent).toBe("read");
    expect(container.querySelector(".tool__path")?.textContent).toContain("README.md");
    expect(container.querySelector(".tool__range")?.textContent).toBe(":1-20");
  });

  it("shows a write line-count hint only when content exceeds its preview", () => {
    const longContent = Array.from({ length: 11 }, (_, index) => `line ${index + 1}`).join("\n");
    const { container, rerender } = render(
      <ToolCall
        view={tool("write", { file_path: "/Users/alice/src/new.ts", content: "a\nb\nc" })}
      />,
    );
    expect(container.querySelector(".tool__glyph")?.textContent).toBe("write");
    expect(container.querySelector(".tool__path")?.textContent).toBe("~/src/new.ts");
    expect(container.querySelector(".tool__hint")).toBeNull();
    rerender(<ToolCall view={tool("write", { path: "src/new.ts", content: longContent })} />);
    expect(container.querySelector(".tool__hint")?.textContent).toBe(" (11 lines)");
    expect(container.querySelector(".ansi-output__hint")?.textContent).toBe("... (1 more lines)");
  });

  it("renders edit as `edit <path>` with classified diff lines", () => {
    const { container, rerender } = render(
      <ToolCall
        view={tool(
          "edit",
          { path: "src/app.ts" },
          { content: [], details: { diff: "@@ -1 +1 @@\n-\told\n+\tnew\n context" } },
        )}
      />,
    );
    expect(container.querySelector(".tool__glyph")?.textContent).toBe("edit");
    expect(container.querySelector(".diff__line--added")?.textContent).toContain("+   new");
    expect(container.querySelector(".diff__line--removed")?.textContent).toContain("-   old");
    expect(container.querySelector(".diff__line--hunk")).toBeTruthy();
    expect(container.querySelector(".tool__body")?.classList.contains("tool__body--flush")).toBe(
      true,
    );

    rerender(
      <ToolCall
        view={tool("edit", { path: "src/app.ts" }, { content: [{ type: "text", text: "failed" }] })}
      />,
    );
    expect(container.querySelector('[aria-label="edit output"]')).toBeTruthy();
    expect(container.querySelector(".tool__body")?.classList.contains("tool__body--flush")).toBe(
      false,
    );
  });

  it("renders ls as `ls <path>`", () => {
    const { container } = render(
      <ToolCall
        view={tool("ls", { path: "src" }, { content: [{ type: "text", text: "a\nb" }] })}
      />,
    );
    expect(container.querySelector(".tool__glyph")?.textContent).toBe("ls");
    expect(container.querySelector(".tool__path")?.textContent).toBe("src");
  });

  it("uses static non-focusable headers and trims only exporter-trimmed branches", () => {
    const { container, rerender } = render(
      <ToolCall
        view={tool(
          "bash",
          { command: "echo" },
          { content: [{ type: "text", text: "\n one\tvalue \n" }] },
        )}
      />,
    );
    const head = container.querySelector(".tool__head")!;
    expect(head.tagName).toBe("DIV");
    expect(head.getAttribute("tabindex")).toBeNull();
    expect(container.querySelector(".ansi-line")?.textContent).toBe("one   value");

    rerender(
      <ToolCall
        view={tool(
          "read",
          { path: "notes.txt" },
          { content: [{ type: "text", text: "\nraw\ttext\n" }] },
        )}
      />,
    );
    expect([...container.querySelectorAll(".ansi-line")].map((line) => line.textContent)).toEqual([
      "",
      "raw   text",
      "",
    ]);

    rerender(
      <ToolCall
        view={tool(
          "write",
          { path: "notes.txt", content: "\nbody\n" },
          { content: [{ type: "text", text: "\n wrote \n" }] },
        )}
      />,
    );
    expect(container.querySelector('[aria-label="write content"] .ansi-line')?.textContent).toBe(
      "",
    );
    expect(container.querySelector('[aria-label="write output"]')?.textContent).toBe("wrote");
  });

  it("registers exactly the exporter path-language matrix, including Dockerfile", () => {
    const matrix = {
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      py: "python",
      rb: "ruby",
      rs: "rust",
      go: "go",
      java: "java",
      c: "c",
      cpp: "cpp",
      h: "c",
      hpp: "cpp",
      cs: "csharp",
      php: "php",
      sh: "bash",
      bash: "bash",
      zsh: "bash",
      sql: "sql",
      html: "xml",
      css: "css",
      scss: "scss",
      json: "json",
      yaml: "yaml",
      yml: "yaml",
      xml: "xml",
      md: "markdown",
      dockerfile: "dockerfile",
    } as const;
    for (const [pathKey, language] of Object.entries(matrix)) {
      expect(resolveLanguage(pathKey)).toBe(language);
    }
    expect(resolveLanguage("unknown-data")).toBeUndefined();
    expect(highlightCode("<unsafe>", "unknown-data")).toBe("&lt;unsafe&gt;");
  });

  it("highlights recognized read/write paths and safely falls back to plain output", () => {
    const { container, rerender } = render(
      <ToolCall
        view={tool(
          "read",
          { path: "src/app.ts" },
          { content: [{ type: "text", text: "const x\t= '<tag>';" }] },
        )}
      />,
    );
    const highlighted = container.querySelector('[aria-label="read output"] code')!;
    expect(highlighted.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(highlighted.textContent).toContain("x   = '<tag>';");
    expect(highlighted.querySelector("tag")).toBeNull();

    rerender(<ToolCall view={tool("write", { path: "config.json", content: '{"safe":"<b>"}' })} />);
    expect(container.querySelector('[aria-label="write content"] .hljs-string')).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();

    rerender(
      <ToolCall
        view={tool(
          "read",
          { path: "unknown.data" },
          { content: [{ type: "text", text: "<i>plain</i>" }] },
        )}
      />,
    );
    expect(container.querySelector('[aria-label="read output"] code')).toBeNull();
    expect(container.querySelector('[aria-label="read output"]')?.textContent).toBe("<i>plain</i>");
    expect(container.querySelector("i")).toBeNull();

    rerender(
      <ToolCall
        view={tool("write", { path: "not-exporter.typescript", content: "const x = 1" })}
      />,
    );
    expect(container.querySelector('[aria-label="write content"] code')).toBeNull();

    rerender(<ToolCall view={tool("write", { path: "Dockerfile", content: "FROM alpine" })} />);
    expect(container.querySelector('[aria-label="write content"] .hljs-keyword')?.textContent).toBe(
      "FROM",
    );
  });

  it("renders mixed read images before text output", () => {
    const { container } = render(
      <ToolCall
        view={tool(
          "read",
          { path: "mixed.txt" },
          {
            content: [
              { type: "text", text: "after image" },
              { type: "image", mimeType: "image/png", data: "eA==" },
            ],
          },
        )}
      />,
    );
    const body = container.querySelector(".tool__body")!;
    const image = body.querySelector("img")!;
    const text = body.querySelector('[aria-label="read output"]')!;
    expect(image.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("does not pointer-toggle selected output but keeps keyboard activation", () => {
    const long = Array.from({ length: 6 }, (_, index) => String(index + 1)).join("\n");
    const { container } = render(
      <ToolCall
        view={tool("bash", { command: "seq 6" }, { content: [{ type: "text", text: long }] })}
      />,
    );
    const output = container.querySelector<HTMLButtonElement>(".exporter-output")!;
    vi.spyOn(window, "getSelection").mockReturnValue({ isCollapsed: false } as Selection);
    fireEvent.click(output, { detail: 1 });
    expect(output.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(output, { detail: 0 });
    expect(output.getAttribute("aria-expanded")).toBe("true");
  });

  it("gives an unknown tool a terminal-like generic fallback", () => {
    const { container } = render(
      <ToolCall
        view={tool("mystery", { a: 1 }, { content: [{ type: "text", text: "done\nok" }] })}
      />,
    );
    expect(container.querySelector(".tool__glyph")?.textContent).toBe("▸");
    expect(container.querySelector(".ansi-output .ansi-line")?.textContent).toBe("done");
  });
});

describe("untrusted terminal output stays inert text", () => {
  it("renders markup and ANSI as escaped text, never as DOM or styling", () => {
    const hostile = "\u001b[31m<script>alert(1)</script></summary>\u001b[0m\u0007 plain";
    const { container } = render(<AnsiOutput text={hostile} />);
    // No raw markup is materialized.
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("summary")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    // ANSI SGR introducers and the bell control action are stripped, not honored.
    const text = container.querySelector(".ansi-line")?.textContent ?? "";
    expect(text).toContain("<script>alert(1)</script>");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("[31m");
    // No inline style/attribute smuggling: the only nodes are line divs.
    for (const node of container.querySelectorAll("*")) {
      expect(node.tagName.toLowerCase()).toBe("div");
      expect(node.getAttribute("style")).toBeNull();
    }
  });

  it("normalizes tabs to three spaces and leaves blank lines empty for CSS height", () => {
    const { container } = render(<AnsiOutput text={"one\tvalue\n\nthree"} />);
    const lines = [...container.querySelectorAll(".ansi-line")].map((line) => line.textContent);
    expect(lines).toEqual(["one   value", "", "three"]);
  });

  it("does not truncate non-home paths and exposes status without visible badges", () => {
    const path = "/very/long/non-home/path/that/must/remain/complete/source.ts";
    const { container } = render(
      <ToolCall
        view={tool("read", { file_path: path }, { content: [{ type: "text", text: "ok" }] })}
      />,
    );
    expect(container.querySelector(".tool__path")?.textContent).toBe(path);
    expect(container.querySelector(".tool__status")).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Done");
  });
});
