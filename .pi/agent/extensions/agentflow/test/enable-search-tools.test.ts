import { describe, expect, it, vi } from "vitest";
import enableSearchTools from "../src/enable-search-tools.ts";

describe("default search tools extension", () => {
  it("adds grep and find without enabling ls", () => {
    let start: (() => void) | undefined;
    const setActiveTools = vi.fn();
    enableSearchTools({
      on(event: string, handler: () => void) {
        if (event === "session_start") start = handler;
      },
      getActiveTools: () => ["read", "bash", "edit", "write"],
      setActiveTools,
    } as never);
    start?.();
    expect(setActiveTools).toHaveBeenCalledWith(["read", "bash", "edit", "write", "grep", "find"]);
    expect(setActiveTools.mock.calls[0][0]).not.toContain("ls");
  });
});
