export type ViewName = "timeline" | "agentflow" | "background";

export function DashboardNav({
  value,
  onChange,
}: {
  value: ViewName;
  onChange: (value: ViewName) => void;
}) {
  return (
    <nav class="dash-nav" aria-label="Session views">
      {(["timeline", "agentflow", "background"] as const).map((item) => (
        <button
          key={item}
          type="button"
          class={value === item ? "dash-nav__item dash-nav__item--active" : "dash-nav__item"}
          aria-current={value === item ? "page" : undefined}
          onClick={() => onChange(item)}
        >
          {item === "agentflow" ? "Agents" : item === "background" ? "Jobs" : "Timeline"}
        </button>
      ))}
    </nav>
  );
}
