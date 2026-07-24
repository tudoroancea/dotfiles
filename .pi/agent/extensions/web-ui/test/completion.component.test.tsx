// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../src/web/components/Composer.js";

function Harness({
  request,
}: {
  request: (kind: "slash" | "mention", query: string) => Promise<any[]>;
}) {
  const [content, setContent] = useState("");
  return (
    <Composer
      running={false}
      connected
      content={content}
      mode="prompt"
      notice="Ready"
      onContent={setContent}
      onMode={vi.fn()}
      onSend={vi.fn()}
      onAbort={vi.fn()}
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
