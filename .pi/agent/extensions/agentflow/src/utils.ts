import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

export function truncateToolText(text: string): string {
  const truncated = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncated.truncated) return truncated.content;
  return `${truncated.content}\n\n[Output truncated to ${truncated.outputLines}/${truncated.totalLines} lines and ${truncated.outputBytes}/${truncated.totalBytes} bytes. Full result is preserved in tool details.]`;
}
