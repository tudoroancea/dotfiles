import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SessionManager, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  SDK_PROJECTION_LIMITS,
  classifySdkContent,
  measureBoundedHistory,
} from "../../src/observability/sdk-projection-bounds.ts";
const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/sessions/${name}`, import.meta.url));
const sdkEvents = [
  {
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 10,
    errorMessage: "fixture retry",
  },
  { type: "auto_retry_end", success: true, attempt: 1 },
  { type: "queue_update", steering: ["correct course"], followUp: ["then summarize"] },
  { type: "agent_settled" },
] satisfies AgentSessionEvent[];
const expected = [
  "messages",
  "thinking",
  "tools",
  "custom entries",
  "images",
  "compaction",
  "branches",
  "model changes",
  "retries",
  "queues",
  "Agentflow output",
  "background output",
];
describe("credential-free SDK projection evidence", () => {
  it("round-trips durable values through SessionManager", async () => {
    const path = fixture("representative-session.jsonl");
    const file = await readFile(path);
    const source = file
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    const manager = SessionManager.open(path);
    const entries = manager.getEntries();
    expect(entries).toEqual(source.slice(1));
    expect(manager.getHeader()).toEqual(source[0]);
    expect(manager.getTree()).toHaveLength(1);
    expect(manager.getTree()[0]?.children).toHaveLength(2);
    expect(manager.getBranch()).toHaveLength(3);
    const r = measureBoundedHistory(entries, file.byteLength);
    expect(r.degraded).toBe(false);
    expect(r.entries).toEqual(entries);
  });
  it("covers durable, live, queue, retry, and provider sources", async () => {
    const manager = SessionManager.open(fixture("representative-session.jsonl"));
    const serializedSdkEvents = JSON.parse(
      await readFile(fixture("representative-sdk-events.json"), "utf8"),
    ) as unknown[];
    const providerEvents = JSON.parse(
      await readFile(fixture("representative-provider-events.json"), "utf8"),
    ) as unknown[];
    expect(serializedSdkEvents).toEqual(sdkEvents);
    expect(providerEvents).toSatisfy((events: unknown[]) =>
      events.every(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "provider_update",
      ),
    );
    const classes = classifySdkContent([...manager.getEntries(), ...sdkEvents, ...providerEvents]);
    expect([...classes]).toEqual(expect.arrayContaining(expected));
    expect(classes.size).toBe(expected.length);
  });
  it("measures bounded page RSS at generated sizes without model work", () => {
    const before = process.memoryUsage().rss;
    const generated = Array.from({ length: 10_000 }, (_, i) => ({
      type: "message",
      id: `generated-${i}`,
      message: { role: "user", content: `entry ${i} ${"x".repeat(512)}` },
    }));
    const representative = measureBoundedHistory(generated.slice(0, 100), 64 * 1024);
    const adversarial = measureBoundedHistory(generated, SDK_PROJECTION_LIMITS.sessionBytes + 1);
    const after = process.memoryUsage().rss;
    expect(before).toBeGreaterThan(0);
    expect(after).toBeGreaterThan(0);
    expect(representative.measurement.entryCount).toBe(100);
    expect(adversarial.measurement.entryCount).toBeLessThanOrEqual(100);
    expect(adversarial.measurement.projectedBytes).toBeLessThanOrEqual(
      SDK_PROJECTION_LIMITS.historyPageBytes,
    );
    expect(adversarial.reasons).toContain("session_bytes");
  });
});
