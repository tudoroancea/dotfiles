import { describe, expect, it } from "vitest";
import { formatCommand, formatCwd, formatDuration, formatStatus } from "../src/ui/formatters.ts";

describe("background process UI formatters", () => {
  it("shortens home cwd and sanitizes and bounds commands", () => {
    expect(formatCwd("/home/test/project", "/home/test")).toBe("~/project");
    expect(formatCommand("printf '\u001b[31munsafe\u0007'\nnext", { singleLine: true })).toBe(
      "printf ' unsafe ' next",
    );
    expect(formatCommand("x".repeat(20), { maximum: 10 })).toBe("xxxxxxxxx…");
  });

  it("uses shared duration and status vocabulary", () => {
    expect(formatDuration(-1)).toBe("0ms");
    expect(formatDuration(999.5)).toBe("1.0s");
    expect(formatDuration(1_250)).toBe("1.3s");
    expect(formatDuration(59_950)).toBe("1m 0s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_662_000)).toBe("1h 1m");
    expect(formatDuration(90_000_000)).toBe("1d 1h");
    expect(formatStatus("running")).toMatchObject({ icon: "◆", tone: "warning" });
    expect(formatStatus("cancelled")).toMatchObject({ icon: "◇", tone: "muted" });
    expect(formatStatus("failed")).toMatchObject({ icon: "✗", tone: "error" });
  });
});
