import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import type { SemanticRole, ThinkingLevel } from "../types.ts";

const strict = { additionalProperties: false } as const;
const mode = StringEnum(["foreground", "background"] as const);

export const FinderInputSchema = Type.Object(
  {
    task: Type.String({ minLength: 1 }),
    paths: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
    mode: Type.Optional(mode),
  },
  strict,
);
export const OracleInputSchema = Type.Object(
  {
    question: Type.String({ minLength: 1 }),
    files: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
    mode: Type.Optional(mode),
  },
  strict,
);
export const LibrarianInputSchema = Type.Object(
  {
    question: Type.String({ minLength: 1 }),
    mode: Type.Optional(mode),
  },
  strict,
);
export const LookAtInputSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 4096 }),
    objective: Type.String({ minLength: 1, maxLength: 16_384 }),
    context: Type.Optional(Type.String({ minLength: 1, maxLength: 16_384 })),
    referenceFiles: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 32 }),
    ),
    mode: Type.Optional(mode),
  },
  strict,
);
export const DelegateInputSchema = Type.Object(
  {
    task: Type.String({ minLength: 1 }),
    ownership: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 64 }),
    acceptanceCriteria: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 64,
    }),
    verificationCommands: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 32,
    }),
    continuationSessionFile: Type.Optional(Type.String({ minLength: 1 })),
    mode: Type.Optional(mode),
  },
  strict,
);
export const ReviewInputSchema = Type.Object(
  {
    task: Type.Optional(Type.String({ minLength: 1 })),
    base: Type.Optional(Type.String({ minLength: 1 })),
    paths: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
    mode: Type.Optional(mode),
  },
  strict,
);

const finding = Type.Object(
  {
    path: Type.String(),
    range: Type.String(),
    relevance: Type.String(),
  },
  strict,
);
export const FinderOutputSchema = Type.Object(
  {
    summary: Type.String(),
    findings: Type.Array(finding),
    unresolvedQuestions: Type.Array(Type.String()),
  },
  strict,
);
export const OracleOutputSchema = Type.Object(
  {
    recommendation: Type.String(),
    assumptions: Type.Array(Type.String()),
    risks: Type.Array(Type.String()),
    revisitConditions: Type.Array(Type.String()),
  },
  strict,
);
export const LibrarianOutputSchema = Type.Object(
  {
    summary: Type.String(),
    sources: Type.Array(
      Type.Object({ title: Type.String(), url: Type.String(), evidence: Type.String() }, strict),
    ),
    unresolvedQuestions: Type.Array(Type.String()),
  },
  strict,
);
export const LookAtOutputSchema = Type.Object(
  {
    summary: Type.String(),
    observations: Type.Array(Type.String()),
    comparisons: Type.Array(
      Type.Object(
        {
          referenceFile: Type.String(),
          similarities: Type.Array(Type.String()),
          differences: Type.Array(Type.String()),
        },
        strict,
      ),
    ),
    uncertainties: Type.Array(Type.String()),
  },
  strict,
);
export const DelegateOutputSchema = Type.Object(
  {
    summary: Type.String(),
    filesChanged: Type.Array(Type.String()),
    verification: Type.Array(
      Type.Object(
        {
          command: Type.String(),
          status: StringEnum(["passed", "failed", "not_run"] as const),
          output: Type.String(),
        },
        strict,
      ),
    ),
    followUps: Type.Array(Type.String()),
  },
  strict,
);
export const ReviewOutputSchema = Type.Object(
  {
    summary: Type.String(),
    findings: Type.Array(
      Type.Object(
        {
          severity: StringEnum(["critical", "high", "medium", "low"] as const),
          path: Type.String(),
          location: Type.String(),
          explanation: Type.String(),
          remediation: Type.String(),
        },
        strict,
      ),
    ),
  },
  strict,
);

export type FinderInput = Static<typeof FinderInputSchema>;
export type OracleInput = Static<typeof OracleInputSchema>;
export type LibrarianInput = Static<typeof LibrarianInputSchema>;
export type LookAtInput = Static<typeof LookAtInputSchema>;
export type DelegateInput = Static<typeof DelegateInputSchema>;
export type ReviewInput = Static<typeof ReviewInputSchema>;
export type SemanticInput =
  | FinderInput
  | OracleInput
  | LibrarianInput
  | LookAtInput
  | DelegateInput
  | ReviewInput;

export interface SemanticProfile {
  role: SemanticRole;
  inputSchema: TSchema;
  outputSchema: TSchema;
  tools: readonly string[];
  modelId?: string;
  thinking: ThinkingLevel;
  promptAsset: string;
  mutates: boolean;
  timeoutMs: number;
}

export const semanticProfiles: Record<SemanticRole, SemanticProfile> = {
  finder: {
    role: "finder",
    inputSchema: FinderInputSchema,
    outputSchema: FinderOutputSchema,
    tools: ["read", "grep", "find"],
    modelId: "gpt-5.6-luna",
    thinking: "low",
    promptAsset: "finder.md",
    mutates: false,
    timeoutMs: 120_000,
  },
  oracle: {
    role: "oracle",
    inputSchema: OracleInputSchema,
    outputSchema: OracleOutputSchema,
    tools: ["read", "grep", "find", "git_inspect"],
    modelId: "gpt-5.6-sol",
    thinking: "xhigh",
    promptAsset: "oracle.md",
    mutates: false,
    timeoutMs: 300_000,
  },
  librarian: {
    role: "librarian",
    inputSchema: LibrarianInputSchema,
    outputSchema: LibrarianOutputSchema,
    tools: ["web_search", "fetch_content", "get_search_content"],
    modelId: "gpt-5.6-sol",
    thinking: "low",
    promptAsset: "librarian.md",
    mutates: false,
    timeoutMs: 300_000,
  },
  look_at: {
    role: "look_at",
    inputSchema: LookAtInputSchema,
    outputSchema: LookAtOutputSchema,
    tools: ["read"],
    modelId: "gpt-5.6-luna",
    thinking: "low",
    promptAsset: "look_at.md",
    mutates: false,
    timeoutMs: 120_000,
  },
  delegate: {
    role: "delegate",
    inputSchema: DelegateInputSchema,
    outputSchema: DelegateOutputSchema,
    tools: ["read", "bash", "edit", "write", "grep", "find"],
    thinking: "medium",
    promptAsset: "delegate.md",
    mutates: true,
    timeoutMs: 600_000,
  },
  review: {
    role: "review",
    inputSchema: ReviewInputSchema,
    outputSchema: ReviewOutputSchema,
    tools: ["read", "grep", "find", "git_inspect"],
    modelId: "gpt-5.6-sol",
    thinking: "xhigh",
    promptAsset: "review.md",
    mutates: false,
    timeoutMs: 300_000,
  },
};

export function validateSemanticInput(role: SemanticRole, value: unknown): SemanticInput {
  const schema = semanticProfiles[role].inputSchema;
  if (Check(schema, value)) return value as SemanticInput;
  const issue = [...Errors(schema, value)][0];
  throw new Error(`Invalid ${role} input${issue ? `: ${issue.message}` : ""}`);
}
