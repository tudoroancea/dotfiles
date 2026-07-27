import { createContext } from "preact";
import { useContext, useMemo, useState } from "preact/hooks";

/**
 * Expansion state for tool disclosures, keyed by a stable tool-call/entry ID.
 * Virtualization unmounts and remounts rows freely, so the open/closed state
 * cannot live inside a row component; it is externalized here and survives
 * remounts as long as the ID is stable.
 */
export interface ExpansionApi {
  isExpanded(id: string): boolean;
  toggle(id: string): void;
  reset(): void;
}

export const ExpansionContext = createContext<ExpansionApi | null>(null);

export function useExpansionState(): ExpansionApi {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  return useMemo<ExpansionApi>(
    () => ({
      isExpanded: (id) => ids.has(id),
      toggle: (id) =>
        setIds((previous) => {
          const next = new Set(previous);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }),
      reset: () => setIds((previous) => (previous.size === 0 ? previous : new Set())),
    }),
    [ids],
  );
}

export function useExpansion(): ExpansionApi | null {
  return useContext(ExpansionContext);
}
