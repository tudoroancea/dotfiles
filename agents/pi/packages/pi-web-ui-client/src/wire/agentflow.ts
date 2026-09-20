import {
  Array as TypeArray,
  Boolean as TypeBoolean,
  Literal as TypeLiteral,
  Number as TypeNumber,
  Null as TypeNull,
  Object as TypeObject,
  String as TypeString,
  Union as TypeUnion,
  type Static,
  type TProperties,
} from "typebox";
import { Check } from "typebox/value";

/**
 * Browser normalization limits for the opaque run snapshots the locally installed
 * Agentflow extension puts in tool-result details. Every Agentflow tool — the
 * agent-launching ones and the control ones (status/wait/cancel/steer) — carries
 * the same run snapshots, so one decoder feeds one renderer for all of them.
 *
 * These are renderer-view limits, not obligations on the extension.
 */
export const AGENTFLOW_LIMITS = {
  maxRuns: 16,
  maxNodes: 64,
  maxToolCalls: 256,
  /** A workflow node previews only its most recent tool calls, like a collapsed subagent. */
  maxNodeToolCalls: 4,
  maxLogLines: 64,
  maxIdChars: 256,
  maxLabelChars: 128,
  maxPathChars: 1_024,
  maxPromptChars: 8 * 1_024,
  maxOutputChars: 32 * 1_024,
  maxSummaryChars: 1_024,
  maxCount: 0x7fff_ffff,
} as const;

const StrictObject = <T extends TProperties>(properties: T) =>
  TypeObject(properties, { additionalProperties: false });
const CountSchema = TypeNumber({ minimum: 0, maximum: AGENTFLOW_LIMITS.maxCount, multipleOf: 1 });

/** Mirrors the extension's `RunStatus`; anything else normalizes to "queued". */
export const AgentflowStatusSchema = TypeUnion([
  TypeLiteral("queued"),
  TypeLiteral("running"),
  TypeLiteral("completed"),
  TypeLiteral("failed"),
  TypeLiteral("aborted"),
]);
export type AgentflowStatus = Static<typeof AgentflowStatusSchema>;

export const AgentflowToolCallViewSchema = StrictObject({
  id: TypeString({ maxLength: AGENTFLOW_LIMITS.maxIdChars }),
  name: TypeString({ maxLength: AGENTFLOW_LIMITS.maxLabelChars }),
  status: AgentflowStatusSchema,
  argumentSummary: TypeString({ maxLength: AGENTFLOW_LIMITS.maxSummaryChars }),
  argumentsPreview: TypeString({ maxLength: AGENTFLOW_LIMITS.maxSummaryChars }),
  resultPreview: TypeString({ maxLength: AGENTFLOW_LIMITS.maxSummaryChars }),
  error: TypeString({ maxLength: AGENTFLOW_LIMITS.maxSummaryChars }),
});
export type AgentflowToolCallView = Static<typeof AgentflowToolCallViewSchema>;

/**
 * One child agent inside a run. A semantic run has exactly one, so its renderer
 * reads the flattened single-node fields below; a workflow has many, and each one
 * renders like a collapsed standalone subagent — its prompt, its most recent tool
 * calls, and a closing status line — so it carries the same detail.
 */
export const AgentflowNodeViewSchema = StrictObject({
  id: TypeString({ maxLength: AGENTFLOW_LIMITS.maxIdChars }),
  label: TypeString({ maxLength: AGENTFLOW_LIMITS.maxLabelChars }),
  phase: TypeString({ maxLength: AGENTFLOW_LIMITS.maxLabelChars }),
  status: AgentflowStatusSchema,
  backend: TypeString({ maxLength: AGENTFLOW_LIMITS.maxLabelChars }),
  model: TypeString({ maxLength: AGENTFLOW_LIMITS.maxLabelChars }),
  prompt: TypeString({ maxLength: AGENTFLOW_LIMITS.maxPromptChars }),
  /** Elapsed node time in milliseconds; 0 when the node carries no usable timestamps. */
  elapsedMs: CountSchema,
  tools: CountSchema,
  tokens: CountSchema,
  cost: TypeNumber({ minimum: 0, maximum: AGENTFLOW_LIMITS.maxCount }),
  costKnown: TypeBoolean(),
  /** The node's most recent tool calls, newest last; older ones are counted only. */
  toolCalls: TypeArray(AgentflowToolCallViewSchema, {
    maxItems: AGENTFLOW_LIMITS.maxNodeToolCalls,
  }),
  omittedToolCalls: CountSchema,
});
export type AgentflowNodeView = Static<typeof AgentflowNodeViewSchema>;

