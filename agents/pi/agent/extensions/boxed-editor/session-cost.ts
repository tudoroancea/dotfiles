import { summarizeSessionCost } from "../lib/session-cost.ts";

export function getSessionCost(entries: readonly unknown[]): number {
  return summarizeSessionCost(entries).total;
}
