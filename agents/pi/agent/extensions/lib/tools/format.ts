// Text helpers shared by every TUI tool renderer.

/** Home-relative path display. */
export function shortenPath(value: unknown): string {
  if (typeof value !== "string") return "";
  for (const prefix of ["/Users/", "/home/"]) {
    if (value.startsWith(prefix)) {
      const parts = value.split("/");
      if (parts.length > 2) return `~${value.slice((prefix + parts[2]).length)}`;
    }
  }
  return value;
}

export function truncate(value: unknown, max = 80): string {
  if (typeof value !== "string") return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** A shell command on one line: newlines become `↵`, and long commands are cut. */
export function compactCommand(value: unknown): string {
  if (typeof value !== "string" || !value) return "...";
  const single = value.replace(/\s*\n\s*/g, " ↵ ");
  return single.length > 100 ? `${single.slice(0, 97)}...` : single;
}

export function pluralize(count: number, noun: string): string {
  if (count === 1) return `${count.toLocaleString()} ${noun}`;
  // A consonant before a final "y" takes "-ies" ("entry", "query"); a vowel keeps the
  // plain "-s" ("day", "key").
  const plural = /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
  return `${count.toLocaleString()} ${plural}`;
}

/** `N nouns`, or an explicit empty statement so a collapsed box is never blank. */
export function counted(count: number, noun: string): string {
  if (count) return pluralize(count, noun);
  return `no ${/[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`}`;
}

export function formatDuration(milliseconds: number | undefined): string {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) return "";
  const elapsed = Math.max(0, milliseconds);
  const roundedMilliseconds = Math.round(elapsed);
  if (roundedMilliseconds < 1_000) return `${roundedMilliseconds}ms`;

  const tenths = Math.round(elapsed / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;

  const seconds = Math.round(elapsed / 1_000);
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const hours = Math.floor(minutes / 60);
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatBytes(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

export function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

export function statusIcon(status: unknown): string {
  // Not "·": these lines are separated by "·", so a queued run would open with what reads
  // as a leading separator.
  if (status === "queued") return "◌";
  if (status === "running") return "◆";
  if (status === "completed") return "✓";
  if (status === "failed") return "✗";
  return "◇";
}

/**
 * The text a listing or search tool returns, split into content lines and the bracketed
 * notice those tools append (`…\n\n[500 entries limit reached. …]`).
 *
 * Counting raw lines would fold that notice, its blank separator and the empty-result
 * sentinels into the total, which is why a collapsed summary and its own expanded content
 * could disagree. The notice is actionable rather than content, so it is surfaced
 * separately and never counted.
 *
 * Formats verified against `pi-coding-agent/dist/core/tools/{ls,grep,find}.js` and
 * `@ff-labs/pi-fff/src/index.ts`; the browser's `listResult` parses exactly the same shapes.
 */
export function listResult(text: string): { lines: readonly string[]; notice: string } {
  const { body, notice } = splitNotice(text);
  const empty =
    !body ||
    body === "(empty directory)" ||
    body === "(no output)" ||
    body === "No matches found" ||
    body === "No files found matching pattern";
  return {
    lines: empty ? [] : body.split("\n").filter((line) => line.trim() !== ""),
    notice,
  };
}

/**
 * The bracketed notice a tool appends, split from the content it describes. Every built-in
 * that can truncate does this — `read` adds `[500 more lines in file. …]`, `bash` adds
 * `[Showing lines X-Y of N. …]`, the listing tools add their limit notices — so counting the
 * raw text would report two lines more than the tool actually returned.
 *
 * Confined to a single line, because every notice either surface can emit is one: Pi builds them
 * with `notices.join(". ")` and so does fff. A multi-line match would instead swallow content
 * whenever a blank-line-separated block starts with `[` and the text ends in `]` — which
 * `ffgrep` output does in a repository with a route directory named `[id]`.
 */
export function splitNotice(text: string): { body: string; notice: string } {
  const trimmed = text.trimEnd();
  const match = /\n\n\[([^\n]*)\]$/.exec(trimmed);
  return {
    body: match ? trimmed.slice(0, match.index) : trimmed,
    notice: match ? match[1]! : "",
  };
}

/**
 * Lines of content in a result, ignoring the appended notice and treating a tool's explicit
 * "(no output)" as none. Blank lines count: for `bash` and `read` they are content.
 */
export function lineCount(text: string): number {
  const { body } = splitNotice(text);
  if (!body || body === "(no output)") return 0;
  return body.split("\n").length;
}

/**
 * Strip control sequences from untrusted text before it reaches the terminal: a raw escape
 * sequence in a tool result would otherwise repaint the screen. Newlines and tabs survive;
 * every other control character becomes a space.
 */
export function sanitizeRenderedValue(value: string): string {
  let safe = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1b || code === 0x9b || code === 0x9d) {
      const introducer = code === 0x1b ? value[index + 1] : code === 0x9b ? "[" : "]";
      if (code === 0x1b && (introducer === "[" || introducer === "]")) index += 1;
      if (introducer === "[") {
        while (index + 1 < value.length) {
          const next = value.charCodeAt(++index);
          if (next >= 0x40 && next <= 0x7e) break;
        }
      } else if (introducer === "]") {
        while (index + 1 < value.length) {
          const next = value.charCodeAt(++index);
          if (next === 0x07 || next === 0x9c) break;
          if (next === 0x1b && value[index + 1] === "\\") {
            index += 1;
            break;
          }
        }
      }
      continue;
    }
    safe += code === 0x0a || code === 0x09 || code >= 0x20 ? value[index] : " ";
  }
  return safe;
}
