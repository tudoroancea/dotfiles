import { readFile } from "node:fs/promises";
import { validateDaemonConfig, type DaemonConfig } from "./schema.ts";

export async function loadDaemonConfig(path: string): Promise<DaemonConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to load daemon config at ${path}`, { cause: error });
  }
  return validateDaemonConfig(parsed);
}
