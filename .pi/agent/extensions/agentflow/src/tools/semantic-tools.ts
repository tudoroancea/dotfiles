import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { SemanticAgentService } from "../semantic/semantic-agent-service.ts";
import {
  DelegateInputSchema,
  FinderInputSchema,
  LibrarianInputSchema,
  LookAtInputSchema,
  OracleInputSchema,
  ReviewInputSchema,
} from "../semantic/profiles.ts";
import type { SemanticRole } from "../types.ts";
import { formatPrompt } from "../ui/formatters.ts";
import { renderSemanticSnapshot } from "../ui/semantic-renderer.ts";
import { runCostDetails, truncateToolText } from "../utils.ts";

const definitions: Array<{
  role: SemanticRole;
  description: string;
  guideline: string;
  schema: TSchema;
}> = [
  {
    role: "finder",
    description:
      "Explore the local repository conceptually and return a compressed map with paths and line ranges.",
    guideline:
      "Use agentflow_finder for repository exploration when you need to locate concepts, implementations, or cross-file relationships; use read directly for files whose locations are already known.",
    schema: FinderInputSchema,
  },
  {
    role: "oracle",
    description:
      "Get an independent high-reasoning technical recommendation grounded in selective repository inspection.",
    guideline:
      "Only use agentflow_oracle for complex architecture, planning, or debugging that benefits from an independent high-reasoning opinion; treat its recommendation as advisory.",
    schema: OracleInputSchema,
  },
  {
    role: "librarian",
    description:
      "Research remote documentation, GitHub, and cross-repository sources with citations.",
    guideline:
      "Only use agentflow_librarian for remote documentation, GitHub, or cross-repository research.",
    schema: LibrarianInputSchema,
  },
  {
    role: "look_at",
    description:
      "Analyze a local image or other file for a specific objective, optionally comparing it with reference files.",
    guideline:
      "Use agentflow_look_at for objective-focused visual or file analysis, especially images, diagrams, and systematic reference comparisons; use read directly when literal text contents are sufficient.",
    schema: LookAtInputSchema,
  },
  {
    role: "delegate",
    description:
      "Execute a stable bounded implementation task with explicit ownership, acceptance criteria, and verification.",
    guideline:
      "Only use agentflow_delegate for stable, independent implementation work with explicit ownership, acceptance criteria, and verification; do not use it for small sequential changes.",
    schema: DelegateInputSchema,
  },
  {
    role: "review",
    description:
      "Review a stable integrated diff and return structured actionable findings without mutation.",
    guideline: "Only use agentflow_review after the integrated diff is stable enough to review.",
    schema: ReviewInputSchema,
  },
];

export function registerSemanticTools(pi: ExtensionAPI, service: SemanticAgentService): void {
  for (const definition of definitions) {
    const toolName = `agentflow_${definition.role}`;
    pi.registerTool({
      name: toolName,
      label: `Agentflow ${definition.role}`,
      description: definition.description,
      promptSnippet: definition.description,
      promptGuidelines: [definition.guideline],
      parameters: definition.schema,
      async execute(_id: any, params: any, signal: any, onUpdate: any, ctx: any) {
        const background = params.mode === "background";
        const result = await service.launch(definition.role, params, ctx, {
          background,
          signal,
          onUpdate: (snapshot) =>
            onUpdate?.({
              content: [
                { type: "text", text: snapshot.nodes[0]?.resultPreview ?? `${snapshot.status}…` },
              ],
              details: { snapshot },
            }),
        });
        if (background)
          return {
            content: [
              {
                type: "text" as const,
                text: `Background ${definition.role} started: ${result.runId}.`,
              },
            ],
            details: result,
          };
        if ("status" in result && result.status !== "completed")
          throw new Error(result.error ?? `${definition.role} ${result.status}`);
        const value = "result" in result ? result.result : undefined;
        return {
          content: [
            {
              type: "text" as const,
              text: truncateToolText(JSON.stringify(value, null, 2) ?? "null"),
            },
          ],
          details: { ...result, ...runCostDetails(result.snapshot) },
        };
      },
      renderCall(args: any, theme: any) {
        if (definition.role === "look_at") {
          const references = Array.isArray(args.referenceFiles) ? args.referenceFiles.length : 0;
          return new Text(
            `${theme.fg("toolTitle", theme.bold("look_at "))}${theme.fg("dim", String(args.path ?? "…").slice(0, 80))}${args.objective ? theme.fg("muted", ` — ${String(args.objective).slice(0, 60)}`) : ""}${references ? theme.fg("muted", ` (+${references} ref${references === 1 ? "" : "s"})`) : ""}`,
            0,
            0,
          );
        }
        const task = args.task ?? args.question ?? "Review integrated diff";
        return new Text(
          `${theme.fg("toolTitle", theme.bold(`${definition.role} `))}${theme.fg("dim", formatPrompt(String(task)).slice(0, 120))}`,
          0,
          0,
        );
      },
      renderResult(result: any, options: any, theme: any) {
        const snapshot = (result.details as any)?.snapshot;
        if (!snapshot)
          return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
        return renderSemanticSnapshot(
          snapshot,
          { role: definition.role, expanded: options.expanded },
          theme,
        );
      },
    } as any);
  }
}