/**
 * A declared workflow phase and the nodes grouped under it. Its status and elapsed
 * time are derived from those nodes; the ungrouped bucket (nodes with no declared or
 * matching phase) is the one group whose `title` is empty, and it always renders last.
 */
export const AgentflowPhaseGroupSchema = StrictObject({
  title: TypeString({ maxLength: AGENTFLOW_LIMITS.maxLabelChars }),
  status: AgentflowStatusSchema,
  elapsedMs: CountSchema,
  nodeIds: TypeArray(TypeString({ maxLength: AGENTFLOW_LIMITS.maxIdChars }), {
    maxItems: AGENTFLOW_LIMITS.maxNodes,
  }),
});
export type AgentflowPhaseGroup = Static<typeof AgentflowPhaseGroupSchema>;

export const AgentflowStructuredFieldSchema = StrictObject({
  label: TypeString({ maxLength: AGENTFLOW_LIMITS.maxLabelChars }),
  kind: TypeUnion([TypeLiteral("markdown"), TypeLiteral("plain")]),
  values: TypeArray(TypeString({ maxLength: AGENTFLOW_LIMITS.maxOutputChars }), { maxItems: 64 }),
});
export type AgentflowStructuredField = Static<typeof AgentflowStructuredFieldSchema>;

export const AgentflowStructuredItemSchema = StrictObject({
  label: TypeString({ maxLength: AGENTFLOW_LIMITS.maxLabelChars }),
  fields: TypeArray(AgentflowStructuredFieldSchema, { maxItems: 8 }),
});
export type AgentflowStructuredItem = Static<typeof AgentflowStructuredItemSchema>;

export const AgentflowStructuredSectionSchema = StrictObject({
  label: TypeString({ maxLength: AGENTFLOW_LIMITS.maxLabelChars }),
  fields: TypeArray(AgentflowStructuredFieldSchema, { maxItems: 8 }),
  items: TypeArray(AgentflowStructuredItemSchema, { maxItems: 64 }),
});
export type AgentflowStructuredSection = Static<typeof AgentflowStructuredSectionSchema>;

export const AgentflowStructuredOutputSchema = StrictObject({
  sections: TypeArray(AgentflowStructuredSectionSchema, { maxItems: 8 }),
});
export type AgentflowStructuredOutput = Static<typeof AgentflowStructuredOutputSchema>;

export const AgentflowRunViewSchema = StrictObject({
  runId: TypeString({ maxLength: AGENTFLOW_LIMITS.maxIdChars }),
  /** A workflow orchestrates several nodes; an agent run has exactly one. */
  kind: TypeUnion([TypeLiteral("agent"), TypeLiteral("workflow")]),
  /** Semantic role, run name, or origin tool — whichever the snapshot carries. */
  role: TypeString({ maxLength: AGENTFLOW_LIMITS.maxLabelChars }),
  status: AgentflowStatusSchema,
  /** The run was launched with `mode: "background"`. */
  background: TypeBoolean(),
  /** The run has not reached a terminal state, so streamed usage is still moving. */
  live: TypeBoolean(),
  prompt: TypeString({ maxLength: AGENTFLOW_LIMITS.maxPromptChars }),
  cwd: TypeString({ maxLength: AGENTFLOW_LIMITS.maxPathChars }),
  backend: TypeString({ maxLength: AGENTFLOW_LIMITS.maxLabelChars }),
  model: TypeString({ maxLength: AGENTFLOW_LIMITS.maxLabelChars }),
  sessionFile: TypeString({ maxLength: AGENTFLOW_LIMITS.maxPathChars }),
  artifactDir: TypeString({ maxLength: AGENTFLOW_LIMITS.maxPathChars }),
  phases: TypeString({ maxLength: AGENTFLOW_LIMITS.maxSummaryChars }),
  /** Elapsed run time in milliseconds; 0 when the snapshot carries no timestamps. */
  elapsedMs: CountSchema,
  tools: CountSchema,
  tokens: CountSchema,
  cost: TypeNumber({ minimum: 0, maximum: AGENTFLOW_LIMITS.maxCount }),
  costKnown: TypeBoolean(),
  /** Role-specific result count, e.g. "2 findings"; empty when unavailable. */
  outcome: TypeString({ maxLength: AGENTFLOW_LIMITS.maxLabelChars }),
  /** The run's result preview, or its error text when it failed. */
  output: TypeString({ maxLength: AGENTFLOW_LIMITS.maxOutputChars }),
  outputIsError: TypeBoolean(),
  /** Complete role-specific output; null for raw, malformed, partial, or oversized previews. */
  structuredOutput: TypeUnion([AgentflowStructuredOutputSchema, TypeNull()]),
  /** The first node's tool calls; a workflow is described by `nodes` instead. */
  toolCalls: TypeArray(AgentflowToolCallViewSchema, { maxItems: AGENTFLOW_LIMITS.maxToolCalls }),
  omittedToolCalls: CountSchema,
  nodes: TypeArray(AgentflowNodeViewSchema, { maxItems: AGENTFLOW_LIMITS.maxNodes }),
  omittedNodes: CountSchema,
  /** Ordered phase groups over `nodes`; the empty-title group holds the ungrouped ones. */
  phaseGroups: TypeArray(AgentflowPhaseGroupSchema, { maxItems: AGENTFLOW_LIMITS.maxNodes + 1 }),
  logs: TypeArray(TypeString({ maxLength: AGENTFLOW_LIMITS.maxSummaryChars }), {
    maxItems: AGENTFLOW_LIMITS.maxLogLines,
  }),
});
export type AgentflowRunView = Static<typeof AgentflowRunViewSchema>;

