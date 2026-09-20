// The agentflow extension's tools.
//
// Nine tools launch a run (the six semantic roles plus `agent`, `claude` and
// `workflow`); four observe runs someone else launched (`status`, `wait`, `cancel`,
// `steer`). Every result except `steer`'s carries the same run snapshots, so one
// card renders all of them — see `src/wire/agentflow.ts` for the decoder.
//
// A launching tool's header already names its run and its prompt, so its card omits
// both. A control tool's card has no such header above it, so it names the run on
// its status line and shows the prompt as a section.

import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import {
  decodeAgentflowObservedAt,
  decodeAgentflowRunViews,
  decodeAgentflowSteerAck,
  type AgentflowNodeView,
  type AgentflowPhaseGroup,
  type AgentflowRunView,
  type AgentflowStructuredField,
  type AgentflowStructuredOutput,
  type AgentflowToolCallView,
} from "../../wire/agentflow.ts";
import {
  formatCost,
  formatDuration,
  formatTokens,
  oneLine,
  pluralize,
  replaceTabs,
  shortenPath,
  statusIcon,
  truncate,
} from "../format.ts";
import { Markdown } from "../markdown.tsx";
import { PrefsContext } from "../preferences.ts";
import {
  ExpandableOutput,
  Facts,
  SectionTitle,
  StatusLine,
  Summary,
  ToolBox,
  useDisclosure,
  useLiveNow,
  type Fact,
} from "./shared.tsx";
import {
  defineTool,
  optionalNumber,
  optionalText,
  requiredText,
  textList,
  type RegisteredTool,
  type ToolContext,
  type ToolResultView,
  type ToolStatus,
} from "./types.ts";

/** Child rows kept visible on a collapsed run, matching the TUI's bound. */
const COLLAPSED_CHILD_ROWS = 8;

/** How the prompt reads in a collapsed header. */
const COLLAPSED_PROMPT_CHARS = 120;

const earlierToolCalls = (count: number): string => `… ${count} earlier tool calls`;
const omittedToolCalls = (total: number, retained: number, displayed: number): number =>
  Math.max(0, total - displayed, retained - displayed);

// ---------------------------------------------------------------------------
// Run cards
// ---------------------------------------------------------------------------

/**
 * The runs one result carries, with their elapsed times advancing while any of them is still
 * going.
 *
 * Two kinds of row deliberately stay put. A control tool records the moment it observed its
 * runs, and a recorded observation is not a clock. And a background run is launched and then
 * left — the extension writes its snapshot once and delivers the settled run as a message of
 * its own — so its launch card can never learn that the run finished, and a clock on it would
 * still be counting hours later next to a card that says "running".
 */
function useRunViews(name: string, details: unknown): AgentflowRunView[] {
  const { now, setLive } = useLiveNow();
  const observedAt = useMemo(() => decodeAgentflowObservedAt({ details }), [details]);
  const control =
    name === "agentflow_status" || name === "agentflow_wait" || name === "agentflow_cancel";
  const decodeNow = observedAt ?? now;
  const runs = useMemo(
    () => decodeAgentflowRunViews(name, { details }, decodeNow),
    [name, details, decodeNow],
  );
  const live =
    !control && observedAt === undefined && runs.some((run) => run.live && !run.background);
  useEffect(() => setLive(live), [live, setLive]);
  return runs;
}

function ToolCallRow({ call, expanded }: { call: AgentflowToolCallView; expanded: boolean }) {
  return (
    <li class="agentflow-tool-row">
      <span class={`agentflow-status status-${call.status}`} aria-label={call.status}>
        {statusIcon(call.status)}
      </span>
      <span class="agentflow-tool-name">{call.name}</span>
      <span class="agentflow-tool-argument">{oneLine(call.argumentSummary)}</span>
      {expanded && call.argumentsPreview ? (
        <span class="agentflow-tool-detail">
          <b>args:</b> {oneLine(call.argumentsPreview)}
        </span>
      ) : null}
      {expanded && call.error ? (
        <span class="agentflow-tool-detail error">
          <b>error:</b> {oneLine(call.error)}
        </span>
      ) : expanded && call.resultPreview ? (
        <span class="agentflow-tool-detail">
          <b>result:</b> {oneLine(call.resultPreview)}
        </span>
      ) : null}
    </li>
  );
}

