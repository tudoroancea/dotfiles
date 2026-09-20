import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ApprovedRootConfig } from "./schema.ts";

export interface PriorTrustPolicy {
  isTrusted(input: {
    rootAlias: string;
    canonicalRoot: string;
    canonicalCwd: string;
  }): boolean | Promise<boolean>;
}

export interface FileIdentity {
  dev: number;
  ino: number;
}
export interface ResolvedApprovedDirectory {
  rootAlias: string;
  canonicalRoot: string;
  canonicalCwd: string;
  rootIdentity: FileIdentity;
  cwdIdentity: FileIdentity;
}

export class RootResolutionError extends Error {
  constructor(
    readonly code:
      | "unknown_root"
      | "invalid_relative_path"
      | "missing_directory"
      | "not_directory"
      | "outside_root"
      | "not_trusted",
    message: string,
  ) {
    super(message);
    this.name = "RootResolutionError";
  }
}

export function isPathWithinRoot(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export function approvedRootByAlias(
  roots: readonly ApprovedRootConfig[],
  alias: string,
): ApprovedRootConfig | undefined {
  return roots.find((root) => root.alias === alias);
}

function validateRelativePath(path: string): void {
  if (path.length === 0 || path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path))
    throw new RootResolutionError("invalid_relative_path", "A non-empty relative path is required");
  const components = path.split(/[\\/]/);
  if (components.some((component) => component === ".."))
    throw new RootResolutionError("invalid_relative_path", "Parent traversal is not allowed");
}

export async function resolveApprovedDirectory(
  roots: readonly ApprovedRootConfig[],
  rootAlias: string,
  relativePath: string,
  trust: PriorTrustPolicy,
): Promise<ResolvedApprovedDirectory> {
  const configured = approvedRootByAlias(roots, rootAlias);
  if (!configured) throw new RootResolutionError("unknown_root", "Unknown approved root");
  validateRelativePath(relativePath);

  let canonicalRoot: string;
  let canonicalCwd: string;
  try {
    canonicalRoot = await realpath(configured.path);
  } catch {
    throw new RootResolutionError("missing_directory", "Approved root is unavailable");
  }
  try {
    canonicalCwd = await realpath(resolve(canonicalRoot, relativePath));
  } catch {
    throw new RootResolutionError("missing_directory", "Requested directory does not exist");
  }
  if (!isPathWithinRoot(canonicalRoot, canonicalCwd))
    throw new RootResolutionError("outside_root", "Requested directory escapes its approved root");
  const rootStat = await stat(canonicalRoot);
  const cwdStat = await stat(canonicalCwd);
  if (!rootStat.isDirectory() || !cwdStat.isDirectory())
    throw new RootResolutionError("not_directory", "Requested path is not a directory");
  if (!(await trust.isTrusted({ rootAlias, canonicalRoot, canonicalCwd })))
    throw new RootResolutionError("not_trusted", "Directory has not been trusted locally");
  const resolved = {
    rootAlias,
    canonicalRoot,
    canonicalCwd,
    rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
    cwdIdentity: { dev: cwdStat.dev, ino: cwdStat.ino },
  };
  await revalidateApprovedDirectory(configured, relativePath, resolved);
  return resolved;
}

function sameFile(actual: { dev: number; ino: number }, expected: FileIdentity): boolean {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

export async function revalidateApprovedDirectory(
  configured: ApprovedRootConfig,
  relativePath: string,
  expected: ResolvedApprovedDirectory,
): Promise<void> {
  const canonicalRoot = await realpath(configured.path).catch(() => "");
  const canonicalCwd = canonicalRoot
    ? await realpath(resolve(canonicalRoot, relativePath)).catch(() => "")
    : "";
  if (
    canonicalRoot !== expected.canonicalRoot ||
    canonicalCwd !== expected.canonicalCwd ||
    !isPathWithinRoot(canonicalRoot, canonicalCwd)
  )
    throw new RootResolutionError("outside_root", "Approved path changed during validation");
  const [rootStat, cwdStat] = await Promise.all([stat(canonicalRoot), stat(canonicalCwd)]);
  if (
    !rootStat.isDirectory() ||
    !cwdStat.isDirectory() ||
    !sameFile(rootStat, expected.rootIdentity) ||
    !sameFile(cwdStat, expected.cwdIdentity)
  )
    throw new RootResolutionError("not_directory", "Approved directory identity changed");
}

export const resolveApprovedRoot = resolveApprovedDirectory;
