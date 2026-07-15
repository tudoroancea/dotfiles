import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function enableSearchTools(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    pi.setActiveTools([...new Set([...pi.getActiveTools(), "grep", "find"])]);
  });
}
