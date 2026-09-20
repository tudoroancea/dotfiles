#!/usr/bin/env -S node --experimental-strip-types
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  SDK_PROJECTION_LIMITS,
  measureBoundedHistory,
  measureSdkProjection,
} from "../src/observability/sdk-projection-bounds.ts";
const path = fileURLToPath(
  new URL("../test/fixtures/sessions/representative-session.jsonl", import.meta.url),
);
const bytes = (await readFile(path)).byteLength;
const manager = SessionManager.open(path);
const entries = manager.getEntries();
const representative = measureBoundedHistory(entries, bytes);
const before = process.memoryUsage().rss;
const generated = Array.from({ length: 100_000 }, (_, i) => ({
  type: "message",
  id: `generated-${i}`,
  parentId: i ? `generated-${i - 1}` : null,
  message: { role: "user", content: `generated ${i} ${"x".repeat(128)}` },
}));
const loaded = process.memoryUsage().rss;
const page = measureBoundedHistory(generated, SDK_PROJECTION_LIMITS.sessionBytes + 1);
const projected = process.memoryUsage().rss;
console.log(
  JSON.stringify(
    {
      credentialFree: true,
      modelRequests: 0,
      limits: SDK_PROJECTION_LIMITS,
      representative: {
        sessionBytes: bytes,
        ...representative.measurement,
        treeRoots: manager.getTree().length,
        branchEntries: manager.getBranch().length,
      },
      generated: {
        entries: generated.length,
        source: measureSdkProjection(generated),
        historyPage: page.measurement,
        degradedReasons: page.reasons,
        rssBytes: {
          before,
          loaded,
          projected,
          loadedDelta: loaded - before,
          projectionDelta: projected - loaded,
        },
      },
    },
    null,
    2,
  ),
);
