// Read-only, no-build browser view of the current Pi session.
//
// The transcript rendering is a Preact port of Pi's HTML exporter
// (packages/coding-agent/src/core/export-html/template.js), reduced to the
// single-column message list. Data arrives as full snapshots over SSE; there is
// no client protocol, reducer, or virtualization.

import { h, render, createContext } from "https://esm.sh/preact@10.24.3";
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "https://esm.sh/preact@10.24.3/hooks";
import htm from "https://esm.sh/htm@3.1.1";
import { marked } from "https://esm.sh/marked@14.1.3";

const html = htm.bind(h);

// ---------------------------------------------------------------------------
// Display preferences (persisted to localStorage, toggled by document hotkeys)
// ---------------------------------------------------------------------------

// Each entry defines a boolean display toggle: its localStorage key, the plain
// single-key hotkey that flips it, a short label shown in the command palette,
// and the default applied on first visit. All default to hidden/collapsed per
// the roadmap.
const PREFS = [
  { key: "thinking", hotkey: "t", label: "thinking", default: false },
  { key: "tools", hotkey: "e", label: "tool output", default: false },
  { key: "timestamps", hotkey: "s", label: "timestamps", default: false },
  { key: "switches", hotkey: "m", label: "model / thinking", default: false },
  { key: "systemPrompt", hotkey: "p", label: "system prompt", default: false },
];

const PrefsContext = createContext({ prefs: {}, toggle: () => {} });

const storageKey = (key) => `web-ui-simple.pref.${key}`;
const cookieKey = (key) => `pi_web_ui_simple_${key}`;

function readPreference(key) {
  const prefix = `${cookieKey(key)}=`;
  const cookie = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  if (cookie) return cookie.slice(prefix.length) === "1";
  try {
    const stored = localStorage.getItem(storageKey(key));
    return stored === null ? undefined : stored === "1";
  } catch {
    return undefined;
  }
}

function persistPreference(key, value) {
  const stored = value ? "1" : "0";
  try {
    localStorage.setItem(storageKey(key), stored);
  } catch {
    // Persistence remains best-effort.
  }
  try {
    // Cookies are host-scoped rather than port-scoped, so this fallback carries
    // preferences across the server's ephemeral ports.
    document.cookie = `${cookieKey(key)}=${stored}; Path=/; Max-Age=31536000; SameSite=Strict`;
  } catch {
    // The same-server localStorage value still applies when cookies are blocked.
  }
}

