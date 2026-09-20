import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("fallback tool states use the terminal theme's shared neutral background", () => {
  const values = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"].map((name) =>
    styles.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim(),
  );
  assert.deepEqual(values, ["#2a283e", "#2a283e", "#2a283e"]);
  assert.match(styles, /\.tool-execution\.pending\s*{[^}]*var\(--toolPendingBg\)/s);
  assert.match(styles, /\.tool-execution\.success\s*{[^}]*var\(--toolSuccessBg\)/s);
  assert.match(styles, /\.tool-execution\.error\s*{[^}]*var\(--toolErrorBg\)/s);
});

test("workflow node headings preserve the subagent name and trim the prompt", () => {
  assert.match(
    styles,
    /\.agentflow-node-heading \.agentflow-tool-name,[^{]+{[^}]*flex:\s*0 0 auto;/s,
  );
  assert.match(
    styles,
    /\.agentflow-node-heading \.agentflow-tool-argument\s*{[^}]*flex:\s*1 1 auto;/s,
  );
  assert.match(
    styles,
    /\.agentflow-tool-argument\s*{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s,
  );
});
