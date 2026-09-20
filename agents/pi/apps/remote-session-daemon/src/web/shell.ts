// Machine/session shell for the daemon-served SPA.
//
// This is a minimal, dependency-free vanilla-DOM shell that wraps the shared
// session view. It owns the two canonical routes — the local dashboard at
// `/_pi/` and one session at `/_pi/sessions/:launchId` — plus deep links,
// open-in-new-tab, launch creation, stop, and the reconnect/preflight
// states. It mounts the shared session view (into a shared-styled `#app`
// element) only when a launch is attachable, and otherwise reports the honest
// current state without pretending to stream.

import { mount } from "@dotfiles/pi-web-ui-client/client";
import { createManagedSessionTransport } from "./managed-transport.ts";

const API = "/_pi/api/v1";
const DASHBOARD_PATH = "/_pi/";
const SESSION_PREFIX = "/_pi/sessions/";

// Honest, compact scope of this first managed slice. Kept short so it reads as a
// notice, not a wall of caveats.
const SLICE_NOTICE =
  "Early managed view: streams the recent and live transcript and accepts prompts. " +
  "Older history, command completions, and images aren't available yet.";

interface HostInfo {
  readonly kind: string;
  readonly apiVersion: number;
  readonly daemonId: string;
}
interface RootSummary {
  readonly alias: string;
}
interface LaunchSummary {
  readonly launchId: string;
  readonly lifecycle: string;
  readonly ready: boolean;
  readonly updatedAt: number;
  readonly failureCode?: string;
}
interface LaunchDetail extends LaunchSummary {
  readonly running: boolean;
  readonly settled: boolean;
}

type Child = Node | string;
type AttrValue = string | boolean | ((event: Event) => void);

class HttpStatusError extends Error {}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "function") node.addEventListener(key, value as EventListener);
    else if (typeof value === "boolean") {
      if (value) node.setAttribute(key, "");
    } else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new HttpStatusError(`Request failed (${response.status})`);
  return (await response.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new HttpStatusError(`Request failed (${response.status})`);
  return (await response.json()) as T;
}

function shortId(launchId: string): string {
  return launchId.length > 8 ? `${launchId.slice(0, 8)}…` : launchId;
}

function attachable(launch: LaunchDetail): boolean {
  return launch.ready && (launch.lifecycle === "ready" || launch.lifecycle === "running");
}

