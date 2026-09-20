// `@ff-labs/pi-fff`, loaded through us so its two renderer slots can be replaced.
//
// The vendor owns `ffgrep`/`fffind`: their `execute` is native FFF search, and no Pi API exposes
// another extension's registered `ToolDefinition`. So the only faithful override is to be the
// one who loads the vendor and to intercept `registerTool` on the way through — everything else
// (execute, commands, flags, event handlers, the `@`-mention provider) is forwarded untouched.
//
// This is why `@ff-labs/pi-fff` is not in `agent/settings.json`'s `packages`: it would load a
// second time, unwrapped. It is a dependency of this package instead, so the version is pinned
// where the rest of them are and `pi update --extensions` cannot move it.
//
// Backing out is: restore the settings entry, delete this package.

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import fffExtension from "@ff-labs/pi-fff/src/index.ts";
import { FFF_RENDERERS } from "../../lib/tools/fff.ts";

export default function fffRenderers(pi: ExtensionAPI) {
  /** Tools the vendor registered under a name we have no renderer for. */
  const unrendered: string[] = [];

  const registerTool = (tool: ToolDefinition<any, any, any>) => {
    const renderer = FFF_RENDERERS.get(tool.name);
    if (!renderer) {
      unrendered.push(tool.name);
      pi.registerTool(tool);
      return;
    }
    // Only the two render slots are replaced. Everything the vendor derived from the mode,
    // the flags and the native search stays exactly as it built it.
    pi.registerTool({
      ...tool,
      renderCall: renderer.renderCall,
      renderResult: renderer.renderResult,
    });
  };

  fffExtension(
    new Proxy(pi, {
      get(target, property, receiver) {
        if (property === "registerTool") return registerTool;
        const value = Reflect.get(target, property, receiver);
        // Bound so a forwarded method still runs against the real API, not the proxy.
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  );

  // A vendor rename would otherwise leave that tool on the vendor's own renderers — a 15-line
  // output window and a header missing half its arguments — which is easy to miss and, since
  // everything still works, impossible to attribute.
  if (unrendered.length)
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(
        `pi-fff registered ${unrendered.join(", ")} with no matching renderer — update FFF_RENDERERS in agent/extensions/lib/tools/fff.ts`,
        "warning",
      );
    });
}
