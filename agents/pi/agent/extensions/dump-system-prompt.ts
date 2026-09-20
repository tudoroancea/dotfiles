import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DUMPED = Symbol.for("pi.dump-system-prompt.dumped");

export default function (pi: ExtensionAPI) {
  pi.registerFlag("dump-system-prompt", {
    description: "Dump the main session system prompt to .pi/agent/dumped-system-prompt.md",
    type: "boolean",
    default: false,
  });

  pi.on("before_agent_start", async (event) => {
    if (pi.getFlag("dump-system-prompt") !== true || Reflect.get(globalThis, DUMPED)) return;

    await writeFile(join(getAgentDir(), "dumped-system-prompt.md"), event.systemPrompt, "utf8");
    Reflect.set(globalThis, DUMPED, true);
  });
}
