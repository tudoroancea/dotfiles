import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

export type RunKind = "agent" | "workflow";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "aborted";
export type NodeStatus = RunStatus;
export type SemanticRole = "finder" | "oracle" | "librarian" | "look_at" | "delegate" | "review";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type JsonSchemaObject = TSchema;

export interface ChildSessionConfig {
  mode?: "memory" | "file" | "existing";
  file?: string;
  name?: string;
  inheritParentContext?: boolean;
}
export interface SubagentConfig {
  systemPrompt?: string;
  appendSystemPrompt?: string;
  usePiSystemPrompt?: boolean;
  model?: string;
  inheritModelProvider?: boolean;
  thinking?: ThinkingLevel;
  tools?: string[] | false;
  skills?: string[] | false;
  extensions?: string[] | false;
  extensionMode?: "print" | "rpc";
  cwd?: string;
  session?: ChildSessionConfig;
  outputSchema?: JsonSchemaObject;
  timeoutMs?: number;
  toolTimeoutMs?: number;
  trustProject?: boolean;
}
export interface AgentNodeSpec {
  id: string;
  label: string;
  prompt: string;
  claude?: true;
  phase?: string;
  dependsOn?: string[];
  originTool?: string;
  semanticRole?: SemanticRole;
  config?: SubagentConfig;
}
export interface RunLimits {
  maxAgents?: number;
  concurrency?: number;
  timeoutMs?: number;
  tokenBudget?: number;
}
export interface UsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}
export interface ToolCallSnapshot {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  argumentSummary: string;
  argumentsPreview?: string;
  resultPreview?: string;
  error?: string;
}
export interface NodeSnapshot {
  id: string;
  label: string;
  phase?: string;
  dependsOn?: string[];
  originTool?: string;
  semanticRole?: SemanticRole;
  backend?: "claude";
  model?: string;
  prompt: string;
  cwd: string;
  status: NodeStatus;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  resultPreview?: string;
  error?: string;
  sessionFile?: string;
  tools: number;
  toolCalls: ToolCallSnapshot[];
  usage: UsageSnapshot;
}
export interface RunSnapshot {
  runId: string;
  kind: RunKind;
  name?: string;
  description?: string;
  originTool?: string;
  semanticRole?: SemanticRole;
  status: RunStatus;
  createdAt: string;
  completedAt?: string;
  phases: string[];
  currentPhase?: string;
  nodes: NodeSnapshot[];
  logs: string[];
  resultPreview?: string;
  error?: string;
  artifactDir?: string;
  background?: boolean;
}
export interface RunResult {
  runId: string;
  status: RunStatus;
  result?: unknown;
  error?: string;
  snapshot: RunSnapshot;
}
export interface ChildControl {
  abort(): Promise<void>;
  steer?(message: string): Promise<void>;
  readonly isStreaming?: boolean;
}
export interface LiveRun {
  snapshot: RunSnapshot;
  controls: Map<string, ChildControl>;
  controller: AbortController;
  context?: ExtensionContext;
  notify?: (snapshot: RunSnapshot) => void;
  result?: RunResult;
  completion: Promise<RunResult>;
  resolveCompletion: (result: RunResult) => void;
  consumed: boolean;
  deliveryTimer?: NodeJS.Timeout;
}
export interface ChildExecutionResult {
  text: string;
  structured?: unknown;
  sessionFile?: string;
  usage: UsageSnapshot;
}
export interface AgentTaskResult {
  ok: boolean;
  output: string;
  structured?: unknown;
  error?: string;
  aborted: boolean;
  sessionFile?: string;
  usage: UsageSnapshot;
}
