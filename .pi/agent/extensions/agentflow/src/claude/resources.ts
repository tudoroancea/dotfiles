import type { Skill } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

export interface ClaudeSkill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
}

export class ClaudeResourceSnapshot {
  private skills: readonly ClaudeSkill[] = [];

  capture(skills: readonly Skill[] | undefined): void {
    this.skills = Object.freeze(
      (skills ?? []).map((skill) =>
        Object.freeze({
          name: skill.name,
          description: skill.description,
          filePath: skill.filePath,
          baseDir: skill.baseDir,
        }),
      ),
    );
  }

  clear(): void {
    this.skills = [];
  }

  getSkills(): readonly ClaudeSkill[] {
    return this.skills;
  }
}

export interface StagedClaudeSkills {
  root: string;
  names: string[];
  index: string;
  cleanup(): Promise<void>;
}

const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

export async function stageClaudeSkills(
  skills: readonly ClaudeSkill[],
): Promise<StagedClaudeSkills> {
  const seen = new Set<string>();
  for (const skill of skills) {
    if (!SAFE_SKILL_NAME.test(skill.name) || skill.name === "." || skill.name === "..")
      throw new Error(`Invalid Claude skill name: ${JSON.stringify(skill.name)}`);
    if (seen.has(skill.name)) throw new Error(`Duplicate Claude skill name: ${skill.name}`);
    seen.add(skill.name);
  }

  const root = await mkdtemp(join(tmpdir(), "pi-agentflow-claude-"));
  try {
    const targetRoot = join(root, ".claude", "skills");
    await mkdir(targetRoot, { recursive: true });
    for (const skill of skills) {
      try {
        const [base, file] = await Promise.all([stat(skill.baseDir), stat(skill.filePath)]);
        if (!base.isDirectory()) throw new Error(`skill base is not a directory: ${skill.baseDir}`);
        if (!file.isFile()) throw new Error(`skill file is not a file: ${skill.filePath}`);
        const canonicalBase = await realpath(skill.baseDir);
        const canonicalFile = await realpath(skill.filePath);
        const relativeFile = relative(canonicalBase, canonicalFile);
        if (relativeFile.startsWith("..") || isAbsolute(relativeFile))
          throw new Error("skill file is outside its base directory");
        await symlink(canonicalBase, join(targetRoot, skill.name), "dir");
      } catch (error) {
        throw new Error(
          `Cannot stage Claude skill ${skill.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return {
      root,
      names: skills.map((skill) => skill.name),
      index: skills.length
        ? skills.map((skill) => `- ${skill.name}: ${oneLine(skill.description)}`).join("\n")
        : "- None",
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

const execFileAsync = promisify(execFile);

export async function resolveProjectRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    const root = stdout.trim();
    return root ? resolve(root) : resolve(cwd);
  } catch {
    return resolve(cwd);
  }
}

export async function loadProjectAgentsContext(cwd: string): Promise<string | undefined> {
  const path = join(await resolveProjectRoot(cwd), "AGENTS.md");
  try {
    const content = await readFile(path);
    if (content.byteLength > 64 * 1024)
      throw new Error(
        `project AGENTS.md exceeds the 65536 byte limit (${content.byteLength} bytes)`,
      );
    return content.toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Cannot read project AGENTS.md at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function buildClaudeUserPrompt(task: string, projectContext: string | undefined): string {
  const boundary = `AGENTFLOW-${randomUUID()}`;
  const context = projectContext
    ? `----- BEGIN PROJECT AGENTS.md ${boundary} -----\n${projectContext}\n----- END PROJECT AGENTS.md ${boundary} -----\n\n`
    : "";
  return `${context}----- BEGIN TASK ${boundary} -----\n${task}\n----- END TASK ${boundary} -----`;
}
