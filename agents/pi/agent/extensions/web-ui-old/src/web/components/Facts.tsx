import type { ComponentChildren } from "preact";

export interface Fact {
  readonly label: string;
  readonly value: ComponentChildren;
  readonly tone?: "default" | "error" | "running" | "muted";
}

/** Compact definition list for the small facts a tool detail exposes. */
export function Facts({ items }: { items: readonly (Fact | null | undefined)[] }) {
  const facts = items.filter((item): item is Fact => Boolean(item));
  if (facts.length === 0) return null;
  return (
    <dl class="facts">
      {facts.map((fact, index) => (
        // eslint-disable-next-line react/no-array-index-key -- fact order is fixed
        <div key={index} class={`facts__row facts__row--${fact.tone ?? "default"}`}>
          <dt class="facts__label">{fact.label}</dt>
          <dd class="facts__value">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}