/** Start the managed shell inside `root`, taking over navigation for `/_pi/`. */
export function startManagedShell(root: HTMLElement): void {
  let renderToken = 0;

  function navigate(path: string): void {
    location.assign(path);
  }

  function sessionPath(launchId: string): string {
    return `${SESSION_PREFIX}${encodeURIComponent(launchId)}`;
  }

  function route(): void {
    renderToken += 1;
    const token = renderToken;
    root.replaceChildren();
    const path = location.pathname;
    if (path.startsWith(SESSION_PREFIX)) {
      const launchId = decodeURIComponent(path.slice(SESSION_PREFIX.length).split("/")[0] ?? "");
      if (launchId) {
        void renderDetail(launchId, token);
        return;
      }
    }
    void renderDashboard(token);
  }

  function fresh(token: number): boolean {
    return token === renderToken;
  }

  function shellError(message: string): HTMLElement {
    return el("p", { class: "managed-error", role: "alert" }, [message]);
  }

  async function renderDashboard(token: number): Promise<void> {
    const container = el("div", { class: "managed-shell" });
    if (fresh(token)) root.append(container);

    let host: HostInfo | undefined;
    let roots: readonly RootSummary[] = [];
    let launches: readonly LaunchSummary[] = [];
    try {
      [host, roots, launches] = await Promise.all([
        getJson<HostInfo>(`${API}/host`).catch(() => undefined),
        getJson<{ roots: RootSummary[] }>(`${API}/roots`).then((value) => value.roots),
        getJson<{ launches: LaunchSummary[] }>(`${API}/sessions`).then((value) => value.launches),
      ]);
    } catch {
      if (fresh(token))
        container.append(shellError("Couldn't reach the daemon. Refresh to try again."));
      return;
    }
    if (!fresh(token)) return;

    const machine = host?.daemonId ?? "local";
    container.append(
      el("header", { class: "managed-header" }, [
        el("h1", {}, [el("span", { class: "managed-prompt" }, ["π"]), " managed sessions"]),
        el("p", { class: "managed-muted" }, [`Machine ${machine}`]),
      ]),
      renderLaunchForm(roots),
      renderSessionList(launches),
    );
  }

  function renderLaunchForm(roots: readonly RootSummary[]): HTMLElement {
    const section = el("section", { class: "managed-section" }, [
      el("h2", {}, ["Start a session"]),
    ]);

    if (roots.length === 0) {
      section.append(
        el("p", { class: "managed-muted" }, ["No approved roots are configured for this daemon."]),
      );
      return section;
    }

    const select = el(
      "select",
      { class: "managed-input", name: "rootAlias", "aria-label": "Approved root" },
      roots.map((entry) => el("option", { value: entry.alias }, [entry.alias])),
    );
    const pathInput = el("input", {
      class: "managed-input",
      name: "relativePath",
      type: "text",
      value: ".",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "Relative path within the root",
    });
    const status = el("p", { class: "managed-muted", role: "status", "aria-live": "polite" });
    const submit = el("button", { class: "managed-button", type: "submit" }, ["Launch"]);

    const form = el(
      "form",
      {
        class: "managed-form",
        submit: (event) => {
          event.preventDefault();
          submit.setAttribute("disabled", "");
          status.textContent = "Launching…";
          void postJson<{ launch: LaunchSummary }>(`${API}/sessions`, {
            rootAlias: select.value,
            relativePath: pathInput.value,
          })
            .then((created) => navigate(sessionPath(created.launch.launchId)))
            .catch((error: unknown) => {
              if (error instanceof HttpStatusError) {
                submit.removeAttribute("disabled");
                status.textContent = "Launch was rejected. Check the root and path.";
                return;
              }
              status.textContent = "Launch delivery is unconfirmed. Refreshing sessions…";
              setTimeout(() => location.reload(), 750);
            });
        },
      },
      [
        el("label", {}, ["Root", select]),
        el("label", {}, ["Path", pathInput]),
        el("div", { class: "managed-form-actions" }, [submit, status]),
      ],
    );
    section.append(form);
    return section;
  }

  function renderSessionList(launches: readonly LaunchSummary[]): HTMLElement {
    const section = el("section", { class: "managed-section" }, [el("h2", {}, ["Local sessions"])]);
    if (launches.length === 0) {
      section.append(el("p", { class: "managed-muted" }, ["No sessions yet. Launch one above."]));
      return section;
    }
    const ordered = [...launches].sort((a, b) => b.updatedAt - a.updatedAt);
    section.append(
      el(
        "ul",
        { class: "managed-list" },
        ordered.map((launch) => {
          const href = sessionPath(launch.launchId);
          return el("li", { class: launch.ready ? "managed-live" : "" }, [
            el("a", { class: "managed-launch-link", href, "data-nav": true }, [
              shortId(launch.launchId),
            ]),
            el("span", { class: `managed-badge ${launch.ready ? "ready" : ""}` }, [
              launch.failureCode ?? launch.lifecycle,
            ]),
            el(
              "a",
              {
                class: "managed-newtab",
                href,
                target: "_blank",
                rel: "noopener",
                title: "Open in a new tab",
              },
              ["↗"],
            ),
          ]);
        }),
      ),
    );
    return section;
  }

  async function renderDetail(launchId: string, token: number): Promise<void> {
    let launch: LaunchDetail;
    try {
      launch = (
        await getJson<{ launch: LaunchDetail }>(`${API}/sessions/${encodeURIComponent(launchId)}`)
      ).launch;
    } catch {
      if (fresh(token)) {
        root.append(renderDetailBar(shortId(launchId), "not found", launchId));
        root.append(
          el("section", { class: "managed-shell" }, [
            shellError("This session isn't available. It may have been stopped or never existed."),
          ]),
        );
      }
      return;
    }
    if (!fresh(token)) return;

    root.append(renderDetailBar(shortId(launch.launchId), launch.lifecycle, launch.launchId));

    if (attachable(launch)) {
      root.append(el("p", { class: "managed-notice", role: "note" }, [SLICE_NOTICE]));
      const app = el("main", { id: "app" });
      root.append(app);
      mount(app, createManagedSessionTransport(launch.launchId));
      return;
    }

    root.append(renderPreflight(launch));
  }

  function renderDetailBar(title: string, state: string, launchId: string): HTMLElement {
    return el("nav", { class: "managed-bar", "aria-label": "Session" }, [
      el("a", { class: "managed-back", href: DASHBOARD_PATH, "data-nav": true }, ["← Sessions"]),
      el("span", { class: "managed-title" }, [`${title} · ${state}`]),
      el(
        "button",
        {
          class: "managed-button",
          type: "button",
          click: (event) => {
            const button = event.currentTarget as HTMLButtonElement;
            button.setAttribute("disabled", "");
            void postJson(`${API}/sessions/${encodeURIComponent(launchId)}/stop`, {})
              .catch(() => undefined)
              .finally(() => navigate(DASHBOARD_PATH));
          },
        },
        ["Stop"],
      ),
    ]);
  }

  function renderPreflight(launch: LaunchDetail): HTMLElement {
    const messages: Record<string, string> = {
      unloaded: "This session is idle and not loaded. Reopen it to attach.",
      loading: "This session is starting up.",
      restarting: "This session is restarting.",
      transitioning: "This session is switching state.",
      unloading: "This session is unloading.",
      stopping: "This session is stopping.",
      stopped: "This session has stopped.",
      failed: "This session failed to stay ready.",
    };
    const message = messages[launch.lifecycle] ?? "This session isn't attachable right now.";
    const reconnect =
      launch.lifecycle === "unloaded"
        ? () =>
            void postJson(`${API}/sessions/${encodeURIComponent(launch.launchId)}/reopen`, {})
              .then(() => location.reload())
              .catch(() => location.reload())
        : () => location.reload();
    const section = el("section", { class: "managed-shell" }, [
      el("div", { class: "managed-section" }, [
        el("p", {}, [message]),
        ...(launch.failureCode
          ? [el("p", { class: "managed-muted" }, [`Reason: ${launch.failureCode}`])]
          : []),
        el("button", { class: "managed-button", type: "button", click: reconnect }, [
          launch.lifecycle === "unloaded" ? "Reopen" : "Reconnect",
        ]),
      ]),
    ]);
    return section;
  }

  route();
}
