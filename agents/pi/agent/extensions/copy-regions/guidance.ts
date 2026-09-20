export const COPY_REGIONS_SYSTEM_PROMPT_ADDITION = `When a response contains prompts, commands, configuration, or other exact text that may be copied independently, put each payload in a top-level fenced block. A fence may use at least three backticks or tildes and at most three leading spaces. To label a block, put [copy-region-N]: # "Short label" on its own line, with a unique N; the marker must be at the start of the message or preceded by a blank line, and only blank lines may appear between the marker and its top-level opening fence—never prose. Keep explanations outside the fence and preserve the exact copyable payload inside it.`;

export function appendCopyRegionsGuidance(systemPrompt: string): string {
  return `${systemPrompt}\n\n${COPY_REGIONS_SYSTEM_PROMPT_ADDITION}`;
}
