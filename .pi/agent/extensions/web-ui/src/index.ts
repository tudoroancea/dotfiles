import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Text, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { readWebUiConfig } from "./server/config.js";
import {
  startWebUiServer,
  type StartWebUiServerOptions,
  type WebUiRuntime,
} from "./server/server.js";

const STARTUP_ENTRY = "web-ui-startup";

interface StartupEntryData {
  url: string;
  generation: string;
}

export interface WebUiExtensionDependencies {
  copy: (text: string) => Promise<void>;
  startServer: (options: StartWebUiServerOptions) => Promise<WebUiRuntime>;
  writeStderr: (message: string) => void;
  assetRoot: string;
}

const defaultDependencies: WebUiExtensionDependencies = {
  copy: copyToClipboard,
  startServer: startWebUiServer,
  writeStderr: (message) => process.stderr.write(message),
  assetRoot: fileURLToPath(new URL("../dist/web/", import.meta.url)),
};

export function createCopyRemoteUrlHandler(
  runtime: () => WebUiRuntime | undefined,
  copy: (text: string) => Promise<void>,
) {
  return async (_args: string, context: ExtensionCommandContext): Promise<void> => {
    const active = runtime();
    if (!active) {
      context.ui.notify("Pi Web UI is not running in this mode.", "error");
      return;
    }
    try {
      await copy(active.createBootstrapUrl());
      context.ui.notify("Remote URL copied.", "info");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "clipboard unavailable";
      context.ui.notify(`Could not copy Remote URL: ${reason}`, "error");
    }
  };
}

export function createWebUiExtension(
  dependencies: WebUiExtensionDependencies = defaultDependencies,
) {
  return function webUiExtension(pi: ExtensionAPI): void {
    let runtime: WebUiRuntime | undefined;
    let activeGeneration: string | undefined;

    pi.registerEntryRenderer<StartupEntryData>(STARTUP_ENTRY, (entry, _options, theme) => {
      if (!entry.data || entry.data.generation !== activeGeneration) return undefined;
      const url = entry.data.url;
      return new Text(
        `${theme.fg("accent", theme.bold("Pi Web UI"))} ${theme.fg("muted", url)}\n${theme.fg("dim", "Use /copy-remote-url to copy a directly usable authenticated link.")}`,
        0,
        0,
      );
    });

    pi.registerCommand("copy-remote-url", {
      description: "Copy Remote URL",
      handler: createCopyRemoteUrlHandler(() => runtime, dependencies.copy),
    });

    pi.on("session_start", async (_event, context) => {
      if (context.mode !== "tui" && context.mode !== "rpc") return;
      if (runtime) await runtime.close();
      let autocompleteProvider: AutocompleteProvider | undefined;
      context.ui.addAutocompleteProvider?.((current) => {
        autocompleteProvider = current;
        return current;
      });
      const started = await dependencies.startServer({
        pi,
        context,
        config: readWebUiConfig(),
        assetRoot: dependencies.assetRoot,
        generation: randomUUID(),
        ...(autocompleteProvider ? { autocompleteProvider } : {}),
      });
      runtime = started;
      if (context.mode === "tui") {
        activeGeneration = started.generation;
        pi.appendEntry(STARTUP_ENTRY, {
          url: started.canonicalUrl,
          generation: started.generation,
        });
        started.reconcile();
      } else {
        activeGeneration = started.generation;
        dependencies.writeStderr(`Pi Web UI: ${started.diagnosticUrl}\n`);
      }
    });

    pi.on("message_start", (event) => runtime?.broadcast("message_start", event));
    pi.on("message_update", (event) => runtime?.broadcast("message_update", event));
    pi.on("message_end", (event) => runtime?.broadcast("message_end", event));
    pi.on("tool_execution_start", (event) => runtime?.broadcast("tool_execution_start", event));
    pi.on("tool_execution_update", (event) => runtime?.broadcast("tool_execution_update", event));
    pi.on("tool_execution_end", (event) => runtime?.broadcast("tool_execution_end", event));
    pi.on("agent_start", (event) => runtime?.broadcast("agent_start", event));
    pi.on("agent_settled", (event) => runtime?.broadcast("agent_settled", event));
    pi.on("model_select", (event) => runtime?.broadcast("model_select", event));
    pi.on("thinking_level_select", (event) => runtime?.broadcast("thinking_level_select", event));
    pi.on("session_tree", (event) => runtime?.broadcast("session_tree", event));
    pi.on("session_compact", (event) => runtime?.broadcast("session_compact", event));
    pi.on("session_info_changed", (event) => runtime?.broadcast("session_info_changed", event));

    pi.on("session_shutdown", async () => {
      const active = runtime;
      runtime = undefined;
      activeGeneration = undefined;
      if (active) await active.close();
    });
  };
}

export default createWebUiExtension();
