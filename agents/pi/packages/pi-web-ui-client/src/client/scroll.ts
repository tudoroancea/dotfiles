// Programmatic scroll marker, shared between the app's own bottom-follow jumps
// (useStickToBottom) and the window virtualizer's internal adjustments (its
// scrollToFn override). The browser dispatches the resulting scroll events
// asynchronously, after layout and after row measurements may already have
// changed the document height, so such an event can look like the reader left
// the bottom. Matching it against the shared target keeps measurement echoes
// from silently cancelling bottom-follow.

let programmaticScrollTarget: number | null = null;

export function markProgrammaticScroll(y: number): void {
  programmaticScrollTarget = y;
}

export function readProgrammaticScrollTarget(): number | null {
  return programmaticScrollTarget;
}
