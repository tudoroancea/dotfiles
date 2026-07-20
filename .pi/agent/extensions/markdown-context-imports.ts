import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MarkdownImportResolver, type MarkdownImportSource } from "../lib/markdown-imports.ts";

interface CachedExpansion {
  rootSize: number;
  rootMtimeMs: number;
  sources: MarkdownImportSource[];
  text: string;
}

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch {
    return resolve(path);
  }
}

async function isFresh(entry: CachedExpansion): Promise<boolean> {
  for (const source of entry.sources) {
    try {
      const metadata = await stat(source.path);
      if (metadata.size !== source.size || metadata.mtimeMs !== source.mtimeMs) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function markdownContextImports(pi: ExtensionAPI) {
  const resolver = new MarkdownImportResolver();
  const expansions = new Map<string, CachedExpansion>();

  pi.on("session_start", (event) => {
    if (event.reason !== "reload") return;
    resolver.clearCache();
    expansions.clear();
  });

  pi.on("before_agent_start", async (event) => {
    const contextFiles = event.systemPromptOptions.contextFiles ?? [];
    if (contextFiles.length === 0) return;

    const cwd = await canonical(event.systemPromptOptions.cwd);
    const agentDir = await canonical(getAgentDir());
    const importedSections: string[] = [];

    for (const contextFile of contextFiles) {
      const rootPath = await canonical(contextFile.path);
      const metadata = await stat(rootPath);
      const cached = expansions.get(rootPath);
      if (
        cached &&
        cached.rootSize === metadata.size &&
        cached.rootMtimeMs === metadata.mtimeMs &&
        (await isFresh(cached))
      ) {
        if (cached.text) importedSections.push(cached.text);
        continue;
      }

      const isUserContext = isWithin(rootPath, agentDir);
      const allowedRoot = isUserContext
        ? agentDir
        : isWithin(rootPath, cwd)
          ? cwd
          : dirname(rootPath);
      const compiled = await resolver.compile({
        rootPath,
        content: contextFile.content,
        includeRoot: false,
        allowedRoots: [allowedRoot],
        allowOutsideRoots: isUserContext,
      });
      const expansion: CachedExpansion = {
        rootSize: metadata.size,
        rootMtimeMs: metadata.mtimeMs,
        sources: compiled.sources,
        text: compiled.text,
      };
      expansions.set(rootPath, expansion);
      if (expansion.text) importedSections.push(expansion.text);
    }

    if (importedSections.length === 0) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n## Imported context\n\n${importedSections.join("\n\n")}`,
    };
  });
}

export default markdownContextImports;
