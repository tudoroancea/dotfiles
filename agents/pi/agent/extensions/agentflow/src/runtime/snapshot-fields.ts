export const MAX_SNAPSHOT_PROMPT_CHARS = 16_384;
export const MAX_SNAPSHOT_CWD_CHARS = 4_096;

const bound = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

export const boundInitialPrompt = (prompt: string): string =>
  bound(prompt.replaceAll("\r\n", "\n").replaceAll("\r", "\n"), MAX_SNAPSHOT_PROMPT_CHARS);

export const boundEffectiveCwd = (cwd: string): string => bound(cwd, MAX_SNAPSHOT_CWD_CHARS);
