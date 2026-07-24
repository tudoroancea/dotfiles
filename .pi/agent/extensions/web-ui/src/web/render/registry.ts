import { agentflowAdapters } from "./agentflow.js";
import { backgroundAdapters } from "./background.js";
import {
  bashAdapter,
  editAdapter,
  findAdapter,
  grepAdapter,
  lsAdapter,
  readAdapter,
  writeAdapter,
} from "./builtins.js";
import { genericAdapter } from "./generic.js";
import { questionnaireAdapter } from "./questionnaire.js";
import type { ToolAdapter } from "./types.js";

const REGISTRY: Record<string, ToolAdapter> = {
  bash: bashAdapter,
  edit: editAdapter,
  write: writeAdapter,
  read: readAdapter,
  grep: grepAdapter,
  find: findAdapter,
  ls: lsAdapter,
  questionnaire: questionnaireAdapter,
  ...agentflowAdapters,
  ...backgroundAdapters,
};

/** Look up the adapter for a tool, falling back to the safe generic renderer. */
export function resolveAdapter(name: string): ToolAdapter {
  return REGISTRY[name] ?? genericAdapter;
}

export function hasAdapter(name: string): boolean {
  return name in REGISTRY;
}
