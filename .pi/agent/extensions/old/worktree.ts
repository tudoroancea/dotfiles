import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as process from "node:process";
import * as fs from "node:fs/promises";
import * as os from "node:os";

const LAST_CWD_FILE = path.join(os.homedir(), ".pi", "last_cwd");

export default function (pi: ExtensionAPI) {
  // Update last_cwd on shutdown to capture the final state
  pi.on("session_shutdown", async () => {
    try {
      await fs.writeFile(LAST_CWD_FILE, process.cwd(), "utf-8");
    } catch (e) {
      // Ignore errors on shutdown
    }
  });

  pi.registerCommand("worktree", {
    description: "Create a git worktree and switch to it",
    handler: async (args, ctx) => {
      if (!args) {
        ctx.ui.notify("Please provide a worktree name", "error");
        return;
      }

      const name = args.trim();

      // 1. Identify Main Worktree
      // We use 'git worktree list --porcelain' to find the main worktree root reliably
      // irrespective of whether we are currently in the main repo or another worktree.
      const wtList = await pi.exec("git", ["worktree", "list", "--porcelain"]);
      if (wtList.code !== 0) {
        ctx.ui.notify(`Failed to list worktrees: ${wtList.stderr}`, "error");
        return;
      }

      // The first 'worktree' entry is the main worktree.
      const lines = wtList.stdout.split("\n");
      const mainWtLine = lines.find(line => line.startsWith("worktree "));
      if (!mainWtLine) {
         ctx.ui.notify("Could not determine main worktree path", "error");
         return;
      }
      
      const mainRoot = mainWtLine.substring(9).trim();
      const newPath = path.join(mainRoot, ".worktrees", name);

      ctx.ui.notify(`Creating worktree at ${newPath}...`, "info");

      // Ensure directory exists (git usually handles it, but just in case for the parent dir)
      await pi.exec("mkdir", ["-p", path.dirname(newPath)]);

      // 3. Construct command
      // Always create a new branch with the same name
      const gitArgs = ["worktree", "add", "-b", name, newPath];

      const result = await pi.exec("git", gitArgs);

      if (result.code !== 0) {
        ctx.ui.notify(`Git error: ${result.stderr}`, "error");
        return;
      }

      ctx.ui.notify(`Worktree created at ${newPath}. Switching...`, "success");

      // 4. Switch Session
      try {
        process.chdir(newPath);
        
        // Update the last_cwd file immediately
        await fs.writeFile(LAST_CWD_FILE, newPath, "utf-8");

        // We start a new session. parentSession links it in the tree, but it's a new file.
        // process.chdir should affect the new session's CWD if pi uses process.cwd()
        await ctx.newSession({
            parentSession: ctx.sessionManager.getSessionFile(),
        });

        // Update UI indicators to reflect the new worktree
        pi.setSessionName(name);
        
        // Remove the custom status item as the user prefers a cleaner look
        // ctx.ui.setStatus("worktree", `📂 ${name}`);
        
        // Instead, use setFooter to show the actual CWD if they want strict confirmation
        // But since they asked to "modify the current statusline", and setSessionName does that for the main indicator,
        // we'll stick to setSessionName for now. 
        // If they want the path explicitly, they can ask for it.
        // But wait, the user said "actually modifying the current statusline... indicate the new dir".
        // The default footer usually shows session name. By setting session name to 'name', 
        // we are indicating the new dir (worktree name).
        
        // However, if the user really wants the PATH in the footer, we can provide a custom footer option.
        // But let's try just removing the setStatus first as that was the 'add' they disliked.
      } catch (error) {
        ctx.ui.notify(`Failed to switch session: ${error}`, "error");
      }
    },
  });
}
