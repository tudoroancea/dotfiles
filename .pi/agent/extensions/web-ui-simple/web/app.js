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
// single-key hotkey that flips it, a short status-bar label, and the default
// applied on first visit. All default to hidden/collapsed per the roadmap.
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

function usePreferences() {
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
function ExpandableOutput({ text, maxLines }) {
  const { prefs } = useContext(PrefsContext);
  const [expanded, setExpanded] = useState(prefs.tools);
  // The global "tool output" hotkey expands/collapses every block at once;
  // per-block clicks still override until the next global toggle.
  useEffect(() => setExpanded(prefs.tools), [prefs.tools]);
  const clean = replaceTabs(text);
  const lines = clean.split("\n");
  const remaining = lines.length - maxLines;

  if (remaining <= 0) {
    return html`<div class="tool-output"><${Lines} text=${clean} /></div>`;
  }
  const onKeyDown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setExpanded((value) => !value);
  };
  if (expanded) {
    return html`<div
      class="tool-output expandable"
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
    class="tool-output expandable"
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
// Tool calls (exporter built-in renderers + generic fallback)
// ---------------------------------------------------------------------------

function ToolCall({ call, result }) {
  const status = result ? (result.isError ? "error" : "success") : "pending";
  const args = call.arguments || {};
  const name = call.name;
  const invalid = html`<span class="tool-error">[invalid arg]</span>`;
  const resultImages = result ? images(result.content) : [];

  let body;

  if (name === "bash") {
    const command = str(args.command);
    body = html`<div class="tool-command">$ ${command === null ? invalid : command || "..."}</div>
      ${result && resultText(result).trim()
        ? html`<${ExpandableOutput} text=${resultText(result).trim()} maxLines=${5} />`
        : null}`;
  } else if (name === "read") {
    const filePath = str(args.file_path ?? args.path);
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
      ${result && resultText(result)
        ? html`<${ExpandableOutput} text=${resultText(result)} maxLines=${10} />`
        : null}`;
  } else if (name === "write") {
    const filePath = str(args.file_path ?? args.path);
    const content = str(args.content);
    const lineCount = content ? content.split("\n").length : 0;
    body = html`<div class="tool-header">
        <span class="tool-name">write</span>${" "}
        <span class="tool-path">${filePath === null ? invalid : shortenPath(filePath || "")}</span>
        ${lineCount > 10 ? html` <span class="line-count">(${lineCount} lines)</span>` : null}
      </div>
      ${content === null
        ? html`<div class="tool-error">[invalid content arg - expected string]</div>`
        : content
          ? html`<${ExpandableOutput} text=${content} maxLines=${10} />`
          : null}
      ${result && resultText(result).trim()
        ? html`<${ExpandableOutput} text=${resultText(result).trim()} maxLines=${10} />`
        : null}`;
  } else if (name === "edit") {
    const filePath = str(args.file_path ?? args.path);
    body = html`<div class="tool-header">
        <span class="tool-name">edit</span>${" "}
        <span class="tool-path">${filePath === null ? invalid : shortenPath(filePath || "")}</span>
      </div>
      ${result && result.details && result.details.diff
        ? html`<${Diff} diff=${result.details.diff} />`
        : result && resultText(result).trim()
          ? html`<${ExpandableOutput} text=${resultText(result).trim()} maxLines=${10} />`
          : null}`;
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
  const { prefs, toggle } = useContext(PrefsContext);
  if (!prefs.thinking) {
    return html`<button
      type="button"
      class="thinking-collapsed"
      aria-expanded="false"
      onClick=${() => toggle("thinking")}
    >
      thinking · <kbd>t</kbd> to expand
    </button>`;
  }
  return html`<div class="thinking-block">
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

function PrefsLegend() {
  const { prefs, toggle } = useContext(PrefsContext);
  return html`<span class="status-prefs">
    ${PREFS.map(
      (pref) => html`<button
        key=${pref.key}
        type="button"
        class="pref-toggle ${prefs[pref.key] ? "on" : "off"}"
        title=${`Toggle ${pref.label} (press ${pref.hotkey})`}
        aria-pressed=${prefs[pref.key] ? "true" : "false"}
        onClick=${() => toggle(pref.key)}
      >
        <kbd>${pref.hotkey}</kbd>${" "}${pref.label}
      </button>`,
    )}
  </span>`;
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
        ? html`<span class="status-state"><span class="status-dot running"></span>running</span>`
        : html`<span class="status-state"><span class="status-dot"></span>idle</span>`;
  return html`<div class="status-bar">
    <span class="status-title">${title}</span>
    <${PrefsLegend} />
    ${state}
  </div>`;
}

const EMPTY_SNAPSHOT = {
  header: null,
  entries: [],
  leafId: null,
  isRunning: false,
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

function App() {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [connection, setConnection] = useState("connecting");
  const preferences = usePreferences();
  const { awayFromBottom, scrollToBottom } = useStickToBottom(snapshot);
  const sessionTitle = resolveSessionTitle(snapshot);

  useEffect(() => {
    document.title = `π – ${sessionTitle}`;
  }, [sessionTitle]);

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
  <//>`;
}

render(html`<${App} />`, document.getElementById("app"));
