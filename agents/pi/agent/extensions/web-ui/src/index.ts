import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DisposableSlot, SessionRuntimeLifecycle } from "./standalone/lifecycle.js";
import { StandaloneSessionRuntime } from "./standalone/runtime.js";

export { fallbackFileCompletions, mentionCompletions } from "./standalone/completion.js";
export {
  startServer,
  type JournalMetricsSink,
  type JournalMetricsSnapshot,
  type Snapshot,
  type StartServerOptions,
  type WebUiServer,
} from "./standalone/server.js";

export default function webUiSimpleExtension(pi: ExtensionAPI): void {
  const lifecycle = new SessionRuntimeLifecycle<ExtensionContext, StandaloneSessionRuntime>(
    (context, isCurrent) => new StandaloneSessionRuntime(pi, context, isCurrent),
  );
  const workingWordSubscription = new DisposableSlot();

  async function copyUrl(commandContext: ExtensionCommandContext, remote: boolean): Promise<void> {
    const runtime = lifecycle.current;
    if (!runtime) {
      commandContext.ui.notify(
        remote
          ? "The remote Web UI is unavailable. Check that Tailscale is installed and connected."
          : "Pi Web UI (simple) is not running in this mode.",
        "error",
      );
      return;
    }
    await runtime.copyUrl(commandContext, remote);
  }

  pi.registerCommand("copy-url", {
    description: "Copy a local authenticated Pi Web UI link",
    handler: async (_args: string, context: ExtensionCommandContext): Promise<void> => {
      await copyUrl(context, false);
    },
  });

  pi.registerCommand("copy-remote-url", {
    description: "Copy a tailnet-authenticated Pi Web UI link",
    handler: async (_args: string, context: ExtensionCommandContext): Promise<void> => {
      await copyUrl(context, true);
    },
  });

  pi.on("session_start", async (_event, context) => {
    workingWordSubscription.clear();
    if (context.mode !== "tui" && context.mode !== "rpc") {
      await lifecycle.shutdown();
      return;
    }
    const unsubscribe = pi.events.on("working-word:change", (data) =>
      lifecycle.current?.onWorkingWord(data),
    );
    workingWordSubscription.replace(unsubscribe);
    try {
      await lifecycle.replace(context);
    } catch (error) {
      workingWordSubscription.clear(unsubscribe);
      throw error;
    }
  });

  pi.on("agent_start", () => lifecycle.current?.onAgentStart());
  pi.on("turn_end", async () => {
    await lifecycle.current?.onTurnEnd();
  });
  pi.on("agent_end", async (event) => {
    await lifecycle.current?.onAgentEnd(event);
  });
  pi.on("message_start", (event) => lifecycle.current?.onMessageStart(event));
  pi.on("message_update", (event) => lifecycle.current?.onMessageUpdate(event));
  pi.on("message_end", (event) => lifecycle.current?.onMessageEnd(event));
  pi.on("tool_execution_start", (event) => lifecycle.current?.onToolStart(event));
  pi.on("tool_execution_update", (event) => lifecycle.current?.onToolUpdate(event));
  pi.on("tool_execution_end", (event) => lifecycle.current?.onToolEnd(event));
  pi.on("agent_settled", () => lifecycle.current?.onAgentSettled());
  pi.on("model_select", () => lifecycle.current?.onModelSelect());
  pi.on("thinking_level_select", () => lifecycle.current?.scheduleBroadcast());
  pi.on("session_tree", () => lifecycle.current?.onSessionTree());
  pi.on("session_compact", () => lifecycle.current?.onSessionCompact());
  pi.on("session_info_changed", () => lifecycle.current?.scheduleBroadcast());
  pi.on("session_shutdown", async () => {
    workingWordSubscription.clear();
    await lifecycle.shutdown();
  });
}
