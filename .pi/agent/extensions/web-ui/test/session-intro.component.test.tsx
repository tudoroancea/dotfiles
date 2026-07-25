// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionMetadata } from "../src/shared/wire.js";
import { SessionIntro } from "../src/web/components/SessionIntro.js";

afterEach(cleanup);

const metadata: SessionMetadata = {
  cwd: "/Users/example/proj",
  home: "/Users/example",
  isIdle: true,
  piVersion: "0.82.0",
  model: { provider: "pave", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
  thinkingLevel: "high",
  contextUsage: { tokens: 1000, contextWindow: 1_000_000, percent: 1 },
  activeTools: [],
};

describe("session intro", () => {
  it("renders an in-flow TUI-style banner with version, model, home cwd, and session", () => {
    render(<SessionIntro metadata={metadata} sessionId="12345678-abcd" />);
    expect(screen.getByText("pi v0.82.0")).toBeTruthy();
    expect(screen.getByText("gpt-5.6-sol")).toBeTruthy();
    expect(screen.getByText("~/proj")).toBeTruthy();
    expect(screen.getByText("high thinking · 1M context")).toBeTruthy();
    expect(screen.getByText("session 12345678")).toBeTruthy();
  });
});
