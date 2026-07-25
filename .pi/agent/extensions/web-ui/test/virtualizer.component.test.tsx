// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/preact";
import type { Virtualizer } from "@tanstack/virtual-core";
import { useRef } from "preact/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVirtualizer } from "../src/web/use-virtualizer.js";

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];
  readonly targets = new Set<Element>();
  callbackCalls = 0;
  readonly observe = vi.fn((target: Element) => this.targets.add(target));
  readonly unobserve = vi.fn((target: Element) => this.targets.delete(target));
  readonly disconnect = vi.fn(() => this.targets.clear());

  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this);
  }

  trigger(target: Element, width: number, height: number): void {
    this.callbackCalls += 1;
    this.callback(
      [
        {
          target,
          borderBoxSize: [{ inlineSize: width, blockSize: height }],
        } as unknown as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
}

let current: Virtualizer<HTMLDivElement, HTMLDivElement> | undefined;

interface FixtureProps {
  count: number;
  estimate?: number;
  onChange?: () => void;
  onRender?: () => void;
}

function Fixture({ count, estimate = 40, onChange, onRender }: FixtureProps) {
  onRender?.();
  const scroll = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count,
    getScrollElement: () => scroll.current,
    estimateSize: () => estimate,
    overscan: 8,
    ...(onChange ? { onChange } : {}),
  });
  current = virtualizer;
  const firstSize = virtualizer.getVirtualItems().find((item) => item.index === 0)?.size;
  return (
    <div ref={scroll} data-testid="viewport" style="height: 200px; overflow: auto">
      <output data-testid="first-size">{firstSize ?? "missing"}</output>
      <div data-index="0" data-testid="row-0" ref={virtualizer.measureElement} />
    </div>
  );
}

beforeEach(() => {
  ResizeObserverMock.instances = [];
  window.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  current = undefined;
  vi.restoreAllMocks();
});

function observerFor(target: Element): ResizeObserverMock {
  const observer = ResizeObserverMock.instances.find((candidate) => candidate.targets.has(target));
  expect(observer, "target should have an active ResizeObserver").toBeDefined();
  return observer!;
}

describe("Preact virtualizer adapter", () => {
  it("updates core options without replacing the virtualizer", () => {
    const rendered = render(<Fixture count={2} />);
    const first = current;
    expect(first?.options.count).toBe(2);
    expect(first?.options.overscan).toBe(8);

    rendered.rerender(<Fixture count={5} estimate={72} />);
    expect(current).toBe(first);
    expect(current?.options.count).toBe(5);
    expect(current?.options.estimateSize(0)).toBe(72);
  });

  it("reacts to viewport and row measurements, then completely disposes observers", () => {
    const onChange = vi.fn();
    const onRender = vi.fn();
    const rendered = render(<Fixture count={100} onChange={onChange} onRender={onRender} />);
    const viewport = rendered.getByTestId("viewport");
    const row = rendered.getByTestId("row-0");
    const viewportObserver = observerFor(viewport);
    const rowObserver = observerFor(row);

    const rendersBeforeViewport = onRender.mock.calls.length;
    act(() => viewportObserver.trigger(viewport, 320, 200));
    expect(current?.scrollRect).toMatchObject({ width: 320, height: 200 });
    expect(onRender.mock.calls.length).toBeGreaterThan(rendersBeforeViewport);

    const rendersBeforeRow = onRender.mock.calls.length;
    act(() => rowObserver.trigger(row, 320, 96));
    expect(current?.getVirtualItems().find((item) => item.index === 0)?.size).toBe(96);
    expect(rendered.getByTestId("first-size").textContent).toBe("96");
    expect(onRender.mock.calls.length).toBeGreaterThan(rendersBeforeRow);

    const callbacks = ResizeObserverMock.instances.map((observer) => ({
      observer,
      target: [...observer.targets][0] ?? viewport,
    }));
    rendered.unmount();

    expect(ResizeObserverMock.instances.length).toBeGreaterThanOrEqual(2);
    for (const observer of ResizeObserverMock.instances) {
      expect(observer.targets.size).toBe(0);
      expect(
        observer.unobserve.mock.calls.length + observer.disconnect.mock.calls.length,
      ).toBeGreaterThan(0);
    }

    const rendersAfterUnmount = onRender.mock.calls.length;
    const changesAfterUnmount = onChange.mock.calls.length;
    act(() => {
      for (const { observer, target } of callbacks) observer.trigger(target, 320, 12);
    });
    expect(callbacks.every(({ observer }) => observer.callbackCalls > 0)).toBe(true);
    expect(onRender).toHaveBeenCalledTimes(rendersAfterUnmount);
    expect(onChange).toHaveBeenCalledTimes(changesAfterUnmount);
    expect(ResizeObserverMock.instances.every((observer) => observer.targets.size === 0)).toBe(
      true,
    );
  });
});
