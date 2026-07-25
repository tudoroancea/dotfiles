// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/web/components/Composer.js";

function Harness({
  request,
  running = false,
  onSend = vi.fn(),
  onAbort = vi.fn(),
}: {
  request: (kind: "slash" | "mention", query: string) => Promise<any[]>;
  running?: boolean;
  onSend?: (delivery?: "steer" | "follow_up") => void;
  onAbort?: () => void;
}) {
  const [content, setContent] = useState("");
  return (
    <Composer
      running={running}
      connected
      content={content}
      notice="Ready"
      onContent={setContent}
      onSend={onSend}
      onAbort={onAbort}
      requestCompletion={request}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("composer completion popover", () => {
  it("debounces, exposes a listbox, and supports keyboard replacement", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => [
      { value: "/copy-remote-url", label: "/copy-remote-url", description: "Copy Remote URL" },
      { value: "/compact", label: "/compact" },
    ]);
    render(<Harness request={request} />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "/co", selectionStart: 3 } });
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120);
    expect(await screen.findByRole("listbox")).toBeTruthy();
    expect(textarea.getAttribute("aria-activedescendant")).toBe("completion-0");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.getAttribute("aria-activedescendant")).toBe("completion-1");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("/compact");
  });

  it("gives modified submission and abort shortcuts precedence over an open completion", async () => {
    vi.useFakeTimers();
    const onSend = vi.fn();
    const onAbort = vi.fn();
    render(
      <Harness
        running
        onSend={onSend}
        onAbort={onAbort}
        request={async () => [{ value: "/compact", label: "/compact" }]}
      />,
    );
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "/co", selectionStart: 3 } });
    await vi.advanceTimersByTimeAsync(120);
    expect(await screen.findByRole("listbox")).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter", altKey: true });
    expect(onSend).toHaveBeenLastCalledWith();
    expect(textarea.value).toBe("/co");
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(onSend).toHaveBeenLastCalledWith("follow_up");
    fireEvent.keyDown(textarea, { key: "≥", code: "Period", altKey: true });
    expect(onAbort).toHaveBeenCalledOnce();
  });

  it("clears stale candidates immediately when the target changes", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (_kind: string, query: string) => [
      { value: `${query}-result`, label: `${query}-result` },
    ]);
    render(<Harness request={request} />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "@foo", selectionStart: 4 } });
    await vi.advanceTimersByTimeAsync(120);
    expect(await screen.findByRole("listbox")).toBeTruthy();
    fireEvent.input(textarea, { target: { value: "@bar", selectionStart: 4 } });
    expect(screen.queryByRole("listbox")).toBeNull();
    await vi.advanceTimersByTimeAsync(120);
    expect((await screen.findByRole("option")).textContent).toContain("@bar-result");
  });

  it("supports touch selection and escape dismissal", async () => {
    vi.useFakeTimers();
    render(<Harness request={async () => [{ value: '@"foo bar.ts"', label: "foo bar.ts" }]} />);
    const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: "read @foo", selectionStart: 9 } });
    await vi.advanceTimersByTimeAsync(120);
    const option = await screen.findByRole("option");
    fireEvent.pointerDown(option, { pointerType: "touch" });
    expect(textarea.value).toBe("read @foo");
    fireEvent.click(option);
    expect(textarea.value).toBe('read @"foo bar.ts"');

    fireEvent.input(textarea, { target: { value: "/x", selectionStart: 2 } });
    await vi.advanceTimersByTimeAsync(120);
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
