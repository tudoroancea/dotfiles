/**
 * Minimalist Tool Rendering Extension
 *
 * Overrides the rendering of built-in tools (read, write, edit, bash) with a cleaner,
 * more minimalist appearance:
 * - Shows only the filename (not full content)
 * - Hides file content/diff/output by default
 * - Content is revealed only when expanded with Ctrl+O
 * - For bash: shows only the command, not the output
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  type ReadToolDetails,
  type EditToolDetails,
  type BashToolDetails,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Shorten path by replacing home directory with ~
 */
function shortenPath(filePath: string): string {
  const home = os.homedir();
  if (filePath.startsWith(home)) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

/**
 * Get just the filename from a path
 */
function getFilename(filePath: string): string {
  return path.basename(filePath);
}

/**
 * Format line range display for read tool
 */
function formatLineRange(offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) return "";
  const startLine = offset ?? 1;
  const endLine = limit !== undefined ? startLine + limit - 1 : "";
  return `:${startLine}${endLine ? `-${endLine}` : ""}`;
}

/**
 * Count lines in text
 */
function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // Create the original tools to delegate execution to
  const originalReadTool = createReadTool(cwd);
  const originalWriteTool = createWriteTool(cwd);
  const originalEditTool = createEditTool(cwd);
  const originalBashTool = createBashTool(cwd);

  // ============================================================================
  // READ TOOL
  // ============================================================================
  pi.registerTool({
    name: "read",
    label: "Read",
    description: originalReadTool.description,
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
      offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
    }),

    async execute(toolCallId, params, onUpdate, ctx, signal) {
      return originalReadTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme: Theme) {
      const filePath = args.path || "";
      const lineRange = formatLineRange(args.offset, args.limit);
      const display = shortenPath(filePath) + (lineRange ? theme.fg("dim", lineRange) : "");

      return new Text(
        theme.fg("toolTitle", theme.bold("read ")) + theme.fg("accent", display),
        0,
        0
      );
    },

    renderResult(result: AgentToolResult<ReadToolDetails>, { expanded }, theme: Theme) {
      const textContent = result.content?.find((c) => c.type === "text");
      const text = textContent?.type === "text" ? textContent.text : "";
      const lines = countLines(text);
      const truncated = result.details?.truncation?.truncated;

      if (result.isError) {
        return new Text(theme.fg("error", text || "Error reading file"), 0, 0);
      }

      let output = theme.fg("success", "✓ ") + theme.fg("dim", `${lines} lines`);
      if (truncated) {
        output += theme.fg("warning", " (truncated)");
      }

      if (expanded && text) {
        output += "\n" + theme.fg("muted", text);
      }

      return new Text(output, 0, 0);
    },
  });

  // ============================================================================
  // WRITE TOOL
  // ============================================================================
  pi.registerTool({
    name: "write",
    label: "Write",
    description: originalWriteTool.description,
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
      content: Type.String({ description: "Content to write to the file" }),
    }),

    async execute(toolCallId, params, onUpdate, ctx, signal) {
      return originalWriteTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme: Theme) {
      const filePath = args.path || "";
      const lines = countLines(args.content || "");

      return new Text(
        theme.fg("toolTitle", theme.bold("write ")) +
          theme.fg("accent", shortenPath(filePath)) +
          theme.fg("dim", ` (${lines} lines)`),
        0,
        0
      );
    },

    renderResult(result: AgentToolResult<undefined>, { expanded }, theme: Theme) {
      const textContent = result.content?.find((c) => c.type === "text");
      const text = textContent?.type === "text" ? textContent.text : "";

      if (result.isError) {
        return new Text(theme.fg("error", text || "Error writing file"), 0, 0);
      }

      let output = theme.fg("success", "✓ ") + theme.fg("dim", "written");

      return new Text(output, 0, 0);
    },
  });

  // ============================================================================
  // EDIT TOOL
  // ============================================================================
  pi.registerTool({
    name: "edit",
    label: "Edit",
    description: originalEditTool.description,
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
      oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
      newText: Type.String({ description: "New text to replace the old text with" }),
    }),

    async execute(toolCallId, params, onUpdate, ctx, signal) {
      return originalEditTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme: Theme) {
      const filePath = args.path || "";
      const oldLines = countLines(args.oldText || "");
      const newLines = countLines(args.newText || "");

      let lineInfo = "";
      if (oldLines !== newLines) {
        lineInfo = ` (${oldLines}→${newLines} lines)`;
      } else {
        lineInfo = ` (${oldLines} lines)`;
      }

      return new Text(
        theme.fg("toolTitle", theme.bold("edit ")) +
          theme.fg("accent", shortenPath(filePath)) +
          theme.fg("dim", lineInfo),
        0,
        0
      );
    },

    renderResult(result: AgentToolResult<EditToolDetails>, { expanded }, theme: Theme) {
      const textContent = result.content?.find((c) => c.type === "text");
      const text = textContent?.type === "text" ? textContent.text : "";

      if (result.isError) {
        return new Text(theme.fg("error", text || "Error editing file"), 0, 0);
      }

      const firstLine = result.details?.firstChangedLine;
      let output = theme.fg("success", "✓ ") + theme.fg("dim", "edited");
      if (firstLine) {
        output += theme.fg("dim", ` at line ${firstLine}`);
      }

      if (expanded && result.details?.diff) {
        // Simple diff display with colors
        const diffLines = result.details.diff.split("\n").map((line) => {
          if (line.startsWith("+") && !line.startsWith("+++")) {
            return theme.fg("toolDiffAdded", line);
          } else if (line.startsWith("-") && !line.startsWith("---")) {
            return theme.fg("toolDiffRemoved", line);
          } else if (line.startsWith("@@")) {
            return theme.fg("accent", line);
          }
          return theme.fg("muted", line);
        });
        output += "\n" + diffLines.join("\n");
      }

      return new Text(output, 0, 0);
    },
  });

  // ============================================================================
  // BASH TOOL
  // ============================================================================
  pi.registerTool({
    name: "bash",
    label: "Bash",
    description: originalBashTool.description,
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
    }),

    async execute(toolCallId, params, onUpdate, ctx, signal) {
      return originalBashTool.execute(toolCallId, params, signal, onUpdate);
    },

    renderCall(args, theme: Theme) {
      const command = args.command || "";
      // Truncate long commands
      const maxLen = 60;
      const displayCmd = command.length > maxLen ? command.slice(0, maxLen) + "…" : command;

      return new Text(
        theme.fg("toolTitle", theme.bold("$ ")) + theme.fg("muted", displayCmd),
        0,
        0
      );
    },

    renderResult(result: AgentToolResult<BashToolDetails>, { expanded }, theme: Theme) {
      const textContent = result.content?.find((c) => c.type === "text");
      const text = textContent?.type === "text" ? textContent.text : "";
      const lines = countLines(text.trim());
      const truncated = result.details?.truncation?.truncated;

      if (result.isError) {
        const errorPreview = text.split("\n")[0] || "Command failed";
        let output = theme.fg("error", "✗ ") + theme.fg("error", errorPreview);
        if (expanded && text) {
          output = theme.fg("error", "✗ Error:\n") + theme.fg("muted", text);
        }
        return new Text(output, 0, 0);
      }

      let output = theme.fg("success", "✓ ");
      if (lines > 0) {
        output += theme.fg("dim", `${lines} lines`);
      } else {
        output += theme.fg("dim", "done");
      }
      if (truncated) {
        output += theme.fg("warning", " (truncated)");
      }

      if (expanded && text.trim()) {
        output += "\n" + theme.fg("muted", text.trim());
      }

      return new Text(output, 0, 0);
    },
  });
}
