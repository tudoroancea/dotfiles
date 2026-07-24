import {
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function lineCount(text: string): number {
  if (!text || text === "(no output)") return 0;
  return text.split("\n").length;
}

function compactCommand(command: unknown): string {
  if (typeof command !== "string" || !command) return "...";
  const oneLine = command.replace(/\s*\n\s*/g, " ↵ ");
  return oneLine.length > 100 ? `${oneLine.slice(0, 97)}...` : oneLine;
}

function diffStats(diff: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }

  return { additions, removals };
}

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const bash = createBashToolDefinition(cwd);
  const edit = createEditToolDefinition(cwd);
  const write = createWriteToolDefinition(cwd);

  pi.registerTool({
    ...bash,
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("$ "));
      text += theme.fg("accent", compactCommand(args.command));
      if (args.timeout) text += theme.fg("dim", ` (${args.timeout}s timeout)`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial && !expanded) return new Container();

      const output = textContent(result);
      if (expanded) {
        return new Text(output ? theme.fg("toolOutput", `\n${output}`) : "", 0, 0);
      }

      const count = lineCount(output);
      const summary = count === 0 ? "no output" : `${count} output line${count === 1 ? "" : "s"}`;
      return new Text(
        theme.fg(
          context.isError ? "error" : "dim",
          context.isError ? `failed · ${summary}` : summary,
        ),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    ...edit,
    renderShell: "default",
    renderCall(args, theme) {
      const count = Array.isArray(args.edits) ? args.edits.length : 0;
      let text = theme.fg("toolTitle", theme.bold("edit "));
      text += theme.fg("accent", args.path || "...");
      if (count > 0) text += theme.fg("dim", ` · ${count} replacement${count === 1 ? "" : "s"}`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) return new Container();

      const output = textContent(result);
      const diff = result.details?.diff;
      if (context.isError || !diff) {
        const message = expanded ? output : output.split("\n")[0];
        return new Text(
          theme.fg(context.isError ? "error" : "success", message || "applied"),
          0,
          0,
        );
      }

      const { additions, removals } = diffStats(diff);
      let text = theme.fg("success", `+${additions}`);
      text += theme.fg("dim", " / ");
      text += theme.fg("error", `-${removals}`);

      if (expanded) {
        for (const line of diff.split("\n")) {
          const color = line.startsWith("+")
            ? "toolDiffAdded"
            : line.startsWith("-")
              ? "toolDiffRemoved"
              : "toolDiffContext";
          text += `\n${theme.fg(color, line)}`;
        }
      }

      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    ...write,
    renderCall(args, theme, context) {
      const content = typeof args.content === "string" ? args.content : "";
      const count = lineCount(content);
      let text = theme.fg("toolTitle", theme.bold("write "));
      text += theme.fg("accent", args.path || "...");
      if (content) text += theme.fg("dim", ` · ${count} line${count === 1 ? "" : "s"}`);
      if (context.expanded && content) text += `\n\n${theme.fg("toolOutput", content)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial || !context.isError) return new Container();
      const output = textContent(result);
      return new Text(theme.fg("error", expanded ? output : output.split("\n")[0]), 0, 0);
    },
  });
}