/** A node's closing status line: status · elapsed · N tools · tokens · cost. */
function nodeStatusParts(node: AgentflowNodeView): string[] {
  return [
    node.elapsedMs ? formatDuration(node.elapsedMs) : "",
    pluralize(node.tools, "tool"),
    `${formatTokens(node.tokens)} tokens`,
    node.costKnown ? formatCost(node.cost) : "cost unavailable",
  ].filter(Boolean);
}

/** The heading of a declared phase: its title, derived status, and elapsed time. */
function PhaseHeading({ group }: { group: AgentflowPhaseGroup }) {
  return (
    <div class="agentflow-phase">
      <span class={`agentflow-run-status status-${group.status}`}>
        {statusIcon(group.status)} {group.title}
      </span>
      {group.elapsedMs ? (
        <span class="agentflow-phase-meta"> · {formatDuration(group.elapsedMs)}</span>
      ) : null}
    </div>
  );
}

/**
 * One workflow node. Collapsed, it is a concise row (status, label, a short tail). Expanded,
 * it reads like a collapsed standalone subagent: its label and the start of its prompt, its
 * most recent tool calls (without the per-tool args/results a top-level call shows), and a
 * closing status line.
 */
function WorkflowNode({ node, expanded }: { node: AgentflowNodeView; expanded: boolean }) {
  const omitted = Math.max(node.omittedToolCalls, node.tools - node.toolCalls.length);
  if (!expanded) {
    return (
      <li class="agentflow-node-compact">
        <span class={`agentflow-status status-${node.status}`} aria-label={node.status}>
          {statusIcon(node.status)}
        </span>
        <span class="agentflow-tool-name">{node.label}</span>
        {node.tools ? (
          <span class="agentflow-tool-argument">· {pluralize(node.tools, "tool")}</span>
        ) : null}
      </li>
    );
  }
  return (
    <div class="agentflow-node">
      <div class="agentflow-node-heading">
        <span class="agentflow-tool-name">{node.label}</span>
        {node.prompt ? (
          <span class="agentflow-tool-argument">
            · {truncate(oneLine(node.prompt), COLLAPSED_PROMPT_CHARS)}
          </span>
        ) : null}
      </div>
      {omitted > 0 ? <div class="agentflow-omitted">{earlierToolCalls(omitted)}</div> : null}
      {node.toolCalls.length ? (
        <ul class="agentflow-tool-list">
          {node.toolCalls.map((call) => (
            <ToolCallRow key={call.id} call={call} expanded={false} />
          ))}
        </ul>
      ) : null}
      <div class="tool-run-summary agentflow-node-status">
        <span class={`agentflow-run-status status-${node.status}`}>
          {statusIcon(node.status)} {node.status}
        </span>
        {nodeStatusParts(node).map((part, index) => (
          <span key={index}> · {part}</span>
        ))}
      </div>
    </div>
  );
}

/**
 * A workflow's nodes, grouped by declared phase. Collapsed and expanded both group; the
 * ungrouped bucket (empty phase title) renders last with no heading. Each group's nodes are
 * concise rows when collapsed and subagent-like cards when expanded.
 */
