import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const DEFAULT_MAX_IMPORT_DEPTH = 4;
export const DEFAULT_MAX_IMPORTED_FILE_BYTES = 64 * 1024;
export const DEFAULT_MAX_TOTAL_IMPORTED_BYTES = 256 * 1024;

export interface MarkdownImportSource {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface MarkdownImportResult {
  text: string;
  sources: MarkdownImportSource[];
  importedBytes: number;
}

export interface MarkdownImportOptions {
  rootPath: string;
  content?: string;
  includeRoot?: boolean;
  allowedRoots?: string[];
  allowOutsideRoots?: boolean;
  maxDepth?: number;
  maxImportedFileBytes?: number;
  maxTotalImportedBytes?: number;
}

interface CachedFile extends MarkdownImportSource {
  content: string;
}

export class MarkdownImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkdownImportError";
  }
}

function isWithin(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceBlock(path: string, content: string): string {
  const body = content.endsWith("\n") ? content : `${content}\n`;
  return `<!-- BEGIN MARKDOWN IMPORT: ${path} -->\n${body}<!-- END MARKDOWN IMPORT: ${path} -->`;
}

export class MarkdownImportResolver {
  private readonly fileCache = new Map<string, CachedFile>();

  clearCache(): void {
    this.fileCache.clear();
  }

  async compile(options: MarkdownImportOptions): Promise<MarkdownImportResult> {
    const rootPath = resolve(options.rootPath);
    const canonicalRoot = await this.canonicalizeRoot(rootPath);
    const lexicalAllowedRoots = (options.allowedRoots ?? [dirname(rootPath)]).map((path) =>
      resolve(path),
    );
    const allowedRoots = await Promise.all(
      lexicalAllowedRoots.map((path) => this.canonicalizeRoot(path)),
    );
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_IMPORT_DEPTH;
    const maxImportedFileBytes = options.maxImportedFileBytes ?? DEFAULT_MAX_IMPORTED_FILE_BYTES;
    const maxTotalImportedBytes = options.maxTotalImportedBytes ?? DEFAULT_MAX_TOTAL_IMPORTED_BYTES;

    if (!Number.isInteger(maxDepth) || maxDepth < 0) {
      throw new MarkdownImportError("Markdown import maxDepth must be a non-negative integer");
    }

    const rootContent = options.content ?? (await this.readRoot(canonicalRoot));
    const seen = new Set([canonicalRoot]);
    const stack = [canonicalRoot];
    const sources: MarkdownImportSource[] = [];
    let importedBytes = 0;

    const expandImport = async (
      specifier: string,
      importer: string,
      depth: number,
    ): Promise<string> => {
      if (depth > maxDepth) {
        throw new MarkdownImportError(
          `Markdown import depth exceeds ${maxDepth}: ${specifier} imported from ${importer}`,
        );
      }

      const candidate = isAbsolute(specifier)
        ? resolve(specifier)
        : resolve(dirname(importer), specifier);
      if (
        !options.allowOutsideRoots &&
        !lexicalAllowedRoots.some((root) => isWithin(candidate, root)) &&
        !allowedRoots.some((root) => isWithin(candidate, root))
      ) {
        throw new MarkdownImportError(
          `Markdown import escapes the allowed roots: ${specifier} imported from ${importer}`,
        );
      }

      let canonicalPath: string;
      try {
        canonicalPath = await realpath(candidate);
      } catch (error) {
        throw new MarkdownImportError(
          `Cannot resolve Markdown import ${specifier} from ${importer}: ${errorMessage(error)}`,
        );
      }
      if (
        !options.allowOutsideRoots &&
        !allowedRoots.some((root) => isWithin(canonicalPath, root))
      ) {
        throw new MarkdownImportError(
          `Markdown import resolves outside the allowed roots: ${specifier} imported from ${importer}`,
        );
      }
      if (stack.includes(canonicalPath)) {
        throw new MarkdownImportError(
          `Markdown import cycle detected: ${[...stack, canonicalPath].join(" -> ")}`,
        );
      }
      if (seen.has(canonicalPath)) return "";

      const imported = await this.readImportedFile(canonicalPath);
      if (imported.size > maxImportedFileBytes) {
        throw new MarkdownImportError(
          `Markdown import exceeds the ${maxImportedFileBytes} byte file limit: ${canonicalPath} (${imported.size} bytes)`,
        );
      }
      if (importedBytes + imported.size > maxTotalImportedBytes) {
        throw new MarkdownImportError(
          `Markdown imports exceed the ${maxTotalImportedBytes} byte total limit while importing ${canonicalPath}`,
        );
      }

      seen.add(canonicalPath);
      sources.push({ path: canonicalPath, size: imported.size, mtimeMs: imported.mtimeMs });
      importedBytes += imported.size;
      stack.push(canonicalPath);
      try {
        const expanded = await processContent(imported.content, canonicalPath, depth, false);
        return sourceBlock(canonicalPath, expanded);
      } finally {
        stack.pop();
      }
    };

    const processContent = async (
      content: string,
      sourcePath: string,
      depth: number,
      importsOnly: boolean,
    ): Promise<string> => {
      let output = "";
      let fence: { marker: "`" | "~"; length: number } | undefined;
      const lines = content.match(/.*(?:\r?\n|$)/g) ?? [];

      for (const line of lines) {
        if (line === "") continue;
        const body = line.replace(/\r?\n$/, "");
        const newline = line.slice(body.length);
        const openingFence = body.match(/^\s*(`{3,}|~{3,})/);
        if (!fence && openingFence) {
          const run = openingFence[1]!;
          fence = { marker: run[0] as "`" | "~", length: run.length };
          if (!importsOnly) output += line;
          continue;
        }
        if (fence) {
          const closingFence = body.match(/^\s*(`{3,}|~{3,})\s*$/)?.[1];
          if (closingFence?.[0] === fence.marker && closingFence.length >= fence.length) {
            fence = undefined;
          }
          if (!importsOnly) output += line;
          continue;
        }

        const importMatch = body.match(/^\s*@(\.\.?\/\S+|\/\S+)\s*$/);
        if (importMatch) {
          const expanded = await expandImport(importMatch[1]!, sourcePath, depth + 1);
          if (expanded) output += `${expanded}${newline || "\n"}`;
          continue;
        }

        if (!importsOnly) output += line;
      }
      return output;
    };

    return {
      text: await processContent(rootContent, canonicalRoot, 0, options.includeRoot === false),
      sources,
      importedBytes,
    };
  }

  private async canonicalizeRoot(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch {
      return path;
    }
  }

  private async readRoot(path: string): Promise<string> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      throw new MarkdownImportError(`Cannot read Markdown root ${path}: ${errorMessage(error)}`);
    }
  }

  private async readImportedFile(path: string): Promise<CachedFile> {
    let metadata;
    try {
      metadata = await stat(path);
    } catch (error) {
      throw new MarkdownImportError(`Cannot stat Markdown import ${path}: ${errorMessage(error)}`);
    }
    if (!metadata.isFile()) {
      throw new MarkdownImportError(`Markdown import is not a file: ${path}`);
    }

    const cached = this.fileCache.get(path);
    if (cached && cached.size === metadata.size && cached.mtimeMs === metadata.mtimeMs) {
      return cached;
    }

    try {
      const content = await readFile(path, "utf8");
      const loaded = { path, content, size: metadata.size, mtimeMs: metadata.mtimeMs };
      this.fileCache.set(path, loaded);
      return loaded;
    } catch (error) {
      throw new MarkdownImportError(`Cannot read Markdown import ${path}: ${errorMessage(error)}`);
    }
  }
}

export async function compileMarkdownImports(
  options: MarkdownImportOptions,
): Promise<MarkdownImportResult> {
  return new MarkdownImportResolver().compile(options);
}
