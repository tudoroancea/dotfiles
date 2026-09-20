// Transcript disclosure store.
//
// Thinking/tool expansion is per-row UI state. Once transcript rows are
// virtualized they unmount and remount as the user scrolls, which would reset any
// `useState`-based expansion. This store lifts that state above the virtualized
// rows so a block keeps its expanded/collapsed state across unmount/remount, and a
// height change after toggling is re-measured by the virtualizer's ResizeObserver.
//
// Keys are namespaced by kind (`thinking:`, `tools:`, `misc:`) so the global
// "expand/collapse all" preference hotkeys can drop every override of one kind and
// let the preference default apply again.

import { createContext } from "preact";
import { useMemo, useRef, useState } from "preact/hooks";

export interface DisclosureStore {
  /** Effective open state: an explicit override, otherwise the caller's fallback. */
  resolve(key: string, fallback: boolean): boolean;
  /** Record an explicit per-block override. */
  set(key: string, value: boolean): void;
  /** Drop every override whose key starts with `prefix` (used by pref hotkeys). */
  clearPrefix(prefix: string): void;
}

const NOOP_STORE: DisclosureStore = {
  resolve: (_key, fallback) => fallback,
  set: () => {},
  clearPrefix: () => {},
};

export const DisclosureContext = createContext<DisclosureStore>(NOOP_STORE);

/**
 * Owns the override map for a mounted client. The returned store changes identity
 * on every mutation so context consumers re-render and re-read their state.
 */
export function useDisclosureStore(): DisclosureStore {
  const overrides = useRef(new Map<string, boolean>());
  const [version, setVersion] = useState(0);
  return useMemo<DisclosureStore>(
    () => ({
      resolve: (key, fallback) =>
        overrides.current.has(key) ? overrides.current.get(key)! : fallback,
      set: (key, value) => {
        overrides.current.set(key, value);
        setVersion((current) => current + 1);
      },
      clearPrefix: (prefix) => {
        let changed = false;
        // Deleting the current key while iterating a Map is well-defined.
        for (const key of overrides.current.keys()) {
          if (key.startsWith(prefix)) {
            overrides.current.delete(key);
            changed = true;
          }
        }
        if (changed) setVersion((current) => current + 1);
      },
    }),
    [version],
  );
}
