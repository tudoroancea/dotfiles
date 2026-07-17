import { homedir } from "node:os";

const ELLIPSIS = "…";

export type StatusTone = "success" | "warning" | "error" | "muted";

export interface FormattedStatus {
  icon: "✓" | "✗" | "◆" | "◇";
  label: string;
  tone: StatusTone;
}

export function sanitizeRenderedValue(value: string): string {
  let safe = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isEscape = code === 0x1b;
    const isCsi = code === 0x9b;
    const isOsc = code === 0x9d;
    if (isEscape || isCsi || isOsc) {
      const introducer = isEscape ? value[index + 1] : isCsi ? "[" : "]";
      if (isEscape && (introducer === "[" || introducer === "]")) index += 1;
      if (introducer === "[") {
        while (index + 1 < value.length) {
          const next = value.charCodeAt(index + 1);
          index += 1;
          if (next >= 0x40 && next <= 0x7e) break;
        }
      } else if (introducer === "]") {
        while (index + 1 < value.length) {
          const next = value.charCodeAt(index + 1);
          index += 1;
          if (next === 0x07 || next === 0x9c) break;
          if (next === 0x1b && value[index + 1] === "\\") {
            index += 1;
            break;
          }
        }
      }
      safe += " ";
      continue;
    }
    safe +=
      code === 0x0a ? "\n" : code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : value[index];
  }
  return safe;
}

export function boundText(value: string, maximum: number, fromEnd = false): string {
  if (value.length <= maximum) return value;
  if (maximum <= ELLIPSIS.length) return ELLIPSIS.slice(0, maximum);
  return fromEnd
    ? `${ELLIPSIS}${value.slice(-(maximum - ELLIPSIS.length))}`
    : `${value.slice(0, maximum - ELLIPSIS.length)}${ELLIPSIS}`;
}

export function formatCommand(
  command: string,
  options: { maximum?: number; singleLine?: boolean } = {},
): string {
  const safe = sanitizeRenderedValue(command).trim();
  const normalized = options.singleLine ? safe.replace(/\s+/g, " ") : safe;
  return boundText(normalized || "(command unavailable)", options.maximum ?? 4_000);
}

export function formatCwd(cwd: string | undefined, home = homedir(), maximum = 240): string {
  let safe = sanitizeRenderedValue(cwd ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedHome = home.replace(/\/+$/, "");
  if (normalizedHome && (safe === normalizedHome || safe.startsWith(`${normalizedHome}/`))) {
    safe = `~${safe.slice(normalizedHome.length)}`;
  }
  return boundText(safe || "(cwd unavailable)", maximum, true);
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(milliseconds) ? milliseconds / 1_000 : 0));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatStatus(status: string): FormattedStatus {
  if (status === "completed") return { icon: "✓", label: status, tone: "success" };
  if (status === "failed" || status === "cleanup_failed") {
    return { icon: "✗", label: status.replaceAll("_", " "), tone: "error" };
  }
  if (status === "running") return { icon: "◆", label: status, tone: "warning" };
  return { icon: "◇", label: status.replaceAll("_", " "), tone: "muted" };
}
