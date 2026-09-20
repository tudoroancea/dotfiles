import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "@babel/parser";

// The shared package must stay host-neutral: no Pi APIs, Pi extension modules,
// Node HTTP/process/filesystem APIs, Tailscale code, or daemon code may leak into
// the browser bundle. Only the pinned browser runtime dependencies are allowed.

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

const ALLOWED_BARE = new Set([
  "preact",
  "preact/hooks",
  "marked",
  "dompurify",
  "typebox",
  "typebox/value",
  // Transcript virtualization. The React adapter runs on preact/compat through the
  // pinned `react`/`react-dom` -> @preact/compat package aliases; no React ships.
  "@tanstack/react-virtual",
]);
const FORBIDDEN_PATTERNS = [
  /^node:/,
  /^@earendil-works\//,
  /tailscale/i,
  /remote-session-daemon/,
  /pi-coding-agent/,
  /pi-tui/,
];

function collectSources(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSources(full));
    else if ([".ts", ".tsx"].includes(extname(entry.name))) files.push(full);
  }
  return files;
}

function collectImportSpecifiers(source, file = "source.ts") {
  const ast = parse(source, {
    sourceType: "module",
    plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
  });
  const specifiers = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration") &&
      node.source?.type === "StringLiteral"
    ) {
      specifiers.push(node.source.value);
    } else if (
      node.type === "CallExpression" &&
      node.callee?.type === "Import" &&
      node.arguments?.[0]?.type === "StringLiteral"
    ) {
      specifiers.push(node.arguments[0].value);
    } else if (node.type === "ImportExpression" && node.source?.type === "StringLiteral") {
      specifiers.push(node.source.value);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object" && typeof value.type === "string") visit(value);
    }
  };
  visit(ast.program);
  return specifiers;
}

function collectOffenders(file, source) {
  const offenders = [];
  for (const specifier of collectImportSpecifiers(source, file)) {
    if (specifier.startsWith(".")) continue;
    if (ALLOWED_BARE.has(specifier)) continue;
    if (
      specifier === "highlight.js/lib/core" ||
      specifier.startsWith("highlight.js/lib/languages/")
    )
      continue;
    if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(specifier))) {
      offenders.push(`${file}: forbidden import "${specifier}"`);
    } else {
      offenders.push(`${file}: unexpected non-allowlisted import "${specifier}"`);
    }
  }
  return offenders;
}

test("import-boundary scanner catches multiline and commented declarations", () => {
  const source = `
    import {
      /* don't use Node; "even in comments" */
      forbiddenApi,
    } from
      "node:http";
    export {
      daemonApi,
    } from
      "remote-session-daemon/client";
    void forbiddenApi;
    import type {
      Static,
    } from "typebox";
    const lazy = import("@earendil-works/pi-coding-agent");
  `;
  assert.deepEqual(collectOffenders("multiline.ts", source), [
    'multiline.ts: forbidden import "node:http"',
    'multiline.ts: forbidden import "remote-session-daemon/client"',
    'multiline.ts: forbidden import "@earendil-works/pi-coding-agent"',
  ]);
});

test("shared package imports stay host-neutral", () => {
  const offenders = collectSources(srcDir).flatMap((file) =>
    collectOffenders(file, readFileSync(file, "utf8")),
  );
  assert.deepEqual(offenders, [], offenders.join("\n"));
});