function WorkflowNodes({ run, expanded }: { run: AgentflowRunView; expanded: boolean }) {
  const visibleNodes = expanded ? run.nodes : run.nodes.slice(-COLLAPSED_CHILD_ROWS);
  const omittedNodes = run.omittedNodes + (run.nodes.length - visibleNodes.length);
  const nodeById = new Map(visibleNodes.map((node) => [node.id, node] as const));
  return (
    <>
      {omittedNodes > 0 ? (
        <div class="agentflow-omitted">… {pluralize(omittedNodes, "earlier node")}</div>
      ) : null}
      {expanded ? <SectionTitle>Nodes</SectionTitle> : null}
      {run.phaseGroups.map((group) => {
        const nodes = group.nodeIds
          .map((id) => nodeById.get(id))
          .filter((node): node is AgentflowNodeView => Boolean(node));
        if (!nodes.length) return null;
        return (
          <div key={group.title || "ungrouped"} class="agentflow-phase-group">
            {group.title ? <PhaseHeading group={group} /> : null}
            {expanded ? (
              nodes.map((node) => <WorkflowNode key={node.id} node={node} expanded />)
            ) : (
              <ul class="agentflow-tool-list">
                {nodes.map((node) => (
                  <WorkflowNode key={node.id} node={node} expanded={false} />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * A run's closing status line, mirroring the TUI: status · elapsed · backend ·
 * outcome · usage.
 *
 * A background run that is still going reports its mode and nothing else. The extension
 * launches it and then leaves: it streams no usage for those, so the numbers would sit there
 * stale, and it never corrects the snapshot, so a duration measured against the clock would
 * keep growing on every unrelated re-decode, long after the run ended. The finished run arrives
 * as its own message, with the duration it really took.
 */
function runStatusParts(run: AgentflowRunView): string[] {
  const launched = run.background && run.live;
  const execution = run.backend ? `${run.backend}/${run.model || "default"}` : "";
  const usage = [
    run.outcome,
    pluralize(run.tools, "tool"),
    `${formatTokens(run.tokens)} tokens`,
    run.costKnown ? formatCost(run.cost) : "cost unavailable",
  ];
  return [
    launched || !run.elapsedMs ? "" : formatDuration(run.elapsedMs),
    execution,
    ...(launched ? [] : usage),
  ].filter(Boolean);
}

function StructuredField({ field }: { field: AgentflowStructuredField }) {
  const values = field.values.length ? field.values : ["(none)"];
  const content = (value: string) =>
    field.kind === "markdown" ? (
      <Markdown text={value || "(empty)"} />
    ) : (
      <span class="agentflow-structured-plain">{replaceTabs(value) || "(empty)"}</span>
    );
  return (
    <div class="agentflow-structured-field">
      {field.label ? <div class="agentflow-structured-field-label">{field.label}</div> : null}
      {values.length === 1 ? (
        <div class="agentflow-structured-value">{content(values[0] || "")}</div>
      ) : (
        <ol class="agentflow-structured-values">
          {values.map((value, index) => (
            <li key={index}>{content(value)}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

const STRUCTURED_OUTPUT_LINES = 24;

function structuredLineEstimate(output: AgentflowStructuredOutput): number {
  let lines = 0;
  for (const section of output.sections) {
    lines += 1;
    if (!section.fields.length && !section.items.length) lines += 1;
    for (const field of section.fields)
      lines +=
        (field.label ? 1 : 0) +
        Math.max(
          1,
          field.values.reduce((total, value) => total + value.split("\n").length, 0),
        );
    for (const item of section.items) {
      lines += 1;
      for (const field of item.fields)
        lines +=
          (field.label ? 1 : 0) +
          Math.max(
            1,
            field.values.reduce((total, value) => total + value.split("\n").length, 0),
          );
    }
    if (lines > STRUCTURED_OUTPUT_LINES) return lines;
  }
  return lines;
}

/** The fixed section → item → field hierarchy shared by all six semantic roles. */
function StructuredOutput({ output, dkey }: { output: AgentflowStructuredOutput; dkey: string }) {
  const { prefs } = useContext(PrefsContext);
  const regionId = useId();
  const element = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(
    () => structuredLineEstimate(output) > STRUCTURED_OUTPUT_LINES,
  );
  const [expanded, setExpanded] = useDisclosure(dkey, prefs.tools);
  useLayoutEffect(() => {
    const target = element.current;
    if (!target) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(window.getComputedStyle(target).lineHeight) || 16;
      // jsdom has no layout and reports zero; retain the source estimate there.
      if (target.scrollHeight > 0)
        setOverflows(target.scrollHeight > lineHeight * STRUCTURED_OUTPUT_LINES + 1);
    };
    measure();
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(measure);
      observer.observe(target);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [output]);
  return (
    <>
      <div
        ref={element}
        id={regionId}
        class={`agentflow-structured-output ${overflows && !expanded ? "bounded" : ""}`}
        aria-hidden={overflows && !expanded ? "true" : undefined}
        inert={overflows && !expanded ? true : undefined}
      >
        {output.sections.map((section) => (
          <section key={section.label} class="agentflow-structured-section">
            <div class="agentflow-structured-section-title">{section.label}</div>
            <div class="agentflow-structured-section-body">
              {section.fields.map((field, index) => (
                <StructuredField key={index} field={field} />
              ))}
              {!section.fields.length && !section.items.length ? (
                <div class="agentflow-structured-empty">(none)</div>
              ) : null}
              {section.items.map((item) => (
                <div key={item.label} class="agentflow-structured-item">
                  <div class="agentflow-structured-item-title">{item.label}</div>
                  <div class="agentflow-structured-item-body">
                    {item.fields.map((field, index) => (
                      <StructuredField key={index} field={field} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      {overflows ? (
        <button
          type="button"
          class="agentflow-structured-toggle"
          aria-expanded={expanded ? "true" : "false"}
          aria-controls={regionId}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : "Show full structured output"}
        </button>
      ) : null}
    </>
  );
}

function RunCard({
  run,
  expanded,
  dkey,
  facts = [],
  lists = [],
  promptSection = false,
}: {
  run: AgentflowRunView;
  expanded: boolean;
  dkey: string;
  /** Call-specific facts the launching tool contributes to the expanded view. */
  facts?: readonly Fact[];
  /** Call-specific multi-line sections, e.g. a delegate's contract. */
  lists?: readonly { title: string; items: readonly string[] }[];
  /** The caller has no launching header that already carries the prompt. */
  promptSection?: boolean;
}) {
  const workflow = run.kind === "workflow";
  const visible = expanded ? run.toolCalls : run.toolCalls.slice(-COLLAPSED_CHILD_ROWS);
  const omitted = Math.max(
    run.omittedToolCalls,
    omittedToolCalls(run.tools, run.toolCalls.length, visible.length),
  );
  return (
    <div class="agentflow-live-run">
      {expanded ? (
        <Facts
          items={[
            { label: "Run", value: run.runId },
            { label: "Cwd", value: shortenPath(run.cwd) },
            { label: "Backend", value: run.backend },
            { label: "Model", value: run.model },
            { label: "Phases", value: run.phases },
            { label: "Session", value: shortenPath(run.sessionFile) },
            { label: "Artifacts", value: shortenPath(run.artifactDir) },
            ...facts,
          ]}
        />
      ) : null}
      {expanded
        ? lists
            .filter((list) => list.items.length)
            .map((list) => (
              <div key={list.title}>
                <SectionTitle>{list.title}</SectionTitle>
                <ul class="agentflow-tool-list">
                  {list.items.map((item, index) => (
                    <li key={index} class="agentflow-tool-row">
                      <span class="agentflow-tool-argument">{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
        : null}
      {expanded && promptSection && run.prompt ? (
        <>
          <SectionTitle>Prompt</SectionTitle>
          <ExpandableOutput text={run.prompt} maxLines={24} dkey={`${dkey}:prompt`} />
        </>
      ) : null}
      {workflow ? (
        <WorkflowNodes run={run} expanded={expanded} />
      ) : (
        <>
          {omitted > 0 ? <div class="agentflow-omitted">{earlierToolCalls(omitted)}</div> : null}
          {visible.length ? (
            <>
              {expanded ? <SectionTitle>Tool calls</SectionTitle> : null}
              <ul class="agentflow-tool-list">
                {visible.map((call) => (
                  <ToolCallRow key={call.id} call={call} expanded={expanded} />
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
      {expanded && (run.output || run.structuredOutput) ? (
        <>
          <SectionTitle>{run.outputIsError ? "Error" : "Output"}</SectionTitle>
          {run.outputIsError ? (
            <div class="tool-error">{run.output}</div>
          ) : run.structuredOutput ? (
            <StructuredOutput output={run.structuredOutput} dkey={`${dkey}:structured-output`} />
          ) : (
            <ExpandableOutput text={run.output} maxLines={24} dkey={`${dkey}:output`} />
          )}
        </>
      ) : null}
      {expanded && run.logs.length ? (
        <>
          <SectionTitle>Logs</SectionTitle>
          <ExpandableOutput text={run.logs.join("\n")} maxLines={5} dkey={`${dkey}:logs`} />
        </>
      ) : null}
      <StatusLine
        status={run.status}
        state={`${run.status}${run.background && run.live ? " in the background" : ""}`}
        parts={runStatusParts(run)}
        expanded={expanded}
      />
    </div>
  );
}

/**
 * The tool's own text, used when no run snapshot could be read (an argument error, a
 * result the extension could not serialize). It is all the model got either way.
 */
function ResultText({ result, ctx }: { result: ToolResultView; ctx: ToolContext }) {
  if (!result.text) return null;
  return ctx.expanded ? (
    <ExpandableOutput text={result.text} maxLines={24} dkey={`${ctx.dkey}:out`} />
  ) : (
    <Summary
      text={truncate(oneLine(result.text), 160)}
      status={result.isError ? "error" : undefined}
    />
  );
}

/** The full run cards a launching tool shows for the run it started. */
function Runs({
  name,
  result,
  ctx,
  facts,
  lists,
}: {
  name: string;
  result: ToolResultView;
  ctx: ToolContext;
  facts?: readonly Fact[];
  lists?: readonly { title: string; items: readonly string[] }[];
}) {
  const runs = useRunViews(name, result.details);
  if (!runs.length) return <ResultText result={result} ctx={ctx} />;
  return (
    <div class="agentflow-live-results">
      {runs.map((run, index) => (
        <RunCard
          key={run.runId || index}
          run={run}
          expanded={ctx.expanded}
          dkey={`${ctx.dkey}:run:${index}`}
          facts={facts}
          lists={lists}
        />
      ))}
    </div>
  );
}

/** What a control tool reports: compact states when closed, full observed cards when open. */
function RunStates({
  name,
  result,
  ctx,
}: {
  name: string;
  result: ToolResultView;
  ctx: ToolContext;
}) {
  const runs = useRunViews(name, result.details);
  if (!runs.length) return <ResultText result={result} ctx={ctx} />;
  if (ctx.expanded)
    return (
      <div class="agentflow-live-results">
        {runs.map((run, index) => (
          <RunCard
            key={run.runId || index}
            run={run}
            expanded
            promptSection
            dkey={`${ctx.dkey}:run:${index}`}
          />
        ))}
      </div>
    );
  const visible = runs.slice(0, COLLAPSED_CHILD_ROWS);
  return (
    <div class="agentflow-live-results">
      <ul class="agentflow-tool-list">
        {visible.map((run, index) => (
          <li key={run.runId || index} class="agentflow-tool-row">
            <span class={`agentflow-status status-${run.status}`} aria-label={run.status}>
              {statusIcon(run.status)}
            </span>
            <span class="agentflow-tool-name">{run.runId || "unknown run"}</span>
            <span class="agentflow-tool-argument">
              {[
                run.role,
                `${run.status}${run.background && run.live ? " in the background" : ""}`,
                run.elapsedMs ? formatDuration(run.elapsedMs) : "",
                run.outcome,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      {runs.length > visible.length ? (
        <div class="agentflow-omitted">… {pluralize(runs.length - visible.length, "more run")}</div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The nine run-launching tools
// ---------------------------------------------------------------------------

/**
 * What a launching tool contributes beyond its run: the prompt that names it, an
 * accent (a model, a node label), and the arguments that only matter once expanded.
 */
interface LaunchArgs {
  /** Short accent shown right after the role label. */
  accent: string;
  background: boolean;
  /** The task, question or prompt this run was launched with. */
  prompt: string;
  facts: readonly Fact[];
  lists: readonly { title: string; items: readonly string[] }[];
}

function launchTool(
  name: string,
  label: string,
  decode: (raw: Readonly<Record<string, unknown>>) => LaunchArgs,
): RegisteredTool {
  return defineTool<LaunchArgs>({
    names: [name],
    headerClass: "tool-header custom-tool-header",
    decode,
    header: (args, { expanded }) => (
      <>
        <span class="tool-name">{label}</span>
        {args.accent ? <span class="tool-argument"> {args.accent}</span> : null}
        {/* How the run was requested; whether it is still going is the status line's job. */}
        {args.background ? <span class="line-count">{" · background"}</span> : null}
        {args.prompt ? (
          <span class="line-count">
            {" · "}
            {expanded ? args.prompt : truncate(oneLine(args.prompt), COLLAPSED_PROMPT_CHARS)}
          </span>
        ) : null}
      </>
    ),
    body: (args, result, ctx) =>
      result ? (
        <Runs name={name} result={result} ctx={ctx} facts={args.facts} lists={args.lists} />
      ) : null,
  });
}

const isBackground = (raw: Readonly<Record<string, unknown>>) => raw.mode === "background";

/** `paths`/`files` scope a read-only run; they are worth naming when present. */
function scopeFact(label: string, paths: readonly string[]): readonly Fact[] {
  return paths.length ? [{ label, value: paths.map(shortenPath).join(", ") }] : [];
}

const finder = launchTool("agentflow_finder", "finder", (raw) => ({
  accent: "",
  background: isBackground(raw),
  prompt: optionalText(raw.task),
  facts: scopeFact("Paths", textList(raw.paths)),
  lists: [],
}));

const oracle = launchTool("agentflow_oracle", "oracle", (raw) => ({
  accent: "",
  background: isBackground(raw),
  prompt: optionalText(raw.question),
  facts: scopeFact("Files", textList(raw.files)),
  lists: [],
}));

const librarian = launchTool("agentflow_librarian", "librarian", (raw) => ({
  accent: "",
  background: isBackground(raw),
  prompt: optionalText(raw.question),
  facts: [],
  lists: [],
}));

// `look_at` is the one role whose target, not its prompt, identifies the call.
const lookAt = launchTool("agentflow_look_at", "look_at", (raw) => {
  const references = textList(raw.referenceFiles);
  return {
    accent: shortenPath(optionalText(raw.path)),
    background: isBackground(raw),
    prompt: optionalText(raw.objective),
    facts: [
      ...(references.length
        ? [{ label: "References", value: references.map(shortenPath).join(", ") }]
        : []),
      ...(raw.context ? [{ label: "Context", value: optionalText(raw.context) }] : []),
    ],
    lists: [],
  };
});

// A delegate run is defined by its contract, which is the whole point of the tool.
const delegate = launchTool("agentflow_delegate", "delegate", (raw) => ({
  accent: "",
  background: isBackground(raw),
  prompt: optionalText(raw.task),
  facts: raw.continuationSessionFile
    ? [{ label: "Continues", value: shortenPath(optionalText(raw.continuationSessionFile)) }]
    : [],
  lists: [
    { title: "Ownership", items: textList(raw.ownership).map(shortenPath) },
    { title: "Acceptance criteria", items: textList(raw.acceptanceCriteria) },
    { title: "Verification", items: textList(raw.verificationCommands) },
  ],
}));

const review = launchTool("agentflow_review", "review", (raw) => ({
  accent: "",
  background: isBackground(raw),
  prompt: optionalText(raw.task) || "Review the integrated diff",
  facts: [
    ...(raw.base ? [{ label: "Base", value: optionalText(raw.base) }] : []),
    ...scopeFact("Paths", textList(raw.paths)),
  ],
  lists: [],
}));

const claude = launchTool("agentflow_claude", "claude", (raw) => ({
  // The model is the choice being made here; `opus` is the tool's own default.
  accent: optionalText(raw.model) || "opus",
  background: isBackground(raw),
  prompt: optionalText(raw.task),
  facts: [],
  lists: [],
}));

const agent = launchTool("agentflow_agent", "agentflow_agent", (raw) => ({
  accent: optionalText(raw.label),
  background: isBackground(raw),
  prompt: optionalText(raw.prompt),
  facts: [
    ...(raw.model ? [{ label: "Model", value: optionalText(raw.model) }] : []),
    ...(raw.thinking ? [{ label: "Thinking", value: optionalText(raw.thinking) }] : []),
    ...(raw.cwd ? [{ label: "Cwd", value: shortenPath(optionalText(raw.cwd)) }] : []),
  ],
  lists: [],
}));

/**
 * A workflow script is not readable as a header line, but it must open with a
 * static `export const meta = { name, description }`, so name the workflow by that.
 */
function workflowMeta(script: string): { name: string; description: string } {
  const head = script.slice(0, 4_096);
  return {
    name: /\bname\s*:\s*["'`]([^"'`]{1,64})["'`]/.exec(head)?.[1] ?? "",
    description: /\bdescription\s*:\s*["'`]([^"'`]{1,256})["'`]/.exec(head)?.[1] ?? "",
  };
}

const workflow = launchTool("agentflow_workflow", "agentflow_workflow", (raw) => {
  const meta = workflowMeta(optionalText(raw.script));
  const limits = typeof raw.limits === "object" && raw.limits !== null ? raw.limits : {};
  const limit = (key: string) => optionalNumber((limits as Record<string, unknown>)[key]);
  return {
    accent: meta.name,
    background: isBackground(raw),
    prompt: meta.description,
    facts: [
      { label: "Max agents", value: limit("maxAgents")?.toLocaleString() ?? "" },
      { label: "Concurrency", value: limit("concurrency")?.toLocaleString() ?? "" },
      { label: "Token budget", value: limit("tokenBudget")?.toLocaleString() ?? "" },
    ],
    lists: [],
  };
});

// ---------------------------------------------------------------------------
// The four control tools
// ---------------------------------------------------------------------------

/** `status`, `wait` and `cancel` report on runs they did not launch. */
function controlTool(
  name: string,
  label: string,
  decode: (raw: Readonly<Record<string, unknown>>) => { target: string },
): RegisteredTool {
  return defineTool({
    names: [name],
    headerClass: "tool-header custom-tool-header",
    decode,
    header: (args) => (
      <>
        <span class="tool-name">{label}</span>
        {args.target ? <span class="line-count"> · {args.target}</span> : null}
      </>
    ),
    body: (_args, result, ctx) =>
      result ? <RunStates name={name} result={result} ctx={ctx} /> : null,
  });
}

/** Run ids as the TUI lists them: the first few, then a count. */
function runIdList(value: unknown): string {
  const ids = textList(value);
  if (!ids.length) return "";
  const shown = ids.slice(0, 3).join(", ");
  return ids.length > 3 ? `${shown}, +${ids.length - 3} more` : shown;
}

const statusTool = controlTool("agentflow_status", "agentflow_status", (raw) => ({
  target: optionalText(raw.runId) || "recent runs",
}));
const waitTool = controlTool("agentflow_wait", "agentflow_wait", (raw) => ({
  target: runIdList(raw.runIds),
}));
const cancelTool = controlTool("agentflow_cancel", "agentflow_cancel", (raw) => ({
  target: runIdList(raw.runIds),
}));

const steerTool = defineTool({
  names: ["agentflow_steer"],
  headerClass: "tool-header custom-tool-header",
  decode: (raw) => ({
    runId: requiredText(raw.runId),
    nodeId: optionalText(raw.nodeId),
    message: optionalText(raw.message),
  }),
  header: (args, { expanded }) => (
    <>
      <span class="tool-name">agentflow_steer</span>
      <span class="line-count">
        {" · "}
        {args.runId === null ? "[invalid arg]" : args.runId}
        {args.nodeId ? ` / ${args.nodeId}` : ""}
      </span>
      {args.message ? (
        <span class="line-count">
          {" · "}
          {expanded ? args.message : truncate(oneLine(args.message), COLLAPSED_PROMPT_CHARS)}
        </span>
      ) : null}
    </>
  ),
  // Steering is acknowledged with the node it reached, not with a run snapshot.
  body: (_args, result, { expanded, dkey }) => {
    if (!result) return null;
    const nodeId = decodeAgentflowSteerAck(result);
    if (nodeId === null || result.isError)
      return expanded ? (
        <ExpandableOutput text={result.text} maxLines={10} dkey={`${dkey}:out`} />
      ) : (
        <Summary
          text={truncate(oneLine(result.text), 160)}
          status={result.isError ? "error" : undefined}
        />
      );
    return (
      <Summary
        text={nodeId ? `steering accepted for ${nodeId}` : "steering accepted"}
        status="success"
      />
    );
  },
});

// ---------------------------------------------------------------------------
// Delivered background results
// ---------------------------------------------------------------------------

/**
 * A background run delivering its result as a follow-up message. It has no tool
 * call to hang off, so it renders the same box the launching call would: the role
 * and prompt in the header, the run itself in the body.
 */
export function AgentflowResultMessage({ details, dkey }: { details: unknown; dkey: string }) {
  const { prefs } = useContext(PrefsContext);
  const [expanded, setExpanded] = useDisclosure(`${dkey}:box`, prefs.tools);
  const run = useRunViews("agentflow_agent", details)[0];
  if (!run) return null;
  const label = run.role || "agent";
  const status: ToolStatus =
    run.status === "failed" || run.status === "aborted"
      ? "error"
      : run.status === "completed"
        ? "success"
        : "pending";
  return (
    <ToolBox
      status={status}
      label={`${label} result`}
      headerClass="tool-header custom-tool-header"
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      header={
        <>
          <span class="tool-name">{label}</span>
          <span class="line-count"> · result</span>
          {run.prompt ? (
            <span class="line-count">
              {" · "}
              {expanded ? run.prompt : truncate(oneLine(run.prompt), COLLAPSED_PROMPT_CHARS)}
            </span>
          ) : null}
        </>
      }
    >
      <RunCard run={run} expanded={expanded} dkey={`${dkey}:run`} />
    </ToolBox>
  );
}

export const AGENTFLOW_TOOLS: readonly RegisteredTool[] = [
  finder,
  oracle,
  librarian,
  lookAt,
  delegate,
  review,
  claude,
  agent,
  workflow,
  statusTool,
  waitTool,
  cancelTool,
  steerTool,
];
