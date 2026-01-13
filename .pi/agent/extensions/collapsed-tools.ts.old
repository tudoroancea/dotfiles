/**
 * Collapsed Tools Extension
 *
 * Overrides all built-in tools to show collapsed output by default.
 * Press Ctrl+O to expand and see the full content.
 *
 * - read: Shows "✓ Read <path>" → expands to file content
 * - edit: Shows "✓ Edit <path>" → expands to colored diff
 * - write: Shows "✓ Write <path>" → expands to file content
 * - bash: Shows "✓ <command>" with exit code → expands to output
 * - grep: Shows "✓ Grep <pattern>" with match count → expands to matches
 * - find: Shows "✓ Find <pattern>" with result count → expands to file list
 * - ls: Shows "✓ ls <path>" with entry count → expands to listing
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import {
  createReadTool,
  createEditTool,
  createWriteTool,
  createBashTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  type ReadToolDetails,
  type EditToolDetails,
  type BashToolDetails,
  type GrepToolDetails,
  type FindToolDetails,
  type LsToolDetails,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

// Helper to extract text content from result
function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

// Helper for collapsed hint
function hint(theme: Theme): string {
  return theme.fg("dim", " — Ctrl+O to expand");
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // Get original tool implementations
  const originalRead = createReadTool(cwd);
  const originalEdit = createEditTool(cwd);
  const originalWrite = createWriteTool(cwd);
  const originalBash = createBashTool(cwd);
  const originalGrep = createGrepTool(cwd);
  const originalFind = createFindTool(cwd);
  const originalLs = createLsTool(cwd);

  // ═══════════════════════════════════════════════════════════════════════════
  // READ
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    ...originalRead,
    name: "read",
    label: "Read",

    renderCall(args, theme: Theme) {
      let text = theme.fg("toolTitle", theme.bold("read "));
      text += theme.fg("muted", args.path || "");
      if (args.offset || args.limit) {
        const parts: string[] = [];
        if (args.offset) parts.push(`offset=${args.offset}`);
        if (args.limit) parts.push(`limit=${args.limit}`);
        text += theme.fg("dim", ` (${parts.join(", ")})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme: Theme) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Reading..."), 0, 0);
      }

      if (result.isError) {
        return new Text(theme.fg("error", `✗ ${getTextContent(result)}`), 0, 0);
      }

      if (!expanded) {
        const details = result.details as ReadToolDetails | undefined;
        let status = theme.fg("success", "✓ Read file");
        if (details?.truncation?.truncated) {
          status += theme.fg("warning", " (truncated)");
        }
        status += hint(theme);
        return new Text(status, 0, 0);
      }

      return new Text(getTextContent(result), 0, 0);
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // EDIT
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    ...originalEdit,
    name: "edit",
    label: "Edit",

    renderCall(args, theme: Theme) {
      let text = theme.fg("toolTitle", theme.bold("edit "));
      text += theme.fg("muted", args.path || "");
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme: Theme) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Editing..."), 0, 0);
      }

      if (result.isError) {
        return new Text(theme.fg("error", `✗ ${getTextContent(result)}`), 0, 0);
      }

      if (!expanded) {
        return new Text(theme.fg("success", "✓ Edit applied") + hint(theme), 0, 0);
      }

      const details = result.details as EditToolDetails | undefined;
      if (details?.diff) {
        const diffLines = details.diff.split("\n").map((line) => {
          if (line.startsWith("+") && !line.startsWith("+++")) {
            return theme.fg("toolDiffAdded", line);
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            return theme.fg("toolDiffRemoved", line);
          } else if (line.startsWith("@@")) {
            return theme.fg("accent", line);
          }
          return theme.fg("toolDiffContext", line);
        });
        return new Text(diffLines.join("\n"), 0, 0);
      }

      return new Text(getTextContent(result), 0, 0);
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // WRITE
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    ...originalWrite,
    name: "write",
    label: "Write",

    renderCall(args, theme: Theme) {
      let text = theme.fg("toolTitle", theme.bold("write "));
      text += theme.fg("muted", args.path || "");
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme: Theme) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Writing..."), 0, 0);
      }

      if (result.isError) {
        return new Text(theme.fg("error", `✗ ${getTextContent(result)}`), 0, 0);
      }

      if (!expanded) {
        return new Text(theme.fg("success", "✓ File written") + hint(theme), 0, 0);
      }

      return new Text(getTextContent(result), 0, 0);
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // BASH
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    ...originalBash,
    name: "bash",
    label: "Bash",

    renderCall(args, theme: Theme) {
      let text = theme.fg("toolTitle", theme.bold("bash "));
      // Truncate long commands
      const cmd = args.command || "";
      const maxLen = 60;
      text += theme.fg("muted", cmd.length > maxLen ? cmd.slice(0, maxLen) + "..." : cmd);
      if (args.timeout) {
        text += theme.fg("dim", ` (timeout=${args.timeout}s)`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme: Theme) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Running..."), 0, 0);
      }

      const details = result.details as BashToolDetails | undefined;
      const output = getTextContent(result);

      // Parse exit code from output (format: "[exit code: N]")
      const exitMatch = output.match(/\[exit code: (\d+)\]/);
      const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : null;

      if (result.isError || (exitCode !== null && exitCode !== 0)) {
        if (!expanded) {
          let status = theme.fg("error", `✗ Command failed`);
          if (exitCode !== null) {
            status += theme.fg("dim", ` (exit ${exitCode})`);
          }
          status += hint(theme);
          return new Text(status, 0, 0);
        }
        return new Text(theme.fg("error", output), 0, 0);
      }

      if (!expanded) {
        let status = theme.fg("success", "✓ Command succeeded");
        if (details?.truncation?.truncated) {
          status += theme.fg("warning", " (truncated)");
        }
        status += hint(theme);
        return new Text(status, 0, 0);
      }

      return new Text(output, 0, 0);
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GREP
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    ...originalGrep,
    name: "grep",
    label: "Grep",

    renderCall(args, theme: Theme) {
      let text = theme.fg("toolTitle", theme.bold("grep "));
      text += theme.fg("accent", `"${args.pattern || ""}"`);
      if (args.path) {
        text += theme.fg("muted", ` in ${args.path}`);
      }
      if (args.glob) {
        text += theme.fg("dim", ` (glob=${args.glob})`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme: Theme) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Searching..."), 0, 0);
      }

      if (result.isError) {
        return new Text(theme.fg("error", `✗ ${getTextContent(result)}`), 0, 0);
      }

      const details = result.details as GrepToolDetails | undefined;
      const output = getTextContent(result);

      // Count matches (lines that look like file:line:content)
      const lines = output.split("\n").filter((l) => l.trim());
      const matchCount = lines.filter((l) => /^[^:]+:\d+:/.test(l)).length;

      if (!expanded) {
        let status: string;
        if (matchCount === 0 && !output.includes(":")) {
          status = theme.fg("muted", "○ No matches found");
        } else {
          status = theme.fg("success", `✓ ${matchCount} match${matchCount !== 1 ? "es" : ""}`);
          if (details?.truncation?.truncated || details?.matchLimitReached) {
            status += theme.fg("warning", " (truncated)");
          }
        }
        status += hint(theme);
        return new Text(status, 0, 0);
      }

      // Color the output: highlight file paths and line numbers
      const coloredLines = output.split("\n").map((line) => {
        const match = line.match(/^([^:]+):(\d+):(.*)/);
        if (match) {
          return (
            theme.fg("muted", match[1]) +
            theme.fg("dim", ":") +
            theme.fg("accent", match[2]) +
            theme.fg("dim", ":") +
            match[3]
          );
        }
        return line;
      });
      return new Text(coloredLines.join("\n"), 0, 0);
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // FIND
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    ...originalFind,
    name: "find",
    label: "Find",

    renderCall(args, theme: Theme) {
      let text = theme.fg("toolTitle", theme.bold("find "));
      text += theme.fg("accent", `"${args.pattern || ""}"`);
      if (args.path) {
        text += theme.fg("muted", ` in ${args.path}`);
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme: Theme) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Finding..."), 0, 0);
      }

      if (result.isError) {
        return new Text(theme.fg("error", `✗ ${getTextContent(result)}`), 0, 0);
      }

      const details = result.details as FindToolDetails | undefined;
      const output = getTextContent(result);
      const files = output.split("\n").filter((l) => l.trim());

      if (!expanded) {
        let status: string;
        if (files.length === 0) {
          status = theme.fg("muted", "○ No files found");
        } else {
          status = theme.fg("success", `✓ ${files.length} file${files.length !== 1 ? "s" : ""}`);
          if (details?.truncation?.truncated || details?.resultLimitReached) {
            status += theme.fg("warning", " (truncated)");
          }
        }
        status += hint(theme);
        return new Text(status, 0, 0);
      }

      return new Text(theme.fg("muted", output), 0, 0);
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LS
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    ...originalLs,
    name: "ls",
    label: "ls",

    renderCall(args, theme: Theme) {
      let text = theme.fg("toolTitle", theme.bold("ls "));
      text += theme.fg("muted", args.path || ".");
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme: Theme) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Listing..."), 0, 0);
      }

      if (result.isError) {
        return new Text(theme.fg("error", `✗ ${getTextContent(result)}`), 0, 0);
      }

      const details = result.details as LsToolDetails | undefined;
      const output = getTextContent(result);
      const entries = output.split("\n").filter((l) => l.trim());

      if (!expanded) {
        let status = theme.fg("success", `✓ ${entries.length} entr${entries.length !== 1 ? "ies" : "y"}`);
        if (details?.truncation?.truncated || details?.entryLimitReached) {
          status += theme.fg("warning", " (truncated)");
        }
        status += hint(theme);
        return new Text(status, 0, 0);
      }

      // Color directories (end with /) differently
      const coloredLines = output.split("\n").map((line) => {
        if (line.endsWith("/")) {
          return theme.fg("accent", line);
        }
        return theme.fg("muted", line);
      });
      return new Text(coloredLines.join("\n"), 0, 0);
    },
  });
}