function usePreferences(blockedRef) {
  const [prefs, setPrefs] = useState(() => {
    const initial = {};
    for (const pref of PREFS) {
      initial[pref.key] = readPreference(pref.key) ?? pref.default;
    }
    return initial;
  });

  const toggle = (key) =>
    setPrefs((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      persistPreference(key, next[key]);
      return next;
    });

  useEffect(() => {
    const onKeyDown = (event) => {
      // The command palette owns keyboard focus while open; plain-key toggles stay quiet.
      if (blockedRef?.current) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return;
      const target = event.target;
      if (
        target &&
        (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName || ""))
      ) {
        return;
      }
      const pref = PREFS.find((p) => p.hotkey === event.key.toLowerCase());
      if (!pref) return;
      event.preventDefault();
      toggle(pref.key);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return { prefs, toggle };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeMarkdownUrl(value) {
  const href = String(value || "")
    .trim()
    .replace(/[\x00-\x1f\x7f]/g, "");
  const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i);
  return scheme && !/^(https?|mailto|tel|ftp)$/i.test(scheme[1]) ? null : href;
}

// Match the exporter: render Markdown but treat raw HTML/tags as literal text
// and only emit links and images with browser-safe URL schemes.
marked.use({
  breaks: true,
  gfm: true,
  tokenizer: {
    html() {
      return undefined;
    },
    tag() {
      return undefined;
    },
  },
  renderer: {
    link(token) {
      const href = sanitizeMarkdownUrl(token.href);
      if (href === null) return this.parser.parseInline(token.tokens);
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<a href="${escapeHtml(href)}"${title}>${this.parser.parseInline(token.tokens)}</a>`;
    },
    image(token) {
      const href = sanitizeMarkdownUrl(token.href);
      if (href === null) return escapeHtml(token.text || "");
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(token.text || "")}"${title}>`;
    },
  },
});

// ---------------------------------------------------------------------------
// Helpers (ported from the exporter)
// ---------------------------------------------------------------------------

function shortenPath(p) {
  if (typeof p !== "string") return "";
  for (const prefix of ["/Users/", "/home/"]) {
    if (p.startsWith(prefix)) {
      const parts = p.split("/");
      if (parts.length > 2) return "~" + p.slice((prefix + parts[2]).length);
    }
  }
  return p;
}

function str(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return null;
}

function replaceTabs(text) {
  return text.replace(/\t/g, "   ");
}

function formatTimestamp(ts) {
  if (!ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

function images(content) {
  return Array.isArray(content) ? content.filter((c) => c && c.type === "image") : [];
}

function parseSkillBlock(text) {
  const match = text.match(
    /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/,
  );
  if (!match) return null;
  return {
    name: match[1],
    content: match[3],
    userMessage: match[4]?.trim() || "",
  };
}

function resultText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((c) => c && c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncate(value, max = 80) {
  if (typeof value !== "string") return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function compactCommand(value) {
  if (typeof value !== "string" || !value) return "...";
  const oneLine = value.replace(/\s*\n\s*/g, " ↵ ");
  return oneLine.length > 100 ? `${oneLine.slice(0, 97)}...` : oneLine;
}

function compactLineCount(text) {
  if (!text || text === "(no output)") return 0;
  return text.split("\n").length;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
}

function readTruncationNotice(result) {
  const truncation = record(result?.details).truncation;
  if (!truncation?.truncated) return "";
  if (truncation.firstLineExceedsLimit) {
    return `[First line exceeds ${formatSize(number(truncation.maxBytes) ?? 50 * 1024)} limit]`;
  }
  if (truncation.truncatedBy === "lines") {
    return `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? 2000} line limit)]`;
  }
  return `[Truncated: ${truncation.outputLines} lines shown (${formatSize(number(truncation.maxBytes) ?? 50 * 1024)} limit)]`;
}

function pluralize(count, noun) {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

function formatDuration(milliseconds) {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds)) return "";
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1000)}s`;
}

function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function formatTokens(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function formatCost(cost) {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

function statusIcon(status) {
  if (status === "queued") return "·";
  if (status === "running") return "◆";
  if (status === "completed") return "✓";
  if (status === "failed") return "✗";
  return "◇";
}

function oneLine(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function diffStats(diff) {
  let additions = 0;
  let removals = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }
  return { additions, removals };
}

function resolveSessionTitle(snapshot) {
  const sessionName = typeof snapshot.sessionName === "string" ? snapshot.sessionName.trim() : "";
  if (sessionName) return sessionName;
  const sessionId = typeof snapshot.header?.id === "string" ? snapshot.header.id.trim() : "";
  return sessionId || "Pi session";
}

// ---------------------------------------------------------------------------
// Small presentational components
// ---------------------------------------------------------------------------

function Markdown({ text }) {
  const markup = useMemo(() => marked.parse(text ?? ""), [text]);
  return html`<div class="markdown-content" dangerouslySetInnerHTML=${{ __html: markup }} />`;
}

function ImageBlock({ list, cls }) {
  if (!list.length) return null;
  return html`<div class="message-images">
    ${list.map(
      (img, i) =>
        html`<img
          key=${i}
          class=${cls}
          src=${`data:${img.mimeType || "image/png"};base64,${img.data || ""}`}
        />`,
    )}
  </div>`;
}

function Lines({ text }) {
  return html`${replaceTabs(text)
    .split("\n")
    .map((line, i) => html`<div key=${i}>${line}</div>`)}`;
}

// Terminal-style output block with exporter-like expand-on-click for long output.
function ExpandableOutput({ text, maxLines, tone = "" }) {
  const { prefs } = useContext(PrefsContext);
  const [expanded, setExpanded] = useState(prefs.tools);
  // The global "tool output" hotkey expands/collapses every block at once;
  // per-block clicks still override until the next global toggle.
  useEffect(() => setExpanded(prefs.tools), [prefs.tools]);
  const clean = replaceTabs(text);
  const lines = clean.split("\n");
  const remaining = lines.length - maxLines;

  if (remaining <= 0) {
    return html`<div class="tool-output ${tone}"><${Lines} text=${clean} /></div>`;
  }
  const onKeyDown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setExpanded((value) => !value);
  };
  if (expanded) {
    return html`<div
      class="tool-output expandable ${tone}"
      role="button"
      tabindex="0"
      aria-expanded="true"
      aria-label="Collapse tool output"
      onKeyDown=${onKeyDown}
      onClick=${() => {
        if (window.getSelection().toString()) return;
        setExpanded(false);
      }}
    >
      <${Lines} text=${clean} />
    </div>`;
  }
  return html`<div
    class="tool-output expandable ${tone}"
    role="button"
    tabindex="0"
    aria-expanded="false"
    aria-label="Expand tool output"
    onKeyDown=${onKeyDown}
    onClick=${() => {
      if (window.getSelection().toString()) return;
      setExpanded(true);
    }}
  >
    <${Lines} text=${lines.slice(0, maxLines).join("\n")} />
    <div class="expand-hint">... (${remaining} more lines)</div>
  </div>`;
}

function ToolDetails({ label = "details", children }) {
  const { prefs } = useContext(PrefsContext);
  const [open, setOpen] = useState(prefs.tools);
  useEffect(() => setOpen(prefs.tools), [prefs.tools]);
  return html`<div class="tool-details">
    <button
      type="button"
      class="tool-details-toggle"
      aria-expanded=${open ? "true" : "false"}
      onClick=${() => setOpen((value) => !value)}
    >
      ${open ? "▾" : "▸"} ${label}
    </button>
    ${open ? html`<div class="tool-details-body">${children}</div>` : null}
  </div>`;
}

function Diff({ diff, maxLines = 10 }) {
  const { prefs } = useContext(PrefsContext);
  const [expanded, setExpanded] = useState(prefs.tools);
  useEffect(() => setExpanded(prefs.tools), [prefs.tools]);
  const lines = diff.split("\n");
  const remaining = lines.length - maxLines;
  const visible = expanded || remaining <= 0 ? lines : lines.slice(0, maxLines);
  const onKeyDown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setExpanded((value) => !value);
  };
  const content = html`${visible.map((line, i) => {
    const cls = line.startsWith("+")
      ? "diff-added"
      : line.startsWith("-")
        ? "diff-removed"
        : "diff-context";
    return html`<div key=${i} class=${cls}>${replaceTabs(line)}</div>`;
  })}${!expanded && remaining > 0
    ? html`<div class="expand-hint">... (${remaining} more lines)</div>`
    : null}`;

  if (remaining <= 0) return html`<div class="tool-diff">${content}</div>`;
  return html`<div
    class="tool-diff expandable"
    role="button"
    tabindex="0"
    aria-expanded=${expanded ? "true" : "false"}
    aria-label=${expanded ? "Collapse edit diff" : "Expand edit diff"}
    onKeyDown=${onKeyDown}
    onClick=${() => {
      if (window.getSelection().toString()) return;
      setExpanded((value) => !value);
    }}
  >
    ${content}
  </div>`;
}

// ---------------------------------------------------------------------------
// Tool calls (exporter built-ins + renderers for the locally installed tools)
// ---------------------------------------------------------------------------

function Facts({ items }) {
  const visible = items.filter((item) => item && item.value !== undefined && item.value !== "");
  if (!visible.length) return null;
  return html`<dl class="tool-facts">
    ${visible.map(
      (item, index) => html`<div key=${index} class="tool-fact ${item.error ? "error" : ""}">
        <dt>${item.label}</dt>
        <dd>${item.value}</dd>
      </div>`,
    )}
  </dl>`;
}

const AGENTFLOW_RUN_TOOLS = new Set([
  "agentflow_finder",
  "agentflow_oracle",
  "agentflow_librarian",
  "agentflow_look_at",
  "agentflow_delegate",
  "agentflow_review",
  "agentflow_claude",
  "agentflow_agent",
]);

const AGENTFLOW_LABELS = {
  agentflow_finder: ["finder", "task"],
  agentflow_oracle: ["oracle", "question"],
  agentflow_librarian: ["librarian", "question"],
  agentflow_look_at: ["look at", "objective"],
  agentflow_delegate: ["delegate", "task"],
  agentflow_review: ["review", "task"],
  agentflow_claude: ["claude", "task"],
  agentflow_workflow: ["workflow", "script"],
  agentflow_agent: ["agent", "prompt"],
  agentflow_status: ["status", "runId"],
  agentflow_wait: ["wait", "runIds"],
  agentflow_cancel: ["cancel", "runIds"],
  agentflow_steer: ["steer", "runId"],
};

function RunNode({ node }) {
  const calls = array(node.toolCalls).map(record);
  const usage = record(node.usage);
  const usageParts = [];
  if (number(usage.total) !== undefined) usageParts.push(`${usage.total.toLocaleString()} tok`);
  if (number(usage.cost) !== undefined) usageParts.push(`$${usage.cost.toFixed(4)}`);
  return html`<li class="run-node">
    <div class="structured-head">
      <span>${node.label || node.id || "node"}</span>
      <span class="structured-status status-${node.status || "unknown"}">${node.status || ""}</span>
    </div>
    ${node.resultPreview ? html`<p>${truncate(node.resultPreview, 160)}</p>` : null}
    ${node.error ? html`<p class="tool-error">${truncate(node.error, 240)}</p>` : null}
    ${usageParts.length ? html`<p class="structured-muted">${usageParts.join(" · ")}</p>` : null}
    ${calls.length
      ? html`<ul class="run-tools">
          ${calls.map(
            (tool, index) => html`<li key=${index}>
              <strong>${tool.name || "tool"}</strong>
              ${tool.argumentSummary ? html` <span>${tool.argumentSummary}</span>` : null}
              ${tool.resultPreview
                ? html` <span class="structured-muted">— ${truncate(tool.resultPreview, 60)}</span>`
                : null}
              ${tool.error
                ? html` <span class="tool-error">${truncate(tool.error, 120)}</span>`
                : null}
              ${tool.status
                ? html` <span class="structured-status status-${tool.status}">${tool.status}</span>`
                : null}
            </li>`,
          )}
        </ul>`
      : null}
  </li>`;
}

function semanticRunSummary(snapshot, node) {
  const usage = record(node.usage);
  const tools = number(node.tools) ?? 0;
  const tokens = number(usage.total) ?? 0;
  const cost = number(usage.cost) ?? 0;
  const role = snapshot.semanticRole || node.semanticRole;
  let prefix = "";
  if (typeof node.resultPreview === "string") {
    try {
      const value = JSON.parse(node.resultPreview);
      if ((role === "finder" || role === "review") && Array.isArray(value.findings)) {
        prefix = `${pluralize(value.findings.length, "finding")} · `;
      } else if (role === "librarian" && Array.isArray(value.sources)) {
        prefix = `${pluralize(value.sources.length, "source")} · `;
      } else if (role === "look_at" && Array.isArray(value.observations)) {
        prefix = `${pluralize(value.observations.length, "observation")} · `;
      } else if (role === "delegate" && Array.isArray(value.filesChanged)) {
        prefix = `${pluralize(value.filesChanged.length, "file")} · `;
      } else if (role === "oracle" && typeof value.recommendation === "string") {
        prefix = "recommendation · ";
      }
    } catch {
      // Streaming previews are commonly incomplete JSON.
    }
  }
  return `${prefix}${tools} tools · ${formatTokens(tokens)} tokens · ${formatCost(cost)}`;
}

function AgentflowToolRow({ call, expanded }) {
  const status = typeof call.status === "string" ? call.status : "queued";
  return html`<li class="agentflow-tool-row">
    <span class="agentflow-status status-${status}" aria-label=${status}
      >${statusIcon(status)}</span
    >
    <span class="agentflow-tool-name">${call.name || "tool"}</span>
    <span class="agentflow-tool-argument">${oneLine(call.argumentSummary)}</span>
    ${expanded && call.argumentsPreview
      ? html`<span class="agentflow-tool-detail"
          ><b>args:</b> ${oneLine(call.argumentsPreview)}</span
        >`
      : null}
    ${expanded && call.error
      ? html`<span class="agentflow-tool-detail error"><b>error:</b> ${oneLine(call.error)}</span>`
      : expanded && call.resultPreview
        ? html`<span class="agentflow-tool-detail"
            ><b>result:</b> ${oneLine(call.resultPreview)}</span
          >`
        : null}
  </li>`;
}

function AgentflowLiveSnapshot({ snapshot, expanded, onToggle }) {
  const node = record(array(snapshot.nodes)[0]);
  const calls = array(node.toolCalls).map(record);
  const visibleCalls = expanded ? calls : calls.slice(-8);
  const omitted = calls.length - visibleCalls.length;
  const status = node.status || snapshot.status || "queued";
  const execution = node.backend ? `${node.backend}/${node.model || "default"}` : "";
  const logs = array(snapshot.logs).filter((line) => typeof line === "string");

  return html`<div class="agentflow-live-run">
    ${omitted > 0
      ? html`<div class="agentflow-omitted">… ${pluralize(omitted, "earlier tool call")}</div>`
      : null}
    ${visibleCalls.length
      ? html`<ul class="agentflow-tool-list">
          ${visibleCalls.map(
            (call, index) => html`<${AgentflowToolRow}
              key=${call.id || index}
              call=${call}
              expanded=${expanded}
            />`,
          )}
        </ul>`
      : null}
    ${expanded
      ? html`<div class="agentflow-expanded">
          ${node.error
            ? html`<div class="tool-error">${node.error}</div>`
            : node.resultPreview
              ? html`<${ExpandableOutput} text=${node.resultPreview} maxLines=${24} />`
              : null}
          <${Facts}
            items=${[
              { label: "Run", value: snapshot.runId },
              { label: "Cwd", value: node.cwd },
              { label: "Backend", value: execution },
              { label: "Session", value: node.sessionFile },
              { label: "Artifacts", value: snapshot.artifactDir },
            ]}
          />
          ${logs.length
            ? html`<${ExpandableOutput} text=${logs.join("\n")} maxLines=${5} />`
            : null}
        </div>`
      : null}
    <button
      type="button"
      class="agentflow-run-footer"
      aria-expanded=${expanded ? "true" : "false"}
      onClick=${onToggle}
    >
      <span class="agentflow-run-status status-${status}">${statusIcon(status)} ${status}</span>
      ${execution ? html`<span> · ${execution}</span>` : null}
      <span> · ${semanticRunSummary(snapshot, node)}</span>
      <span> · click to ${expanded ? "collapse" : "expand"}</span>
    </button>
  </div>`;
}

function AgentflowSnapshot({ snapshot }) {
  const nodes = array(snapshot.nodes).map(record);
  const phases = array(snapshot.phases)
    .filter((phase) => typeof phase === "string")
    .join(" → ");
  const logs = array(snapshot.logs).filter((line) => typeof line === "string");
  const label =
    snapshot.name ||
    snapshot.semanticRole ||
    (typeof snapshot.originTool === "string"
      ? snapshot.originTool.replace(/^agentflow_/, "")
      : "") ||
    snapshot.kind ||
    "run";
  return html`<div class="agentflow-run">
    <${Facts}
      items=${[
        { label: "Run", value: snapshot.runId || "—" },
        { label: "Kind", value: label },
        {
          label: "Status",
          value: snapshot.status || "—",
          error: /error|failed|aborted/.test(snapshot.status),
        },
        { label: "Phases", value: phases },
        { label: "Phase", value: snapshot.currentPhase },
        { label: "Completed", value: snapshot.completedAt },
        { label: "Artifacts", value: snapshot.artifactDir },
      ]}
    />
    ${snapshot.error ? html`<p class="tool-error">${truncate(snapshot.error, 320)}</p>` : null}
    ${nodes.length
      ? html`<ul class="run-nodes">
          ${nodes.map((node, index) => html`<${RunNode} key=${index} node=${node} />`)}
        </ul>`
      : null}
    ${logs.length ? html`<${ExpandableOutput} text=${logs.join("\n")} maxLines=${5} />` : null}
  </div>`;
}

function AgentflowResult({ name, result }) {
  const details = record(result?.details);
  let snapshots = [];
  if (name === "agentflow_wait") snapshots = array(details.results);
  else if (name === "agentflow_cancel") snapshots = array(details.snapshots);
  else if (Array.isArray(details.snapshot)) snapshots = details.snapshot;
  else if (Object.keys(record(details.snapshot)).length) snapshots = [details.snapshot];

  if (AGENTFLOW_RUN_TOOLS.has(name) && snapshots.length) {
    return html`<${AgentflowLiveResult} snapshots=${snapshots} />`;
  }

  return html`<${ToolDetails}
    label=${snapshots.length ? pluralize(snapshots.length, "run") : "result"}
  >
    ${resultText(result).trim()
      ? html`<div class="agentflow-result"><${Markdown} text=${resultText(result)} /></div>`
      : null}
    ${snapshots.map((item, index) => {
      const value = record(item);
      const snapshot = record(value.snapshot || value);
      return html`<div key=${index} class="run-list-item">
        ${value.result ? html`<p>${truncate(value.result, 200)}</p>` : null}
        ${value.error ? html`<p class="tool-error">${truncate(value.error, 240)}</p>` : null}
        <${AgentflowSnapshot} snapshot=${snapshot} />
      </div>`;
    })}
    ${!snapshots.length && !resultText(result).trim()
      ? html`<div class="structured-muted">No run details</div>`
      : null}
  <//>`;
}

function AgentflowLiveResult({ snapshots }) {
  const { prefs } = useContext(PrefsContext);
  const [expanded, setExpanded] = useState(prefs.tools);
  useEffect(() => setExpanded(prefs.tools), [prefs.tools]);
  return html`<div class="agentflow-live-results">
    ${snapshots.map((item, index) => {
      const value = record(item);
      const snapshot = record(value.snapshot || value);
      return html`<${AgentflowLiveSnapshot}
        key=${snapshot.runId || index}
        snapshot=${snapshot}
        expanded=${expanded}
        onToggle=${() => setExpanded((open) => !open)}
      />`;
    })}
  </div>`;
}

function JobCard({ job }) {
  const monitor = record(job.monitor);
  const errors = [
    job.error,
    job.deliveryError,
    job.deliveryPersistenceError,
    job.monitorDeliveryPersistenceError,
    monitor.deliveryError,
  ].filter((value) => typeof value === "string" && value);
  return html`<div class="background-job">
    <div class="structured-head">
      <span>${compactCommand(job.command)}</span>
      <span class="structured-status status-${job.status || "unknown"}">${job.status || ""}</span>
    </div>
    <${Facts}
      items=${[
        { label: "Task", value: job.description },
        { label: "Job", value: job.jobId || "—" },
        {
          label: "Exit",
          value: number(job.exitCode) !== undefined ? String(job.exitCode) : "",
          error: number(job.exitCode) > 0,
        },
        { label: "Elapsed", value: formatDuration(number(job.durationMs)) },
        { label: "Output", value: formatBytes(number(job.outputBytes)) },
        { label: "Delivery", value: job.deliveryState },
        { label: "Log", value: job.outputPath },
        {
          label: "Deliveries",
          value: number(monitor.deliveries) !== undefined ? String(monitor.deliveries) : "",
        },
        {
          label: "Dropped",
          value: number(monitor.droppedLines)
            ? `${monitor.droppedLines} lines / ${monitor.droppedBytes || 0} bytes`
            : "",
        },
      ]}
    />
    ${errors.map((error, index) => html`<p key=${index} class="tool-error">${error}</p>`)}
    ${typeof job.tail === "string" && job.tail
      ? html`<${ExpandableOutput} text=${job.tail} maxLines=${10} />`
      : null}
    ${job.tailTruncated ? html`<p class="structured-muted">Output tail truncated</p>` : null}
  </div>`;
}

function BackgroundResult({ result }) {
  const details = record(result?.details);
  const jobs = array(details.jobs).map(record);
  const omitted = number(details.omittedCount) || 0;
  const omittedJobs = record(details.omittedJobs);
  return html`<${ToolDetails} label=${jobs.length ? pluralize(jobs.length, "job") : "result"}>
    <div class="background-jobs">
      ${jobs.map((job, index) => html`<${JobCard} key=${job.jobId || index} job=${job} />`)}
    </div>
    ${!jobs.length && resultText(result).trim()
      ? html`<${ExpandableOutput} text=${resultText(result).trim()} maxLines=${10} />`
      : null}
    ${omitted
      ? html`<p class="structured-muted">
          ${pluralize(omitted, "job")}
          omitted${omittedJobs.firstJobId && omittedJobs.lastJobId
            ? ` (${omittedJobs.firstJobId}…${omittedJobs.lastJobId})`
            : ""}${omittedJobs.guidance ? ` — ${omittedJobs.guidance}` : ""}
        </p>`
      : null}
    ${details.truncated && !omitted
      ? html`<p class="structured-muted">Result payload or output tail truncated</p>`
      : null}
  <//>`;
}

function ToolCall({ call, result }) {
  const { prefs } = useContext(PrefsContext);
  const expanded = prefs.tools;
  const status = result
    ? result.isError
      ? "error"
      : result.isPartial
        ? "pending"
        : "success"
    : "pending";
  const args = call.arguments || {};
  const name = call.name;
  const invalid = html`<span class="tool-error">[invalid arg]</span>`;
  const resultImages = result ? images(result.content) : [];

  let body;

  if (name === "bash") {
    const command = str(args.command);
    const output = resultText(result);
    const outputLines = compactLineCount(output);
    const commandLine = h("div", { class: "tool-command" }, [
      h("span", { class: "tool-name" }, "$"),
      " ",
      h(
        "span",
        { class: "tool-argument" },
        command === null ? invalid : compactCommand(command || ""),
      ),
      args.timeout ? h("span", { class: "line-count" }, ` (${args.timeout}s timeout)`) : null,
    ]);
    const summary = outputLines
      ? `${outputLines} output line${outputLines === 1 ? "" : "s"}`
      : "no output";
    body = html`${commandLine}${result && expanded && output
      ? html`<div class="tool-output"><${Lines} text=${output} /></div>`
      : result && !expanded && !result.isPartial
        ? html`<div class=${result.isError ? "compact-result error" : "compact-result"}>
            ${result.isError ? `failed · ${summary}` : summary}
          </div>`
        : null}`;
  } else if (name === "read") {
    const filePath = str(args.file_path ?? args.path);
    const output = resultText(result).replace(/\n+$/, "");
    const truncationNotice = readTruncationNotice(result);
    let suffix = "";
    if (filePath !== null && (args.offset !== undefined || args.limit !== undefined)) {
      const start = args.offset ?? 1;
      const end = args.limit !== undefined ? start + args.limit - 1 : "";
      suffix = `:${start}${end ? `-${end}` : ""}`;
    }
    body = html`<div class="tool-header">
        <span class="tool-name">read</span>${" "}
        <span class="tool-path"
          >${filePath === null ? invalid : shortenPath(filePath || "")}<span class="line-numbers"
            >${suffix}</span
          ></span
        >
      </div>
      <${ImageBlock} list=${resultImages} cls="tool-image" />
      ${result && output && (expanded || result.isError)
        ? html`<${ExpandableOutput} text=${output} maxLines=${10} />`
        : null}
      ${result && truncationNotice && (expanded || result.isError)
        ? html`<div class="read-truncation">${truncationNotice}</div>`
        : null}`;
  } else if (name === "write") {
    const filePath = str(args.file_path ?? args.path);
    const content = str(args.content);
    const lineCount = compactLineCount(content || "");
    const output = resultText(result);
    body = html`<div class="tool-header">
        <span class="tool-name">write</span>${" "}
        <span class="tool-path">${filePath === null ? invalid : shortenPath(filePath || "")}</span>
        ${lineCount
          ? html` <span class="line-count">· ${lineCount} line${lineCount === 1 ? "" : "s"}</span>`
          : null}
      </div>
      ${content === null
        ? html`<div class="tool-error">[invalid content arg - expected string]</div>`
        : expanded && content
          ? html`<div class="tool-output"><${Lines} text=${content} /></div>`
          : null}
      ${result?.isError && output
        ? expanded
          ? html`<div class="tool-output error-output"><${Lines} text=${output} /></div>`
          : html`<div class="compact-result error">${output.split("\n")[0]}</div>`
        : null}`;
  } else if (name === "edit") {
    const filePath = str(args.file_path ?? args.path);
    const replacementCount = array(args.edits).length;
    const output = resultText(result);
    const diff = typeof result?.details?.diff === "string" ? result.details.diff : "";
    const stats = diff ? diffStats(diff) : null;
    body = html`<div class="tool-header">
        <span class="tool-name">edit</span>${" "}
        <span class="tool-path">${filePath === null ? invalid : shortenPath(filePath || "")}</span>
        ${replacementCount
          ? html` <span class="line-count"
              >· ${replacementCount} replacement${replacementCount === 1 ? "" : "s"}</span
            >`
          : null}
      </div>
      ${stats && !result?.isPartial
        ? html`<div class="compact-result diff-stats">
            <span>+${stats.additions}</span> / <b>-${stats.removals}</b>
          </div>`
        : result && !result.isPartial
          ? expanded && output
            ? html`<div class="tool-output ${result.isError ? "error-output" : "success-output"}">
                <${Lines} text=${output} />
              </div>`
            : html`<div class="compact-result ${result.isError ? "error" : "success"}">
                ${output.split("\n")[0] || "applied"}
              </div>`
          : null}
      ${diff && expanded
        ? html`<${Diff} diff=${diff} maxLines=${Number.MAX_SAFE_INTEGER} />`
        : null}`;
  } else if (name === "ffgrep" || name === "fffind") {
    const pattern = str(args.pattern);
    const searchPath = str(args.path);
    const label = name === "ffgrep" ? "grep" : "find";
    body = html`<div class="tool-header">
        <span class="tool-name">${label}</span>${" "}
        <span class="tool-path">${pattern === null ? invalid : pattern || "…"}</span>
        ${searchPath === null
          ? invalid
          : searchPath
            ? html` <span class="line-count">in ${shortenPath(searchPath)}</span>`
            : null}
      </div>
      ${result && resultText(result).trim()
        ? html`<${ExpandableOutput} text=${resultText(result).trim()} maxLines=${10} />`
        : null}`;
  } else if (Object.hasOwn(AGENTFLOW_LABELS, name)) {
    const [label, argKey] = AGENTFLOW_LABELS[name];
    const arg = Array.isArray(args[argKey]) ? args[argKey].join(", ") : str(args[argKey]);
    body = html`<div class="tool-header custom-tool-header">
        <span class="tool-name">${label}</span>
        ${arg ? html`<span class="line-count"> · ${truncate(arg, 120)}</span>` : null}
      </div>
      ${result ? html`<${AgentflowResult} name=${name} result=${result} />` : null}`;
  } else if (name.startsWith("background_")) {
    const command = str(args.command);
    const description = str(args.description);
    body = html`<div class="tool-header custom-tool-header">
        <span class="tool-name">${name.replaceAll("_", " ")}</span>
        ${command
          ? html`<span class="tool-command-inline"> · ${compactCommand(command)}</span>`
          : null}
        ${description ? html`<span class="line-count"> · ${description}</span>` : null}
      </div>
      ${result ? html`<${BackgroundResult} result=${result} />` : null}`;
  } else if (name === "ls") {
    const dirPath = str(args.path);
    body = html`<div class="tool-header">
        <span class="tool-name">ls</span>${" "}
        <span class="tool-path">${dirPath === null ? invalid : shortenPath(dirPath || ".")}</span>
        ${args.limit !== undefined
          ? html` <span class="line-count">(limit ${args.limit})</span>`
          : null}
      </div>
      ${result && resultText(result).trim()
        ? html`<${ExpandableOutput} text=${resultText(result).trim()} maxLines=${20} />`
        : null}`;
  } else {
    // Generic fallback: tool name, JSON arguments, and any textual output.
    body = html`<div class="tool-header"><span class="tool-name">${name}</span></div>
      <div class="tool-output"><div>${JSON.stringify(args, null, 2)}</div></div>
      ${result && resultText(result)
        ? html`<${ExpandableOutput} text=${resultText(result)} maxLines=${10} />`
        : null}
      <${ImageBlock} list=${resultImages} cls="tool-image" />`;
  }

  return html`<div class="tool-execution ${status}">${body}</div>`;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

function Timestamp({ ts }) {
  const { prefs } = useContext(PrefsContext);
  if (!prefs.timestamps) return null;
  const value = formatTimestamp(ts);
  return value ? html`<div class="message-timestamp">${value}</div>` : null;
}

function Expandable({ className, label, collapsed, children }) {
  const [open, setOpen] = useState(false);
  return html`<div
    class=${className}
    onClick=${() => {
      if (window.getSelection().toString()) return;
      setOpen((v) => !v);
    }}
  >
    ${label} ${open ? children : collapsed}
  </div>`;
}

function ThinkingBlock({ text }) {
  const { prefs } = useContext(PrefsContext);
  const [open, setOpen] = useState(prefs.thinking);
  // The global "thinking" hotkey expands/collapses every block at once;
  // opening a collapsed block only changes that block.
  useEffect(() => setOpen(prefs.thinking), [prefs.thinking]);
  if (!open) {
    return html`<button
      type="button"
      class="thinking-collapsed"
      aria-expanded="false"
      onClick=${() => setOpen(true)}
    >
      thinking... (click to expand)
    </button>`;
  }
  const onKeyDown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setOpen(false);
  };
  return html`<div
    class="thinking-block"
    role="button"
    tabindex="0"
    aria-expanded="true"
    aria-label="Collapse thinking"
    onKeyDown=${onKeyDown}
    onClick=${(event) => {
      if (event.target.closest("a") || window.getSelection().toString()) return;
      setOpen(false);
    }}
  >
    <div class="thinking-text"><${Markdown} text=${text} /></div>
  </div>`;
}

function AssistantMessage({ entry, results }) {
  const msg = entry.message;
  const content = Array.isArray(msg.content) ? msg.content : [];
  return html`<div class="assistant-message">
    <${Timestamp} ts=${entry.timestamp} />
    ${content.map((block, i) => {
      if (block.type === "text" && block.text && block.text.trim()) {
        return html`<div key=${i} class="assistant-text"><${Markdown} text=${block.text} /></div>`;
      }
      if (block.type === "thinking" && block.thinking && block.thinking.trim()) {
        return html`<${ThinkingBlock} key=${i} text=${block.thinking} />`;
      }
      return null;
    })}
    ${content
      .filter((block) => block.type === "toolCall")
      .map(
        (block) =>
          html`<${ToolCall} key=${block.id} call=${block} result=${results.get(block.id)} />`,
      )}
    ${msg.stopReason === "aborted" ? html`<div class="error-text">Aborted</div>` : null}
    ${msg.stopReason === "error"
      ? html`<div class="error-text">Error: ${msg.errorMessage || "Unknown error"}</div>`
      : null}
  </div>`;
}

function UserMessage({ entry }) {
  const content = entry.message.content;
  const text = textContent(content);
  const attachedImages = images(content);
  const skill = parseSkillBlock(text);

  if (skill) {
    return html`<div class="skill-user-entry">
      <${Timestamp} ts=${entry.timestamp} />
      <${Expandable}
        className="skill-invocation"
        label=${html`<div class="skill-invocation-label">[skill] ${skill.name}</div>`}
        collapsed=${html`<div class="skill-invocation-collapsed">
          ${skill.name} (click to expand)
        </div>`}
      >
        <div class="skill-invocation-content"><${Markdown} text=${skill.content} /></div>
      <//>
      ${skill.userMessage || attachedImages.length
        ? html`<div class="user-message">
            <${ImageBlock} list=${attachedImages} cls="message-image" />
            ${skill.userMessage ? html`<${Markdown} text=${skill.userMessage} />` : null}
          </div>`
        : null}
    </div>`;
  }

  return html`<div class="user-message">
    <${Timestamp} ts=${entry.timestamp} />
    <${ImageBlock} list=${attachedImages} cls="message-image" />
    ${text.trim() ? html`<${Markdown} text=${text} />` : null}
  </div>`;
}

function BashExecution({ entry }) {
  const msg = entry.message;
  const isError =
    msg.cancelled || (msg.exitCode !== 0 && msg.exitCode !== null && msg.exitCode !== undefined);
  return html`<div class="tool-execution ${isError ? "error" : "success"}">
    <${Timestamp} ts=${entry.timestamp} />
    <div class="tool-command">$ ${msg.command}</div>
    ${msg.output ? html`<${ExpandableOutput} text=${msg.output} maxLines=${10} />` : null}
    ${msg.cancelled
      ? html`<div class="tool-error">(cancelled)</div>`
      : isError
        ? html`<div class="tool-error">(exit ${msg.exitCode})</div>`
        : null}
  </div>`;
}

function Entry({ entry, results }) {
  const { prefs } = useContext(PrefsContext);

  if (entry.type === "message") {
    const role = entry.message?.role;
    if (role === "user") return html`<${UserMessage} entry=${entry} />`;
    if (role === "assistant")
      return html`<${AssistantMessage} entry=${entry} results=${results} />`;
    if (role === "bashExecution") return html`<${BashExecution} entry=${entry} />`;
    return null; // toolResult rendered inside its tool call
  }

  if (entry.type === "model_change") {
    if (!prefs.switches) return null;
    return html`<div class="model-change">
      <${Timestamp} ts=${entry.timestamp} />
      Switched to model:${" "}
      <span class="model-name">${entry.provider}/${entry.modelId}</span>
    </div>`;
  }

  if (entry.type === "thinking_level_change") {
    if (!prefs.switches) return null;
    return html`<div class="model-change">
      <${Timestamp} ts=${entry.timestamp} />
      Thinking level: <span class="model-name">${entry.thinkingLevel}</span>
    </div>`;
  }

  if (entry.type === "compaction") {
    const tokens = Number(entry.tokensBefore || 0).toLocaleString();
    return html`<${Expandable}
      className="compaction"
      label=${html`<div class="compaction-label">[compaction]</div>`}
      collapsed=${html`<div class="compaction-collapsed">Compacted from ${tokens} tokens</div>`}
    >
      <div class="compaction-content">${entry.summary || ""}</div>
    <//>`;
  }

  if (entry.type === "branch_summary") {
    return html`<div class="branch-summary">
      <${Timestamp} ts=${entry.timestamp} />
      <div class="branch-summary-header">Branch Summary</div>
      <${Markdown} text=${entry.summary || ""} />
    </div>`;
  }

  if (entry.type === "custom_message" && entry.display) {
    return html`<div class="hook-message">
      <${Timestamp} ts=${entry.timestamp} />
      <div class="hook-type">[${entry.customType}]</div>
      <${Markdown}
        text=${typeof entry.content === "string" ? entry.content : textContent(entry.content)}
      />
    </div>`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// App shell + transport
// ---------------------------------------------------------------------------

function Transcript({ snapshot }) {
  const { prefs } = useContext(PrefsContext);
  const results = useMemo(() => {
    const map = new Map();
    for (const entry of snapshot.entries) {
      if (
        entry.type === "message" &&
        entry.message?.role === "toolResult" &&
        entry.message.toolCallId
      ) {
        map.set(entry.message.toolCallId, entry.message);
      }
    }
    return map;
  }, [snapshot]);

  const visibleEntries = prefs.switches
    ? snapshot.entries
    : snapshot.entries.filter(
        (entry) => entry.type !== "model_change" && entry.type !== "thinking_level_change",
      );
  const rendered = visibleEntries.map(
    (entry) => html`<${Entry} key=${entry.id} entry=${entry} results=${results} />`,
  );

  if (visibleEntries.length === 0) {
    return html`<div class="notice">Waiting for the first message in this session…</div>`;
  }
  return html`<div id="messages">${rendered}</div>`;
}

function SystemPromptPanel({ snapshot }) {
  const { prefs } = useContext(PrefsContext);
  if (!prefs.systemPrompt) return null;
  const prompt = snapshot.systemPrompt || "";
  return html`<section class="system-prompt" aria-label="Effective system prompt">
    <div class="system-prompt-label">system prompt</div>
    ${prompt.trim()
      ? html`<pre class="system-prompt-text">${prompt}</pre>`
      : html`<div class="system-prompt-empty">No system prompt available yet.</div>`}
  </section>`;
}

function StatusBar({ title, snapshot, connection }) {
  const state =
    connection === "offline"
      ? html`<span class="status-state"><span class="status-dot offline"></span>disconnected</span>`
      : snapshot.isRunning
        ? html`<span class="status-state"
            ><span class="status-dot running"></span>${snapshot.workingWord || "running"}</span
          >`
        : html`<span class="status-state"><span class="status-dot"></span>idle</span>`;
  return html`<div class="status-bar">
    <span class="status-title">${title}</span>
    ${state}
  </div>`;
}

const EMPTY_SNAPSHOT = {
  header: null,
  entries: [],
  leafId: null,
  isRunning: false,
  workingWord: undefined,
  sessionName: undefined,
  systemPrompt: "",
};

function useStickToBottom(snapshot) {
  const stick = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const scrollToBottom = () => {
    stick.current = true;
    setAwayFromBottom(false);
    window.scrollTo(0, document.documentElement.scrollHeight);
  };

  useEffect(() => {
    const atBottom = () =>
      document.documentElement.scrollHeight - window.innerHeight - window.scrollY <= 2;
    const onScroll = () => {
      stick.current = atBottom();
      setAwayFromBottom(!stick.current);
    };
    const onResize = () => stick.current && scrollToBottom();
    const observer = new ResizeObserver(onResize);

    observer.observe(document.getElementById("app"));
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useLayoutEffect(() => {
    if (stick.current) scrollToBottom();
  }, [snapshot]);

  return { awayFromBottom, scrollToBottom };
}

// Command palette: a small centered dialog (Cmd/Ctrl+K) that lists every display
// preference from PREFS and flips it. It reuses PrefsContext for both the current
// state and the toggle, so no additional persistence lives here.
function CommandPalette({ onClose }) {
  const { prefs, toggle } = useContext(PrefsContext);
  const [active, setActive] = useState(0);
  const itemRefs = useRef([]);

  const focusItem = (index) => itemRefs.current[index]?.focus();

  useLayoutEffect(() => {
    focusItem(0);
  }, []);

  const move = (delta) => {
    const next = (active + delta + PREFS.length) % PREFS.length;
    setActive(next);
    focusItem(next);
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Tab") {
      event.preventDefault();
      move(event.shiftKey ? -1 : 1);
    }
  };

  return html`<div
    class="palette-backdrop"
    onMouseDown=${(event) => {
      if (event.target === event.currentTarget) onClose();
    }}
  >
    <div
      class="palette"
      role="dialog"
      aria-modal="true"
      aria-labelledby="palette-title"
      onKeyDown=${onKeyDown}
    >
      <div class="palette-title" id="palette-title">Display settings</div>
      <ul class="palette-list">
        ${PREFS.map(
          (pref, index) => html`<li key=${pref.key}>
            <button
              ref=${(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              tabindex=${index === active ? "0" : "-1"}
              aria-pressed=${prefs[pref.key] ? "true" : "false"}
              class="palette-item ${prefs[pref.key] ? "on" : "off"}"
              onFocus=${() => setActive(index)}
              onClick=${() => toggle(pref.key)}
            >
              <span class="palette-item-label">${pref.label}</span>
              <span class="palette-item-key"><kbd>${pref.hotkey}</kbd></span>
              <span class="palette-item-state">${prefs[pref.key] ? "shown" : "hidden"}</span>
            </button>
          </li>`,
        )}
      </ul>
      <div class="palette-hint">↑↓ move · enter toggle · esc close</div>
    </div>
  </div>`;
}

function App() {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [connection, setConnection] = useState("connecting");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteOpenRef = useRef(false);
  const preferences = usePreferences(paletteOpenRef);
  const { awayFromBottom, scrollToBottom } = useStickToBottom(snapshot);
  const sessionTitle = resolveSessionTitle(snapshot);

  useEffect(() => {
    document.title = `π – ${sessionTitle}`;
  }, [sessionTitle]);

  useLayoutEffect(() => {
    paletteOpenRef.current = paletteOpen;
  }, [paletteOpen]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.repeat || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey))
        return;
      if (event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!snapshot.theme) return;
    const variables = (palette) =>
      Object.entries(palette)
        .filter(([name]) => name !== "colorScheme")
        .map(([name, value]) => `--${name}:${value};`)
        .join("");
    const { auto, light, dark } = snapshot.theme;
    let style = document.getElementById("pi-theme");
    if (!style) {
      style = document.createElement("style");
      style.id = "pi-theme";
      document.head.append(style);
    }
    const css = auto
      ? `:root{color-scheme:${dark.colorScheme};${variables(dark)}}` +
        `@media(prefers-color-scheme:light){:root{color-scheme:${light.colorScheme};${variables(light)}}}`
      : `:root{color-scheme:${dark.colorScheme};${variables(dark)}}`;
    if (style.textContent !== css) style.textContent = css;
  }, [snapshot.theme]);

  useEffect(() => {
    let source;
    let cancelled = false;

    async function connect() {
      const match = location.hash.match(/(?:^#|&)code=([^&]+)/);
      if (match) {
        try {
          await fetch("auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: decodeURIComponent(match[1]) }),
          });
        } catch {
          // Cookie may already be set from a previous exchange; try the stream anyway.
        }
        history.replaceState(null, "", location.pathname);
      }

      if (cancelled) return;
      source = new EventSource("events");
      source.onopen = () => setConnection("online");
      source.onmessage = (event) => {
        try {
          setSnapshot(JSON.parse(event.data));
          setConnection("online");
        } catch {
          // Ignore malformed frames.
        }
      };
      source.onerror = () => setConnection("offline");
    }

    connect();
    return () => {
      cancelled = true;
      source?.close();
    };
  }, []);

  return html`<${PrefsContext.Provider} value=${preferences}>
    <${StatusBar} title=${sessionTitle} snapshot=${snapshot} connection=${connection} />
    <${SystemPromptPanel} snapshot=${snapshot} />
    ${awayFromBottom
      ? html`<button
          type="button"
          class="scroll-to-bottom"
          onClick=${scrollToBottom}
          aria-label="Scroll to bottom"
        >
          ↓ bottom
        </button>`
      : null}
    <${Transcript} snapshot=${snapshot} />
    ${paletteOpen ? html`<${CommandPalette} onClose=${() => setPaletteOpen(false)} />` : null}
  <//>`;
}

render(html`<${App} />`, document.getElementById("app"));