type RawRecord = Record<string, unknown>;

function record(value: unknown): RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RawRecord)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const clean = value.replaceAll("\0", "");
  return clean.length > max ? clean.slice(0, max) : clean;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), AGENTFLOW_LIMITS.maxCount);
}

function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, AGENTFLOW_LIMITS.maxCount);
}

function status(value: unknown): AgentflowStatus {
  return value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "aborted" ||
    value === "queued"
    ? value
    : "queued";
}

/** Tool-call snapshots only ever run/complete/fail; map them onto the run union. */
function callStatus(value: unknown): AgentflowStatus {
  return value === "running" || value === "completed" || value === "failed" ? value : "queued";
}

/**
 * Elapsed run time, or 0 when it cannot be established. A run that already
 * finished but carries no completion timestamp has an unknown duration — running
 * it up to `now` would keep growing long after the run ended.
 */
function elapsedMs(node: RawRecord, snapshot: RawRecord, live: boolean, now: number): number {
  const start = Date.parse(
    text(node.startedAt, 64) || text(node.queuedAt, 64) || text(snapshot.createdAt, 64),
  );
  if (!Number.isFinite(start)) return 0;
  const completed = Date.parse(text(node.completedAt, 64) || text(snapshot.completedAt, 64));
  if (Number.isFinite(completed)) return count(completed - start);
  return live ? count(now - start) : 0;
}

type SemanticFieldKind = "markdown" | "plain";

type FinderValue = {
  summary: string;
  findings: Array<{ path: string; range: string; relevance: string }>;
  unresolvedQuestions: string[];
};
type OracleValue = {
  recommendation: string;
  assumptions: string[];
  risks: string[];
  revisitConditions: string[];
};
type LibrarianValue = {
  summary: string;
  sources: Array<{ title: string; url: string; evidence: string }>;
  unresolvedQuestions: string[];
};
type LookAtValue = {
  summary: string;
  observations: string[];
  comparisons: Array<{
    referenceFile: string;
    similarities: string[];
    differences: string[];
  }>;
  uncertainties: string[];
};
type DelegateValue = {
  summary: string;
  filesChanged: string[];
  verification: Array<{ command: string; status: "passed" | "failed" | "not_run"; output: string }>;
  followUps: string[];
};
type ReviewValue = {
  summary: string;
  findings: Array<{
    severity: "critical" | "high" | "medium" | "low";
    path: string;
    location: string;
    explanation: string;
    remediation: string;
  }>;
};

