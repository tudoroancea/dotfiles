// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/web/components/Composer.js";

afterEach(cleanup);

const metadata = {
  cwd: "/Users/example/project/with/a/long/path",
  home: "/Users/example",
  isIdle: true,
  model: { provider: "pave", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
  thinkingLevel: "high",
  contextUsage: { tokens: 12000, contextWindow: 1000000, percent: 12 },
  activeTools: [],
  sessionCost: 1.2345,
};

describe("boxed composer", () => {
  it("shows compact metadata, a home-relative cwd, and no delivery mode chrome when idle", () => {
    render(
      <Composer
        metadata={metadata}
        sessionId="12345678-abcd"
        running={false}
        connected
        content="hello"
        notice="Ready"
        onContent={vi.fn()}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        requestCompletion={async () => []}
      />,
    );
    // Context is shown as a percentage only, never a raw token count.
    expect(screen.getByText("12% context")).toBeTruthy();
    expect(screen.queryByText(/tok/)).toBeNull();
    // Cost is rounded up to whole cents.
    expect(screen.getByText("$1.24")).toBeTruthy();
    expect(screen.getByText(/pave\/GPT 5.6 Sol/)).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText("session 12345678")).toBeTruthy();
    // Home directory renders as ~.
    expect(screen.getByText("~/project/with/a/long/path")).toBeTruthy();
    // No "Prompt" label, no delivery-mode select while idle.
    expect(screen.queryByText("Prompt")).toBeNull();
    expect(screen.queryByLabelText("Deliver as")).toBeNull();
    // Idle offers a single Send action and no stop control.
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("rounds a fraction of a cent up so it is still visible", () => {
    render(
      <Composer
        metadata={{ ...metadata, sessionCost: 0.0001 }}
        running={false}
        connected
        content=""
        notice="Ready"
        onContent={vi.fn()}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        requestCompletion={async () => []}
      />,
    );
    expect(screen.getByText("$0.01")).toBeTruthy();
  });

  it("does not advance a cost already on an exact cent boundary", () => {
    render(
      <Composer
        metadata={{ ...metadata, sessionCost: 0.07 }}
        running={false}
        connected
        content=""
        notice="Ready"
        onContent={vi.fn()}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        requestCompletion={async () => []}
      />,
    );
    expect(screen.getByText("$0.07")).toBeTruthy();
  });

  it("reveals the keyboard-shortcut overlay on demand", () => {
    render(
      <Composer
        metadata={metadata}
        running={false}
        connected
        content=""
        notice="Ready"
        onContent={vi.fn()}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        requestCompletion={async () => []}
      />,
    );
    const toggle = screen.getByRole("button", { name: /Shortcuts/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("New line")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("New line")).toBeTruthy();
  });

  it("keeps steer and queue touch-accessible and reveals stop while Option is held", () => {
    const onAbort = vi.fn();
    const onSend = vi.fn();
    render(
      <Composer
        metadata={{ ...metadata, isIdle: false }}
        sessionId="12345678-abcd"
        running
        connected
        content="next"
        notice="Working"
        onContent={vi.fn()}
        onSend={onSend}
        onAbort={onAbort}
        requestCompletion={async () => []}
      />,
    );
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    expect(onSend).toHaveBeenLastCalledWith();
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));
    expect(onSend).toHaveBeenLastCalledWith("follow_up");

    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: "Alt", altKey: true });
    expect(screen.queryByRole("button", { name: "Steer" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onAbort).toHaveBeenCalledOnce();
    fireEvent.keyUp(textarea, { key: "Alt", altKey: false });
    expect(screen.getByRole("button", { name: "Steer" })).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(textarea, { key: "Enter", altKey: true });
    expect(onSend).toHaveBeenLastCalledWith();
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(onSend).toHaveBeenLastCalledWith("follow_up");
    fireEvent.keyDown(textarea, { key: "≥", code: "Period", altKey: true });
    expect(onAbort).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch keyboard actions while disconnected", () => {
    const onAbort = vi.fn();
    const onSend = vi.fn();
    render(
      <Composer
        running
        connected={false}
        content="next"
        notice="Reconnecting"
        onContent={vi.fn()}
        onSend={onSend}
        onAbort={onAbort}
        requestCompletion={async () => []}
      />,
    );
    const textarea = screen.getByLabelText("Message");
    fireEvent.keyDown(textarea, { key: "Enter", altKey: true });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(textarea, { key: ".", code: "Period", altKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(onAbort).not.toHaveBeenCalled();
  });
});
