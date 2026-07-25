// Untrusted-content helpers: strip ANSI/control sequences, bound length, and
// derive the small summary facts (line counts, diff stats) the tool renderers
// need. Everything here treats its input as hostile.

const ESC = "\\u001b";

// CSI/OSC/DCS/single escape sequences. Kept deliberately broad so a stray
// escape introducer never survives into the DOM as styling or a terminal
// command. Built from string parts to avoid literal control characters.
const ANSI_PATTERN = new RegExp(
  `${ESC}\\[[0-9;:?]*[ -/]*[@-~]` + // CSI (colors, cursor)
    `|${ESC}\\][^\\u0007]*(?:\\u0007|${ESC}\\\\)` + // OSC
    `|${ESC}[PX^_][^]*?${ESC}\\\\` + // DCS/PM/APC/SOS
    `|${ESC}[@-Z\\\\-_]`, // single-character escapes
  "g",
);

// C0/C1 control characters, keeping tab and newline for layout.
const CONTROL_PATTERN = new RegExp(
  "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f]",
  "g",
);

/** Remove ANSI escape sequences and control characters from untrusted text. */
export function sanitizeText(value: string): string {
  return value.replace(ANSI_PATTERN, "").replace(/\r\n?/g, "\n").replace(CONTROL_PATTERN, "");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Extract the joined text of an untrusted content-block array. */
export function textFromContent(content: unknown): string {
  if (typeof content === "string") return sanitizeText(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (block && typeof block === "object") {
      const record = block as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
    }
  }
  return sanitizeText(parts.join("\n"));
}

/** Line count matching the local compact renderers' semantics. */
export function lineCount(text: string): number {
  if (!text || text === "(no output)") return 0;
  return text.split("\n").length;
}

export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Collapse a shell command to a single line, matching compact-builtin-tools. */
export function compactCommand(command: unknown): string {
  if (typeof command !== "string" || !command) return "…";
  const oneLine = sanitizeText(command).replace(/\s*\n\s*/g, " ↵ ");
  return oneLine.length > 100 ? `${oneLine.slice(0, 97)}...` : oneLine;
}

export function diffStats(diff: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
  }
  return { additions, removals };
}

const TRUNCATION_SUFFIX = "\n…[truncated]";
const MAX_TEXT_CHARS = 20_000;
const MAX_TEXT_LINES = 400;

/** Bound displayed text by both characters and lines. */
export function truncateText(value: string, maxChars = MAX_TEXT_CHARS, maxLines = MAX_TEXT_LINES) {
  let text = value;
  let truncated = false;
  const lines = text.split("\n");
  if (lines.length > maxLines) {
    text = lines.slice(0, maxLines).join("\n");
    truncated = true;
  }
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return { text: truncated ? `${text}${TRUNCATION_SUFFIX}` : text, truncated };
}

export function formatDuration(ms: unknown): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

export function formatBytes(bytes: unknown): string | undefined {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

/** Shorten a filesystem path for a compact label, keeping the tail meaningful. */
export function shortenPath(value: string, maxLength = 48): string {
  const clean = sanitizeText(value);
  if (clean.length <= maxLength) return clean;
  return `…${clean.slice(clean.length - maxLength + 1)}`;
}

/** Replace a leading home directory with `~`, as the TUI and shells display it. */
export function withHome(path: string, home: string | undefined): string {
  const clean = sanitizeText(path);
  if (!home) return clean;
  const base = sanitizeText(home).replace(/\/+$/, "");
  if (!base) return clean;
  if (clean === base) return "~";
  if (clean.startsWith(`${base}/`)) return `~${clean.slice(base.length)}`;
  return clean;
}
