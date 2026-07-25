import {
  elementScroll,
  measureElement,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type VirtualizerOptions,
} from "@tanstack/virtual-core";
import { useLayoutEffect, useRef, useState } from "preact/hooks";

export type ElementVirtualizerOptions<
  TScrollElement extends Element,
  TItemElement extends Element,
> = Omit<
  VirtualizerOptions<TScrollElement, TItemElement>,
  "observeElementRect" | "observeElementOffset" | "scrollToFn"
> &
  Partial<
    Pick<
      VirtualizerOptions<TScrollElement, TItemElement>,
      "observeElementRect" | "observeElementOffset" | "scrollToFn"
    >
  >;

/** A small Preact lifecycle adapter around TanStack's framework-neutral core. */
export function useVirtualizer<
  TScrollElement extends Element = HTMLElement,
  TItemElement extends Element = HTMLElement,
>(
  options: ElementVirtualizerOptions<TScrollElement, TItemElement>,
): Virtualizer<TScrollElement, TItemElement> {
  const [, rerender] = useState(0);
  const mountedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const instanceRef = useRef<Virtualizer<TScrollElement, TItemElement>>();
  const resolved = {
    ...options,
    observeElementRect: options.observeElementRect ?? observeElementRect,
    observeElementOffset: options.observeElementOffset ?? observeElementOffset,
    scrollToFn: options.scrollToFn ?? elementScroll,
    measureElement: options.measureElement ?? measureElement,
    onChange: (instance: Virtualizer<TScrollElement, TItemElement>, sync: boolean) => {
      if (!mountedRef.current) return;
      optionsRef.current.onChange?.(instance, sync);
      rerender((version) => version + 1);
    },
  } satisfies VirtualizerOptions<TScrollElement, TItemElement>;

  if (!instanceRef.current) instanceRef.current = new Virtualizer(resolved);
  const instance = instanceRef.current;
  instance.setOptions(resolved);

  useLayoutEffect(() => {
    mountedRef.current = true;
    const dispose = instance._didMount();
    return () => {
      mountedRef.current = false;
      dispose();
    };
  }, [instance]);
  useLayoutEffect(() => instance._willUpdate());

  return instance;
}

export type { VirtualItem, Virtualizer } from "@tanstack/virtual-core";
