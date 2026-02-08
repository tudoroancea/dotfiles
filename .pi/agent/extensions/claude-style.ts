import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import * as path from "node:path";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    ctx.ui.custom((tui, theme, _kb, done) => {
      const isAssistantComponent = (c: any) => 
        c.constructor.name === "AssistantMessageComponent" || 
        (typeof c.updateContent === 'function' && typeof c.setHideThinkingBlock === 'function');

      const isToolComponent = (c: any) => 
        c.constructor.name === "ToolExecutionComponent" || 
        (typeof c.updateResult === 'function' && typeof c.updateArgs === 'function');

      const getHexColor = (type: "success" | "error" | "successBg" | "errorBg" | "dim") => {
        // Simple dark mode detection based on text color brightness
        const textFg = theme.fg("text", "!");
        const match = textFg.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
        let isDark = true;
        if (match) {
          const [_, r, g, b] = match.map(Number);
          const brightness = (r * 299 + g * 587 + b * 114) / 1000;
          isDark = brightness > 128;
        }

        if (isDark) {
          if (type === "success") return "\x1b[38;2;78;186;101m";
          if (type === "error") return "\x1b[38;2;255;107;128m";
          if (type === "successBg") return "\x1b[48;2;34;92;43m";
          if (type === "errorBg") return "\x1b[48;2;122;41;54m";
        } else {
          if (type === "success") return "\x1b[38;2;26;125;50m";
          if (type === "error") return "\x1b[38;2;207;34;46m";
          if (type === "successBg") return "\x1b[48;2;218;251;225m";
          if (type === "errorBg") return "\x1b[48;2;255;235;233m";
        }
        return theme.fg("dim", "");
      };

      const formatArgs = (name: string, args: any) => {
        if (!args) return "";
        let p = args.path || args.file_path || "";
        if (p && path.isAbsolute(p)) {
          p = path.relative(ctx.cwd, p) || ".";
        }

        if (name === "bash") {
          const cmd = args.command || "";
          const firstLine = cmd.split('\n')[0];
          if (cmd.includes('\n')) {
            return firstLine + " ...";
          }
          return firstLine;
        }
        if (name === "todo") {
          if (args.action === "add") return `Add: "${args.text?.slice(0, 40)}${args.text?.length > 40 ? '...' : ''}"`;
          if (args.action === "toggle") return `Toggle todo #${args.id}`;
          if (args.action === "list") return "List todos";
          return `${args.action || ""}: "${args.text || ""}"`;
        }
        if (name === "questionnaire") {
          if (args.questions && Array.isArray(args.questions)) {
            return args.questions.map((q: any) => `Q: "${q.prompt?.slice(0, 30)}${q.prompt?.length > 30 ? '...' : ''}"`).join(", ");
          }
          return "Ask question(s)";
        }
        if (name === "read" || name === "write" || name === "ls" || name === "edit") return p;
        if (name === "grep" || name === "find") return `${args.pattern || ""}, ${p || ""}`;
        
        return Object.entries(args)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ");
      };

      const wrapBlock = (component: any, assistant: any) => {
        if (component._pi_wrapped_block) return;
        component._pi_wrapped_block = true;

        const originalRender = component.render.bind(component);
        let cachedWidth: number | undefined;
        let cachedResult: string[] | undefined;
        let lastMessageId: any;

        component.render = (width: number) => {
          const currentMessageId = assistant.lastMessage;
          if (cachedResult && cachedWidth === width && lastMessageId === currentMessageId) {
            return cachedResult;
          }

          const lines = originalRender(width - 1);
          
          let dotColor = "text";
          const message = assistant.lastMessage;
          if (message?.stopReason === "error" || message?.stopReason === "aborted") {
            dotColor = "error";
          }

          const dot = dotColor === "error" ? getHexColor("error") + "⏺\x1b[0m" : "⏺";

          const result = lines.map((line: string, i: number) => {
            const prefix = i === 0 ? dot : " ";
            const fullLine = prefix + line;
            return truncateToWidth(fullLine, width);
          });

          cachedWidth = width;
          cachedResult = result;
          lastMessageId = currentMessageId;
          return result;
        };

        const originalInvalidate = component.invalidate?.bind(component);
        component.invalidate = () => {
          originalInvalidate?.();
          cachedWidth = undefined;
          cachedResult = undefined;
        };
      };

      const patchAssistant = (assistant: any) => {
        if (assistant._pi_patched_assistant) return;
        assistant._pi_patched_assistant = true;

        const contentContainer = assistant.children[0];
        if (contentContainer && contentContainer.constructor.name === "Container") {
          const originalAddChild = contentContainer.addChild.bind(contentContainer);
          contentContainer.addChild = (child: any) => {
            if (child.constructor.name === "Markdown" || child.constructor.name === "Text") {
              wrapBlock(child, assistant);
            }
            return originalAddChild(child);
          };

          for (const block of contentContainer.children) {
            if (block.constructor.name === "Markdown" || block.constructor.name === "Text") {
              wrapBlock(block, assistant);
            }
          }
        }
      };

      const patchTool = (tool: any) => {
        if (tool._pi_patched_tool) return;
        tool._pi_patched_tool = true;

        const originalUpdateDisplay = tool.updateDisplay?.bind(tool);
        if (originalUpdateDisplay) {
          tool.updateDisplay = () => {
            originalUpdateDisplay();
            if (tool.contentBox) {
              tool.contentBox.setBgFn((s: string) => s);
              tool.contentBox.paddingX = 0;
              tool.contentBox.paddingY = 0;
            }
            if (tool.contentText) {
              tool.contentText.setCustomBgFn((s: string) => s);
              tool.contentText.paddingX = 0;
              tool.contentText.paddingY = 0;
            }
          };
          tool.updateDisplay();
        }

        const originalRender = tool.render.bind(tool);
        let cachedWidth: number | undefined;
        let cachedResult: string[] | undefined;
        let lastResultId: any;
        let lastExpanded: boolean | undefined;
        let lastArgs: string | undefined;

        tool.render = (width: number) => {
          const currentResultId = tool.result;
          const currentExpanded = tool.expanded;
          const currentArgs = JSON.stringify(tool.args);
          if (cachedResult && cachedWidth === width && lastResultId === currentResultId && lastExpanded === currentExpanded && lastArgs === currentArgs) {
            return cachedResult;
          }

          let dotType: "success" | "error" | "dim" = "dim";
          if (!tool.isPartial) {
            dotType = tool.result?.isError ? "error" : "success";
          }

          let toolName = tool.toolName.charAt(0).toUpperCase() + tool.toolName.slice(1);
          if (tool.toolName === "edit") toolName = "Update";

          let args = formatArgs(tool.toolName, tool.args);
          
          // For todo toggle, try to get the text from the result
          if (tool.toolName === "todo" && tool.args?.action === "toggle" && tool.result && !tool.isPartial) {
            // The result details contain the full todos array
            const details = tool.result.details;
            if (details?.todos && tool.args.id !== undefined) {
              const todo = details.todos.find((t: any) => t.id === tool.args.id);
              if (todo) {
                const text = todo.text;
                args = `toggled "${text.slice(0, 30)}${text.length > 30 ? '...' : ''}"`;
              }
            }
          }
          
          const dot = dotType === "dim" ? theme.fg("dim", "⏺") : getHexColor(dotType) + "⏺\x1b[0m";
          const header = dot + " " + theme.bold(toolName) + theme.fg("dim", `(${args})`);
          const truncatedHeader = truncateToWidth(header, width);

          let result: string[] = ["", truncatedHeader];

          if (tool.expanded) {
            if (tool.toolName === "todo") {
              const action = tool.args?.action;
              const text = tool.args?.text;
              const id = tool.args?.id;
              
              if (action === "add") {
                // result.push(` ⎿ ${theme.fg("success", "Added todo")}: "${text}"`);
              } else if (action === "toggle") {
                // result.push(` ⎿ ${theme.fg("dim", "Toggled todo")}: "${text}"`);
              } else if (action === "list") {
                const todos = tool.result?.todos || [];
                for (const t of todos) {
                  const mark = t.completed ? "✓" : "○";
                  result.push(` ⎿ ${mark} ${t.text}`);
                }
              } else {
                result.push(` ⎿ ${theme.fg("dim", action || "unknown")}`);
              }
            } else if (tool.toolName === "read" && !tool.isPartial && !tool.result?.isError) {
               const output = tool.getTextOutput() || "";
               const lines = output.split('\n');
               const lineCount = lines.length;
               result.push(` ⎿ ${theme.fg("dim", `Read ${lineCount} lines`)}`);
            } else {
              const originalLines = originalRender(width - 4);
              let skipCount = 0;
              for (let i = 0; i < Math.min(originalLines.length, 5); i++) {
                const line = originalLines[i];
                const plain = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
                if (plain === "" && i > 0 && i < 3) {
                  skipCount = i + 1;
                  break;
                }
              }
              if (skipCount === 0 && originalLines.length > 0) {
                const firstPlain = originalLines[0].replace(/\x1b\[[0-9;]*m/g, '').toLowerCase();
                if (firstPlain.includes(tool.toolName.toLowerCase()) || firstPlain.startsWith("$ ")) {
                  skipCount = 1;
                  if (originalLines[1] && originalLines[1].replace(/\x1b\[[0-9;]*m/g, '').trim() === "") {
                    skipCount = 2;
                  }
                }
              }

              const contentLines = originalLines.slice(skipCount);
              
              let contentStarted = false;
              for (let i = 0; i < contentLines.length; i++) {
                let line = contentLines[i];
                if (!contentStarted && line.trim() === "") continue;

                if (tool.toolName === "edit") {
                  const plainLine = line.replace(/\x1b\[[0-9;]*m/g, '');
                  const match = plainLine.match(/^([+-])(\s*\d*)\s(.*)$/);
                  if (match) {
                    const [_, sign, lineNum, rest] = match;
                    const bgColor = sign === "+" ? getHexColor("successBg") : getHexColor("errorBg");
                    const dotColor = sign === "+" ? getHexColor("success") : getHexColor("error");
                    line = bgColor + dotColor + sign + theme.fg("dim", lineNum) + "\x1b[0m" + bgColor + " " + rest + "\x1b[0m";
                  } else {
                    const contextMatch = plainLine.match(/^(\s)(\s*\d*)\s(.*)$/);
                    if (contextMatch) {
                      const [_, sign, lineNum, rest] = contextMatch;
                      line = " " + theme.fg("dim", lineNum) + " " + rest;
                    }
                  }
                }
                
                const prefix = !contentStarted ? " ⎿ " : "   ";
                result.push(truncateToWidth(prefix + line, width));
                contentStarted = true;
              }

              if (!contentStarted && !tool.isPartial) {
                if (tool.result?.isError) {
                  const errorText = tool.getTextOutput() || "";
                  if (errorText.includes("Validation failed")) {
                    result.push(truncateToWidth(" ⎿ " + theme.fg("error", "Validation failed"), width));
                  } else {
                    result.push(truncateToWidth(" ⎿ " + theme.fg("error", errorText), width));
                  }
                } else {
                  result.push(truncateToWidth(" ⎿ " + theme.fg("dim", "(no output)"), width));
                }
              }
            }
          }

          cachedWidth = width;
          cachedResult = result;
          lastResultId = currentResultId;
          lastExpanded = currentExpanded;
          lastArgs = currentArgs;
          return result;
        };

        const originalInvalidate = tool.invalidate?.bind(tool);
        tool.invalidate = () => {
          originalInvalidate?.();
          cachedWidth = undefined;
          cachedResult = undefined;
        };
      };

      for (const child of tui.children) {
        if (child.constructor.name === "Container") {
          const container = child as any;
          for (const grandchild of container.children) {
            if (isAssistantComponent(grandchild)) {
              patchAssistant(grandchild);
            } else if (isToolComponent(grandchild)) {
              patchTool(grandchild);
            }
          }

          if (!container._pi_patched_chat) {
            container._pi_patched_chat = true;
            const originalAddChild = container.addChild.bind(container);
            container.addChild = (child: any) => {
              if (isAssistantComponent(child)) {
                patchAssistant(child);
              } else if (isToolComponent(child)) {
                patchTool(child);
              }
              return originalAddChild(child);
            };
          }
        }
      }

      done(true);
      return { render: () => [], invalidate: () => {}, handleInput: () => {} };
    });
  });
}
