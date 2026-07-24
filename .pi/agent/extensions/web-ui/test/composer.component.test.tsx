// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/web/components/Composer.js";

afterEach(cleanup);

const metadata = {
  cwd: "/Users/example/project/with/a/long/path",
  isIdle: true,
  model: { provider: "pave", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
  thinkingLevel: "high",
  contextUsage: { tokens: 12000, contextWindow: 1000000, percent: 12 },
  activeTools: [],
  sessionCost: 1.2345,
};

describe("boxed composer", () => {
  it("shows session metadata and only an idle prompt mode", () => {
    render(
      <Composer
        metadata={metadata}
        sessionId="12345678-abcd"
        running={false}
        connected
        content="hello"
        mode="prompt"
        notice="Ready"
        onContent={vi.fn()}
        onMode={vi.fn()}
        onSend={vi.fn()}
        onAbort={vi.fn()}
      />,
    );
    expect(screen.getByText(/12,000 tok · 12%/)).toBeTruthy();
    expect(screen.getByText("$1.2345")).toBeTruthy();
    expect(screen.getByText(/pave\/GPT 5.6 Sol/)).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText("session 12345678")).toBeTruthy();
    expect(screen.getByText("Prompt")).toBeTruthy();
    expect(screen.queryByLabelText("Deliver as")).toBeNull();
    expect((screen.getByRole("button", { name: "Abort" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("offers explicit steer/follow-up choices while busy", () => {
    const onMode = vi.fn();
    const onAbort = vi.fn();
    const onSend = vi.fn();
    render(
      <Composer
        metadata={{ ...metadata, isIdle: false }}
        sessionId="12345678-abcd"
        running
        connected
        content="next"
        mode="steer"
        notice="Working"
        onContent={vi.fn()}
        onMode={onMode}
        onSend={onSend}
        onAbort={onAbort}
      />,
    );
    const select = screen.getByLabelText("Deliver as") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["steer", "follow_up"]);
    fireEvent.change(select, { target: { value: "follow_up" } });
    expect(onMode).toHaveBeenCalledWith("follow_up");
    fireEvent.click(screen.getByRole("button", { name: "Abort" }));
    expect(onAbort).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledOnce();
  });
});