const exactKeys = (value: RawRecord, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const records = <T extends RawRecord>(
  value: unknown,
  validate: (item: RawRecord) => item is T,
): value is T[] => Array.isArray(value) && value.every((item) => validate(record(item)));

const finderValue = (value: unknown): value is FinderValue => {
  const root = record(value);
  const finding = (item: RawRecord): item is FinderValue["findings"][number] =>
    exactKeys(item, ["path", "range", "relevance"]) &&
    typeof item.path === "string" &&
    typeof item.range === "string" &&
    typeof item.relevance === "string";
  return (
    exactKeys(root, ["summary", "findings", "unresolvedQuestions"]) &&
    typeof root.summary === "string" &&
    records(root.findings, finding) &&
    strings(root.unresolvedQuestions)
  );
};
const oracleValue = (value: unknown): value is OracleValue => {
  const root = record(value);
  return (
    exactKeys(root, ["recommendation", "assumptions", "risks", "revisitConditions"]) &&
    typeof root.recommendation === "string" &&
    strings(root.assumptions) &&
    strings(root.risks) &&
    strings(root.revisitConditions)
  );
};
const librarianValue = (value: unknown): value is LibrarianValue => {
  const root = record(value);
  const source = (item: RawRecord): item is LibrarianValue["sources"][number] =>
    exactKeys(item, ["title", "url", "evidence"]) &&
    typeof item.title === "string" &&
    typeof item.url === "string" &&
    typeof item.evidence === "string";
  return (
    exactKeys(root, ["summary", "sources", "unresolvedQuestions"]) &&
    typeof root.summary === "string" &&
    records(root.sources, source) &&
    strings(root.unresolvedQuestions)
  );
};
const lookAtValue = (value: unknown): value is LookAtValue => {
  const root = record(value);
  const comparison = (item: RawRecord): item is LookAtValue["comparisons"][number] =>
    exactKeys(item, ["referenceFile", "similarities", "differences"]) &&
    typeof item.referenceFile === "string" &&
    strings(item.similarities) &&
    strings(item.differences);
  return (
    exactKeys(root, ["summary", "observations", "comparisons", "uncertainties"]) &&
    typeof root.summary === "string" &&
    strings(root.observations) &&
    records(root.comparisons, comparison) &&
    strings(root.uncertainties)
  );
};
const delegateValue = (value: unknown): value is DelegateValue => {
  const root = record(value);
  const verification = (item: RawRecord): item is DelegateValue["verification"][number] =>
    exactKeys(item, ["command", "status", "output"]) &&
    typeof item.command === "string" &&
    (item.status === "passed" || item.status === "failed" || item.status === "not_run") &&
    typeof item.output === "string";
  return (
    exactKeys(root, ["summary", "filesChanged", "verification", "followUps"]) &&
    typeof root.summary === "string" &&
    strings(root.filesChanged) &&
    records(root.verification, verification) &&
    strings(root.followUps)
  );
};
const reviewValue = (value: unknown): value is ReviewValue => {
  const root = record(value);
  const finding = (item: RawRecord): item is ReviewValue["findings"][number] =>
    exactKeys(item, ["severity", "path", "location", "explanation", "remediation"]) &&
    (item.severity === "critical" ||
      item.severity === "high" ||
      item.severity === "medium" ||
      item.severity === "low") &&
    typeof item.path === "string" &&
    typeof item.location === "string" &&
    typeof item.explanation === "string" &&
    typeof item.remediation === "string";
  return (
    exactKeys(root, ["summary", "findings"]) &&
    typeof root.summary === "string" &&
    records(root.findings, finding)
  );
};

const semanticField = (
  label: string,
  kind: SemanticFieldKind,
  value: string | readonly string[],
): AgentflowStructuredField => ({
  label,
  kind,
  values: typeof value === "string" ? [value] : [...value],
});
const semanticSection = (
  label: string,
  fields: AgentflowStructuredField[] = [],
  items: AgentflowStructuredItem[] = [],
): AgentflowStructuredSection => ({ label, fields, items });

/** Reject hostile exact results before validating every nested role property. */
function withinSemanticBounds(value: unknown): boolean {
  let characters = 0;
  let visited = 0;
  const seen = new WeakSet<object>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length) {
    const current = pending.pop();
    if (!current || current.depth > 8 || ++visited > 512) return false;
    if (typeof current.value === "string") {
      characters += current.value.length;
      if (characters > AGENTFLOW_LIMITS.maxOutputChars) return false;
    } else if (typeof current.value === "object" && current.value !== null) {
      if (seen.has(current.value)) return false;
      seen.add(current.value);
      if (Array.isArray(current.value)) {
        if (current.value.length > 64) return false;
        for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
      } else {
        const entries = Object.entries(current.value);
        if (entries.length > 16) return false;
        for (const [, item] of entries) pending.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
  return true;
}

/** Decode every property only when the complete role schema is present. */
function structuredOutputFor(role: string, candidate: unknown): AgentflowStructuredOutput | null {
  let value = candidate;
  if (typeof candidate === "string") {
    if (candidate.length > AGENTFLOW_LIMITS.maxOutputChars) return null;
    try {
      value = JSON.parse(candidate);
    } catch {
      // Streamed and bounded previews routinely end in the middle of JSON.
      return null;
    }
  }
  if (!withinSemanticBounds(value)) return null;

  let sections: AgentflowStructuredSection[];
  if (role === "finder" && finderValue(value))
    sections = [
      semanticSection("Summary", [semanticField("", "markdown", value.summary)]),
      semanticSection(
        "Findings",
        [],
        value.findings.map((finding, index) => ({
          label: `Finding ${index + 1}`,
          fields: [
            semanticField("Path", "plain", finding.path),
            semanticField("Range", "plain", finding.range),
            semanticField("Relevance", "markdown", finding.relevance),
          ],
        })),
      ),
      semanticSection("Unresolved questions", [
        semanticField("", "markdown", value.unresolvedQuestions),
      ]),
    ];
  else if (role === "oracle" && oracleValue(value))
    sections = [
      semanticSection("Recommendation", [semanticField("", "markdown", value.recommendation)]),
      semanticSection("Assumptions", [semanticField("", "markdown", value.assumptions)]),
      semanticSection("Risks", [semanticField("", "markdown", value.risks)]),
      semanticSection("Revisit conditions", [
        semanticField("", "markdown", value.revisitConditions),
      ]),
    ];
  else if (role === "librarian" && librarianValue(value))
    sections = [
      semanticSection("Summary", [semanticField("", "markdown", value.summary)]),
      semanticSection(
        "Sources",
        [],
        value.sources.map((source, index) => ({
          label: `Source ${index + 1}`,
          fields: [
            semanticField("Title", "plain", source.title),
            semanticField("URL", "plain", source.url),
            semanticField("Evidence", "markdown", source.evidence),
          ],
        })),
      ),
      semanticSection("Unresolved questions", [
        semanticField("", "markdown", value.unresolvedQuestions),
      ]),
    ];
  else if (role === "look_at" && lookAtValue(value))
    sections = [
      semanticSection("Summary", [semanticField("", "markdown", value.summary)]),
      semanticSection("Observations", [semanticField("", "markdown", value.observations)]),
      semanticSection(
        "Comparisons",
        [],
        value.comparisons.map((comparison, index) => ({
          label: `Comparison ${index + 1}`,
          fields: [
            semanticField("Reference file", "plain", comparison.referenceFile),
            semanticField("Similarities", "markdown", comparison.similarities),
            semanticField("Differences", "markdown", comparison.differences),
          ],
        })),
      ),
      semanticSection("Uncertainties", [semanticField("", "markdown", value.uncertainties)]),
    ];
  else if (role === "delegate" && delegateValue(value))
    sections = [
      semanticSection("Summary", [semanticField("", "markdown", value.summary)]),
      semanticSection("Files changed", [semanticField("", "plain", value.filesChanged)]),
      semanticSection(
        "Verification",
        [],
        value.verification.map((verification, index) => ({
          label: `Check ${index + 1}`,
          fields: [
            semanticField("Command", "plain", verification.command),
            semanticField("Status", "plain", verification.status),
            semanticField("Output", "plain", verification.output),
          ],
        })),
      ),
      semanticSection("Follow-ups", [semanticField("", "markdown", value.followUps)]),
    ];
  else if (role === "review" && reviewValue(value))
    sections = [
      semanticSection("Summary", [semanticField("", "markdown", value.summary)]),
      semanticSection(
        "Findings",
        [],
        value.findings.map((finding, index) => ({
          label: `Finding ${index + 1}`,
          fields: [
            semanticField("Severity", "plain", finding.severity),
            semanticField("Path", "plain", finding.path),
            semanticField("Location", "plain", finding.location),
            semanticField("Explanation", "markdown", finding.explanation),
            semanticField("Remediation", "markdown", finding.remediation),
          ],
        })),
      ),
    ];
  else return null;

  const output = { sections };
  return Check(AgentflowStructuredOutputSchema, output) ? output : null;
}

/** Role-specific result count read from the child's (possibly partial) JSON preview. */
function outcomeFor(role: string, preview: string): string {
  if (!preview) return "";
  let value: RawRecord;
  try {
    value = record(JSON.parse(preview));
  } catch {
    // Streamed previews are commonly incomplete JSON.
    return "";
  }
  const plural = (items: unknown, noun: string) =>
    Array.isArray(items) ? `${items.length} ${noun}${items.length === 1 ? "" : "s"}` : "";
  if (role === "finder" || role === "review") return plural(value.findings, "finding");
  if (role === "librarian") return plural(value.sources, "source");
  if (role === "look_at") return plural(value.observations, "observation");
  if (role === "delegate") return plural(value.filesChanged, "file");
  if (role === "oracle") return typeof value.recommendation === "string" ? "recommendation" : "";
  return "";
}

function roleFor(snapshot: RawRecord, node: RawRecord): string {
  const originTool = text(snapshot.originTool, AGENTFLOW_LIMITS.maxLabelChars);
  return (
    text(snapshot.semanticRole, AGENTFLOW_LIMITS.maxLabelChars) ||
    text(node.semanticRole, AGENTFLOW_LIMITS.maxLabelChars) ||
    text(snapshot.name, AGENTFLOW_LIMITS.maxLabelChars) ||
    originTool.replace(/^agentflow_/, "") ||
    text(snapshot.kind, AGENTFLOW_LIMITS.maxLabelChars)
  );
}

function decodeToolCalls(
  node: RawRecord,
  max: number,
): {
  toolCalls: AgentflowToolCallView[];
  omitted: number;
} {
  const raw = array(node.toolCalls);
  const kept = raw.slice(-max);
  return {
    omitted: count(raw.length - kept.length),
    toolCalls: kept.map((item, index) => {
      const call = record(item);
      return {
        id: text(call.id, AGENTFLOW_LIMITS.maxIdChars) || `call-${index}`,
        name: text(call.name, AGENTFLOW_LIMITS.maxLabelChars) || "tool",
        status: callStatus(call.status),
        argumentSummary: text(call.argumentSummary, AGENTFLOW_LIMITS.maxSummaryChars),
        argumentsPreview: text(call.argumentsPreview, AGENTFLOW_LIMITS.maxSummaryChars),
        resultPreview: text(call.resultPreview, AGENTFLOW_LIMITS.maxSummaryChars),
        error: text(call.error, AGENTFLOW_LIMITS.maxSummaryChars),
      };
    }),
  };
}

/** The start/end instants a node's elapsed time spans, in ms; `undefined` when unknown. */
interface NodeTiming {
  startMs?: number;
  endMs?: number;
}

/**
 * A node's own timing. Its span opens at the first timestamp it has and closes at its
 * completion, or at `now` while it is still going — the same rule the run uses, so a
 * finished node with no completion timestamp reports an unknown (0) duration rather than
 * one that grows forever.
 */
function nodeTiming(node: RawRecord, live: boolean, now: number): NodeTiming {
  const start = Date.parse(
    text(node.startedAt, 64) || text(node.queuedAt, 64) || text(node.createdAt, 64),
  );
  const startMs = Number.isFinite(start) ? start : undefined;
  const completed = Date.parse(text(node.completedAt, 64));
  const endMs = Number.isFinite(completed) ? completed : live ? now : undefined;
  return { startMs, endMs };
}

const spanMs = (timing: NodeTiming): number =>
  timing.startMs !== undefined && timing.endMs !== undefined
    ? count(timing.endMs - timing.startMs)
    : 0;

function decodeNodes(
  snapshot: RawRecord,
  now: number,
  allowOpenTiming: boolean,
): { nodes: AgentflowNodeView[]; omitted: number; timings: NodeTiming[] } {
  const raw = array(snapshot.nodes);
  const firstKeptIndex = Math.max(0, raw.length - AGENTFLOW_LIMITS.maxNodes);
  const kept = raw.slice(firstKeptIndex);
  const timings: NodeTiming[] = [];
  const usedIds = new Set<string>();
  return {
    omitted: count(raw.length - kept.length),
    timings,
    nodes: kept.map((item, offset) => {
      const index = firstKeptIndex + offset;
      const node = record(item);
      const usage = record(node.usage);
      const nodeStatus = status(node.status);
      const live = allowOpenTiming && (nodeStatus === "queued" || nodeStatus === "running");
      const timing = nodeTiming(node, live, now);
      timings.push(timing);
      const { toolCalls, omitted } = decodeToolCalls(node, AGENTFLOW_LIMITS.maxNodeToolCalls);
      const requestedId = text(node.id, AGENTFLOW_LIMITS.maxIdChars) || `node-${index}`;
      let id = requestedId;
      let discriminator = index;
      while (usedIds.has(id)) {
        const suffix = `-${discriminator++}`;
        id = `${requestedId.slice(0, AGENTFLOW_LIMITS.maxIdChars - suffix.length)}${suffix}`;
      }
      usedIds.add(id);
      return {
        id,
        label: text(node.label, AGENTFLOW_LIMITS.maxLabelChars) || `node ${index + 1}`,
        phase: text(node.phase, AGENTFLOW_LIMITS.maxLabelChars),
        status: nodeStatus,
        backend: text(node.backend, AGENTFLOW_LIMITS.maxLabelChars),
        model: text(node.model, AGENTFLOW_LIMITS.maxLabelChars),
        prompt: text(node.prompt, AGENTFLOW_LIMITS.maxPromptChars),
        elapsedMs: spanMs(timing),
        tools: count(node.tools),
        tokens: count(usage.total),
        cost: amount(usage.cost),
        costKnown: usage.costKnown !== false,
        toolCalls,
        omittedToolCalls: omitted,
      };
    }),
  };
}

/**
 * A phase's status, derived from its nodes: a failure anywhere fails it, anything running
 * (or a mix of queued and completed) leaves it running, all-queued is queued, and only
 * once every node has settled without failing is it completed (or aborted).
 */
function derivePhaseStatus(statuses: readonly AgentflowStatus[]): AgentflowStatus {
  if (statuses.some((value) => value === "failed")) return "failed";
  if (statuses.some((value) => value === "running")) return "running";
  const queued = statuses.some((value) => value === "queued");
  const completed = statuses.some((value) => value === "completed");
  if (queued) return completed ? "running" : "queued";
  if (statuses.some((value) => value === "aborted")) return "aborted";
  return "completed";
}

/** A phase's elapsed time: its earliest node start to its latest node end. */
function phaseElapsed(timings: readonly NodeTiming[]): number {
  const starts = timings
    .map((timing) => timing.startMs)
    .filter((value): value is number => value !== undefined);
  const ends = timings
    .map((timing) => timing.endMs)
    .filter((value): value is number => value !== undefined);
  if (!starts.length || !ends.length) return 0;
  return count(Math.max(...ends) - Math.min(...starts));
}

/**
 * Group nodes by their declared phase. Phase order follows the run's declared `phases`
 * when it has them, otherwise the order the phases first appear on the nodes; a node whose
 * phase is empty or not among those titles falls into the trailing ungrouped bucket.
 */
function decodePhaseGroups(
  declaredPhases: readonly string[],
  nodes: readonly AgentflowNodeView[],
  timings: readonly NodeTiming[],
): AgentflowPhaseGroup[] {
  const titles = declaredPhases.length
    ? [...new Set(declaredPhases)].slice(0, AGENTFLOW_LIMITS.maxNodes)
    : [...new Set(nodes.map((node) => node.phase).filter(Boolean))];
  const titleSet = new Set(titles);
  const grouped = new Map<string, Array<{ node: AgentflowNodeView; timing: NodeTiming }>>(
    titles.map((title) => [title, []]),
  );
  grouped.set("", []);
  nodes.forEach((node, index) => {
    const key = node.phase && titleSet.has(node.phase) ? node.phase : "";
    grouped.get(key)?.push({ node, timing: timings[index] ?? {} });
  });
  const groups: AgentflowPhaseGroup[] = [];
  for (const title of [...titles, ""]) {
    const members = grouped.get(title) ?? [];
    if (!members.length) continue;
    groups.push({
      title,
      status: derivePhaseStatus(members.map((entry) => entry.node.status)),
      elapsedMs: phaseElapsed(members.map((entry) => entry.timing)),
      nodeIds: members.map((entry) => entry.node.id),
    });
  }
  return groups;
}

/**
 * Normalize one run snapshot. A semantic or single-agent run carries exactly one
 * node, whose fields stand in for the run itself; a workflow carries several, and
 * its own progress is the node list. Usage is summed over every node either way,
 * which reduces to the single node's usage for the one-node case.
 */
function decodeRun(value: unknown, now: number): AgentflowRunView {
  // `agentflow_wait` and `agentflow_cancel` wrap each snapshot in a RunResult.
  const wrapper = record(value);
  const snapshot = record(wrapper.snapshot ?? wrapper);
  const rawNodes = array(snapshot.nodes);
  const node = record(rawNodes[0]);
  const workflow = snapshot.kind === "workflow" || rawNodes.length > 1;
  // A workflow's own status is authoritative; a single-node run reports progress on
  // the node before the run snapshot catches up, matching the TUI renderer.
  const runStatus = workflow ? status(snapshot.status) : status(node.status ?? snapshot.status);
  const role = roleFor(snapshot, node);
  const resultPreview = text(
    (typeof wrapper.result === "string" ? wrapper.result : undefined) ??
      snapshot.resultPreview ??
      node.resultPreview,
    AGENTFLOW_LIMITS.maxOutputChars,
  );
  const error = text(
    node.error ?? wrapper.error ?? snapshot.error,
    AGENTFLOW_LIMITS.maxOutputChars,
  );
  const { toolCalls, omitted } = decodeToolCalls(node, AGENTFLOW_LIMITS.maxToolCalls);
  const live = runStatus === "queued" || runStatus === "running";
  const allowOpenTiming = !(snapshot.background === true && live);
  const { nodes, omitted: omittedNodes, timings } = decodeNodes(snapshot, now, allowOpenTiming);
  const usages = rawNodes.map((item) => record(record(item).usage));
  const declaredPhases = [
    ...new Set(
      array(snapshot.phases)
        .slice(0, AGENTFLOW_LIMITS.maxNodes)
        .map((phase) => text(phase, AGENTFLOW_LIMITS.maxLabelChars))
        .filter(Boolean),
    ),
  ];
  return {
    runId: text(snapshot.runId, AGENTFLOW_LIMITS.maxIdChars),
    kind: workflow ? "workflow" : "agent",
    role,
    status: runStatus,
    background: snapshot.background === true,
    live,
    prompt: text(node.prompt, AGENTFLOW_LIMITS.maxPromptChars),
    cwd: text(node.cwd, AGENTFLOW_LIMITS.maxPathChars),
    backend: text(node.backend, AGENTFLOW_LIMITS.maxLabelChars),
    model: text(node.model, AGENTFLOW_LIMITS.maxLabelChars),
    sessionFile: text(node.sessionFile, AGENTFLOW_LIMITS.maxPathChars),
    artifactDir: text(snapshot.artifactDir, AGENTFLOW_LIMITS.maxPathChars),
    phases: declaredPhases.join(" → ").slice(0, AGENTFLOW_LIMITS.maxSummaryChars),
    elapsedMs: elapsedMs(node, snapshot, live, now),
    tools: count(rawNodes.reduce<number>((total, item) => total + count(record(item).tools), 0)),
    tokens: count(usages.reduce((total, usage) => total + count(usage.total), 0)),
    cost: amount(usages.reduce((total, usage) => total + amount(usage.cost), 0)),
    costKnown: usages.every((usage) => usage.costKnown !== false),
    outcome: outcomeFor(role, resultPreview),
    output: error || resultPreview,
    outputIsError: Boolean(error),
    structuredOutput: error ? null : structuredOutputFor(role, wrapper.result ?? resultPreview),
    toolCalls,
    omittedToolCalls: omitted,
    nodes,
    omittedNodes,
    phaseGroups: decodePhaseGroups(declaredPhases, nodes, timings),
    logs: array(snapshot.logs)
      .map((line) => text(line, AGENTFLOW_LIMITS.maxSummaryChars))
      .filter(Boolean)
      .slice(-AGENTFLOW_LIMITS.maxLogLines),
  };
}

function isRunView(value: unknown): value is AgentflowRunView {
  return Check(AgentflowRunViewSchema, value);
}

/**
 * Read the run snapshots out of an Agentflow tool result. Total: unreadable or
 * malformed details yield an empty list, and the caller falls back to the tool's
 * own text. `now` is injectable so elapsed times stay deterministic in tests.
 */
/**
 * `agentflow_steer` answers with the node it reached rather than a run snapshot.
 * Returns the node id, "" when the acknowledgement carries none, or null when the
 * details are unreadable and the caller should fall back to the tool's own text.
 */
export function decodeAgentflowSteerAck(result: unknown): string | null {
  const details = record(result).details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) return null;
  return text((details as RawRecord).nodeId, AGENTFLOW_LIMITS.maxIdChars);
}

/**
 * The moment a control tool recorded its observation, when it recorded one.
 *
 * `agentflow_status`/`wait`/`cancel` report runs they did not launch, so their rows are an
 * observation made at a fixed moment and their elapsed times must not keep growing after it.
 * The extension puts that moment in the details; a caller passes it to `decodeAgentflowRunViews`
 * as `now`, and knows from its absence that the rows are free to tick.
 */
export function decodeAgentflowObservedAt(result: unknown): number | undefined {
  const observedAt = record(record(result).details).observedAt;
  return typeof observedAt === "number" && Number.isFinite(observedAt) ? observedAt : undefined;
}

export function decodeAgentflowRunViews(
  toolName: string,
  result: unknown,
  now: number = Date.now(),
): AgentflowRunView[] {
  try {
    const details = record(record(result).details);
    let raw: unknown[] = [];
    if (toolName === "agentflow_wait") raw = array(details.results);
    else if (toolName === "agentflow_cancel") raw = array(details.snapshots);
    else if (Array.isArray(details.snapshot)) raw = details.snapshot;
    else if (Object.keys(record(details.snapshot)).length) raw = [details];
    return raw
      .slice(0, AGENTFLOW_LIMITS.maxRuns)
      .map((item) => decodeRun(item, now))
      .filter(isRunView);
  } catch {
    return [];
  }
}
