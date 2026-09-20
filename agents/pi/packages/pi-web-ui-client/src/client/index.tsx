// Public client entry.
//
// `mount` renders the session UI into a host DOM element using an injected
// `SessionTransport`. Every host adapter (standalone extension, future daemon)
// supplies its own transport and stylesheet; this module owns no host details.

import { render } from "preact";
import type { IncrementalSessionTransport } from "../wire/types.ts";
import { App } from "./components.tsx";

/** Render the session UI into `root`, driven by the injected `transport`. */
export function mount(root: Element, transport: IncrementalSessionTransport): void {
  render(<App root={root} transport={transport} />, root);
}

export { App } from "./components.tsx";
export { Transcript } from "./renderers.tsx";
export { REGISTERED_TOOL_NAMES } from "./tools/index.tsx";
export { DisclosureContext, useDisclosureStore, type DisclosureStore } from "./disclosure.ts";
export {
  useSession,
  type SessionController,
  type SessionMetrics,
  type SubmitResult,
} from "./session.ts";
export { renderMarkdown } from "./markdown.tsx";
export { PREFS } from "./preferences.ts";
export {
  applyOperationBatch,
  applyReset,
  applySessionEnvelope,
  createSessionState,
  prependHistoryPage,
  selectLegacySnapshot,
  selectShellSnapshot,
  type RecoveryReason,
  type SessionState,
  type SessionTransition,
} from "./session-state.ts";
