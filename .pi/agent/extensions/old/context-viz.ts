import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

interface ContextCategory {
  name: string;
  tokens: number;
  percentage: number;
  color: string; // theme color key
  description?: string;
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token for English text
  return Math.ceil(text.length / 4);
}

function calculateContextUsage(ctx: ExtensionContext): ContextCategory[] {
  const categories: ContextCategory[] = [];
  
  // Get model info
  const model = ctx.model;
  const contextWindow = model?.contextWindow || 200000;
  
  // Get system prompt
  const systemPrompt = ctx.getSystemPrompt();
  const systemPromptTokens = estimateTokens(systemPrompt);
  
  // Parse tools from system prompt (rough estimate)
  const toolsMatch = systemPrompt.match(/<tools>([\s\S]*?)<\/tools>/);
  const toolsSection = toolsMatch ? toolsMatch[1] : "";
  const systemToolsTokens = estimateTokens(toolsSection);
  const baseSystemTokens = systemPromptTokens - systemToolsTokens;
  
  categories.push({
    name: "System prompt",
    tokens: baseSystemTokens,
    percentage: 0,
    color: "syntaxKeyword"
  });
  
  if (systemToolsTokens > 0) {
    categories.push({
      name: "System tools",
      tokens: systemToolsTokens,
      percentage: 0,
      color: "toolTitle"
    });
  }
  
  // Get session messages
  const branch = ctx.sessionManager.getBranch();
  let userTokens = 0;
  let assistantTokens = 0;
  let toolResultTokens = 0;
  let customMessageTokens = 0;
  let bashExecutionTokens = 0;
  let reservedTokens = 0;
  
  // Use actual token counts from usage when available
  let totalInputFromUsage = 0;
  let totalOutputFromUsage = 0;
  let hasUsageData = false;
  
  for (const entry of branch) {
    if (entry.type === "message") {
      const msg = entry.message;
      
      if (msg.role === "user") {
        if (typeof msg.content === "string") {
          userTokens += estimateTokens(msg.content);
        } else {
          for (const block of msg.content) {
            if (block.type === "text") {
              userTokens += estimateTokens(block.text);
            } else if (block.type === "image") {
              // Images are typically 1000-2000 tokens depending on size
              userTokens += 1500;
            }
          }
        }
      } else if (msg.role === "assistant") {
        if (msg.usage) {
          hasUsageData = true;
          totalInputFromUsage += msg.usage.input;
          totalOutputFromUsage += msg.usage.output;
          assistantTokens += msg.usage.output;
          reservedTokens = Math.max(reservedTokens, msg.usage.cacheWrite);
        } else {
          // Fallback to estimation
          for (const block of msg.content) {
            if (block.type === "text") {
              assistantTokens += estimateTokens(block.text);
            } else if (block.type === "thinking") {
              assistantTokens += estimateTokens(block.thinking);
            }
          }
        }
      } else if (msg.role === "toolResult") {
        for (const block of msg.content) {
          if (block.type === "text") {
            toolResultTokens += estimateTokens(block.text);
          } else if (block.type === "image") {
            toolResultTokens += 1500;
          }
        }
      } else if (msg.role === "custom") {
        if (typeof msg.content === "string") {
          customMessageTokens += estimateTokens(msg.content);
        } else {
          for (const block of msg.content) {
            if (block.type === "text") {
              customMessageTokens += estimateTokens(block.text);
            }
          }
        }
      } else if (msg.role === "bashExecution") {
        if (!msg.excludeFromContext) {
          bashExecutionTokens += estimateTokens(msg.command);
          bashExecutionTokens += estimateTokens(msg.output);
        }
      } else if (msg.role === "compactionSummary") {
        userTokens += estimateTokens(msg.summary);
      } else if (msg.role === "branchSummary") {
        userTokens += estimateTokens(msg.summary);
      }
    } else if (entry.type === "compaction") {
      // Compaction summary (for older sessions)
      userTokens += estimateTokens(entry.summary);
    } else if (entry.type === "branch_summary") {
      // Branch summary (for older sessions)
      userTokens += estimateTokens(entry.summary);
    }
  }
  
  // If we have usage data, use it to adjust estimates
  if (hasUsageData && totalInputFromUsage > 0) {
    // The input tokens include system prompt + tools + all messages
    // We can use this to get a more accurate count
    const estimatedMessagesTokens = userTokens + toolResultTokens + customMessageTokens + bashExecutionTokens;
    const actualMessagesTokens = totalInputFromUsage - systemPromptTokens;
    
    if (estimatedMessagesTokens > 0) {
      // Scale our estimates based on actual usage
      const scaleFactor = actualMessagesTokens / estimatedMessagesTokens;
      userTokens = Math.round(userTokens * scaleFactor);
      toolResultTokens = Math.round(toolResultTokens * scaleFactor);
      customMessageTokens = Math.round(customMessageTokens * scaleFactor);
      bashExecutionTokens = Math.round(bashExecutionTokens * scaleFactor);
    }
  }
  
  // Add categories in order
  if (userTokens > 0) {
    categories.push({
      name: "Messages",
      tokens: userTokens,
      percentage: 0,
      color: "userMessageText"
    });
  }
  
  if (toolResultTokens > 0) {
    categories.push({
      name: "Tool results",
      tokens: toolResultTokens,
      percentage: 0,
      color: "toolOutput"
    });
  }
  
  if (customMessageTokens > 0) {
    categories.push({
      name: "Custom agents",
      tokens: customMessageTokens,
      percentage: 0,
      color: "customMessageText"
    });
  }
  
  if (bashExecutionTokens > 0) {
    categories.push({
      name: "Memory files",
      tokens: bashExecutionTokens,
      percentage: 0,
      color: "bashMode"
    });
  }
  
  if (assistantTokens > 0) {
    categories.push({
      name: "Assistant output",
      tokens: assistantTokens,
      percentage: 0,
      color: "accent"
    });
  }
  
  if (reservedTokens > 0) {
    categories.push({
      name: "Reserved",
      tokens: reservedTokens,
      percentage: 0,
      color: "muted"
    });
  }
  
  // Calculate total and percentages
  const totalUsed = categories.reduce((sum, cat) => sum + cat.tokens, 0);
  const freeTokens = Math.max(0, contextWindow - totalUsed);
  
  for (const cat of categories) {
    cat.percentage = (cat.tokens / contextWindow) * 100;
  }
  
  categories.push({
    name: "Free space",
    tokens: freeTokens,
    percentage: (freeTokens / contextWindow) * 100,
    color: "dim"
  });
  
  return categories;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`;
  }
  return tokens.toString();
}

function renderContextVisualization(ctx: ExtensionContext): string[] {
  const categories = calculateContextUsage(ctx);
  const theme = (ctx as any).ui?.theme;
  
  if (!theme) {
    // Fallback for non-interactive mode
    return ["Context visualization not available in this mode"];
  }
  
  const model = ctx.model;
  const contextWindow = model?.contextWindow || 200000;
  const totalUsed = categories.reduce((sum, cat) => sum + cat.tokens, 0) - 
                   (categories.find(c => c.name === "Free space")?.tokens || 0);
  
  const lines: string[] = [];
  
  // Header - styled like in the reference
  lines.push(theme.fg("dim", "> /context"));
  
  const usagePercent = Math.round((totalUsed / contextWindow) * 100);
  lines.push(
    theme.fg("dim", "└ ") +
    theme.bold("Context Usage ") +
    theme.fg("accent", `${formatTokens(totalUsed)}`) +
    theme.fg("text", "/") +
    theme.fg("muted", `${formatTokens(contextWindow)} tokens `) +
    theme.fg("dim", `(${usagePercent}%)`)
  );
  
  // Visual bar using block characters
  // Create multiple rows of blocks for better visualization
  const barWidth = 50;
  const barHeight = 3;
  const blocksFilled = ["█", "▓", "▒"];
  const blocksEmpty = ["░", "▢"];
  
  // Calculate character positions for each category
  let position = 0;
  const categoryRanges: Array<{start: number, end: number, color: string, isFree: boolean}> = [];
  
  for (const cat of categories) {
    const catWidth = Math.round((cat.percentage / 100) * barWidth);
    if (catWidth > 0) {
      categoryRanges.push({
        start: position,
        end: position + catWidth,
        color: cat.color,
        isFree: cat.name === "Free space"
      });
      position += catWidth;
    }
  }
  
  // Render multiple rows of the bar
  for (let row = 0; row < barHeight; row++) {
    let barLine = "  ";
    for (let col = 0; col < barWidth; col++) {
      const range = categoryRanges.find(r => col >= r.start && col < r.end);
      if (range) {
        if (range.isFree) {
          // Empty blocks for free space
          barLine += theme.fg(range.color, blocksEmpty[row % 2]);
        } else {
          // Filled blocks for used space
          barLine += theme.fg(range.color, blocksFilled[row % 3]);
        }
      } else {
        barLine += " ";
      }
    }
    lines.push(barLine);
  }
  
  // Category breakdown with tree-like structure
  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i];
    if (cat.tokens === 0) continue;
    
    const isLast = i === categories.length - 1 || 
                  categories.slice(i + 1).every(c => c.tokens === 0);
    const prefix = isLast ? "  ◇" : "  ■";
    
    const nameWidth = 22;
    const name = cat.name + ":";
    const tokens = formatTokens(cat.tokens);
    const percent = cat.percentage.toFixed(1) + "%";
    
    let line = theme.fg(cat.color, prefix) + " ";
    line += theme.fg("text", name.padEnd(nameWidth));
    line += theme.fg("accent", tokens.padStart(7) + " tokens ");
    line += theme.fg("dim", `(${percent})`);
    
    lines.push(line);
  }
  
  return lines;
}

export default function (pi: ExtensionAPI) {
  let widgetActive = false;
  
  pi.registerCommand("context", {
    description: "Show context usage breakdown",
    handler: async (_args, ctx) => {
      // If widget is active, clear it
      if (widgetActive) {
        if (ctx.hasUI) {
          ctx.ui.setWidget("context-viz", undefined);
          widgetActive = false;
          ctx.ui.notify("Context visualization hidden", "info");
        }
        return;
      }
      
      // Wait for agent to be idle if streaming
      if (!ctx.isIdle()) {
        await ctx.waitForIdle();
      }
      
      // Display visualization in widget area
      const lines = renderContextVisualization(ctx);
      
      if (ctx.hasUI) {
        // Show in widget area above editor (default)
        ctx.ui.setWidget("context-viz", lines);
        widgetActive = true;
        
        ctx.ui.notify("Context visualization displayed (run /context again to hide)", "info");
      } else {
        // Print mode - just output the lines
        console.log(lines.join("\n"));
      }
    },
  });
  
  // Auto-hide widget when agent starts processing
  pi.on("agent_start", async (_event, ctx) => {
    if (widgetActive && ctx.hasUI) {
      ctx.ui.setWidget("context-viz", undefined);
      widgetActive = false;
    }
  });
}
