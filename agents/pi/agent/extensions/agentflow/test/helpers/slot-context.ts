/** The per-call render context Pi's tool-execution shell passes to both renderer slots. */
export function slotContext(args: unknown, overrides: Record<string, unknown> = {}) {
  return {
    args,
    toolCallId: "call-1",
    cwd: "/work/project",
    expanded: false,
    isError: false,
    isPartial: false,
    executionStarted: true,
    argsComplete: true,
    showImages: false,
    lastComponent: undefined,
    state: {},
    invalidate: () => {},
    ...overrides,
  } as never;
}
