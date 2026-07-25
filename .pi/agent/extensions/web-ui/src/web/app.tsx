import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { CompletionItem, ProviderMessage, ServerMessage } from "../shared/wire.js";
import { AgentflowDashboard } from "./components/AgentflowDashboard.js";
import { BackgroundDashboard } from "./components/BackgroundDashboard.js";
import { Composer } from "./components/Composer.js";
import { DashboardNav, type ViewName } from "./components/DashboardNav.js";
import { Timeline } from "./components/Timeline.js";
import { BrowserProviderStore, useProviders } from "./provider-store.js";
import { BrowserSessionStore, useBrowserSession } from "./session-store.js";
import {
  connectWebSocket,
  exchangeBootstrapCredential,
  type ConnectionState,
  type WebTransport,
} from "./transport.js";
import "./styles.css";

export function App() {
  const transport = useRef<WebTransport>();
  const timeline = useRef<HTMLElement | null>(null);
  const stickToBottom = useRef(true);
  const sessionStore = useRef(new BrowserSessionStore()).current;
  const providerStore = useRef(new BrowserProviderStore()).current;
  const session = useBrowserSession(sessionStore);
  const providers = useProviders(providerStore);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [message, setMessage] = useState("");
  const [content, setContent] = useState("");
  const [view, setView] = useState<ViewName>("timeline");
  const completionRequests = useRef(new Map<string, (items: CompletionItem[]) => void>());

  useEffect(() => {
    let active = true;
    let current: WebTransport | undefined;
    void exchangeBootstrapCredential()
      .then(() => {
        if (!active) return;
        current = connectWebSocket(
          (event) => {
            if (!active || typeof event !== "object" || event === null) return;
            const record = event as Record<string, unknown>;
            if (
              (record.type === "provider_snapshot" ||
                record.type === "provider_update" ||
                record.type === "provider_action_result") &&
              (record.provider === "agentflow" || record.provider === "background")
            ) {
              providerStore.apply(event as ProviderMessage);
              return;
            }
            if (record.type === "completion_result" && typeof record.commandId === "string") {
              const resolve = completionRequests.current.get(record.commandId);
              completionRequests.current.delete(record.commandId);
              resolve?.(Array.isArray(record.items) ? (record.items as CompletionItem[]) : []);
              return;
            }
            if (record.type === "command_response") {
              setMessage(record.accepted ? "Command accepted" : String(record.error));
              return;
            }
            const result = sessionStore.apply(event as ServerMessage);
            if (result === "resync" && record.type !== "ready") {
              const cursor = sessionStore.getSnapshot();
              transport.current?.send("snapshot", {
                ...(cursor.generation ? { generation: cursor.generation } : {}),
                revision: cursor.revision,
              });
            }
          },
          (state) => active && setConnection(state),
        );
        transport.current = current;
      })
      .catch((error: unknown) => {
        if (!active) return;
        setConnection("unauthorized");
        setMessage(error instanceof Error ? error.message : "Authentication failed");
      });
    return () => {
      active = false;
      current?.close();
      transport.current = undefined;
    };
  }, [sessionStore]);

  const isRunning = session.state?.live.isRunning;

  useLayoutEffect(() => {
    const element = timeline.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [session.revision, session.state]);

  const submit = (delivery?: "steer" | "follow_up") => {
    const value = content.trim();
    if (!value || !session.generation || transport.current?.socket.readyState !== WebSocket.OPEN)
      return;
    const kind = isRunning ? (delivery ?? "steer") : "prompt";
    transport.current.send(kind, { content: value, generation: session.generation });
    setContent("");
    setMessage("Sending…");
  };

  const requestCompletion = useCallback(
    (completionKind: "slash" | "mention", query: string) => {
      if (!session.generation || transport.current?.socket.readyState !== WebSocket.OPEN) {
        return Promise.resolve([]);
      }
      return new Promise<CompletionItem[]>((resolve) => {
        const id = transport.current!.send("complete", {
          generation: session.generation,
          completionKind,
          query,
        });
        completionRequests.current.set(id, resolve);
        window.setTimeout(() => {
          if (completionRequests.current.delete(id)) resolve([]);
        }, 5_000);
      });
    },
    [session.generation, session.state?.metadata.cwd],
  );

  const metadata = session.state?.metadata;
  const ready = connection === "open" && Boolean(session.generation);
  const connectionStatus =
    connection === "open"
      ? isRunning
        ? "Agent working"
        : "Connected"
      : connection === "connecting"
        ? "Connecting…"
        : connection === "closed"
          ? "Reconnecting…"
          : "Not authorized";

  return (
    <div class="shell">
      <DashboardNav value={view} onChange={setView} />
      <p
        class={connection === "open" ? "connection-status sr-only" : "connection-status"}
        role="status"
        aria-live="polite"
      >
        {connectionStatus}
      </p>

      <main
        ref={timeline}
        class="timeline-scroll"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        {view === "timeline" ? (
          session.state ? (
            <Timeline state={session.state} />
          ) : (
            <p class="timeline__empty">Waiting for the session snapshot…</p>
          )
        ) : view === "agentflow" ? (
          <AgentflowDashboard
            data={providers.agentflow?.data}
            connected={ready}
            onAction={(action, payload) => {
              if (!session.generation || !ready) return;
              try {
                transport.current?.send("provider_action", {
                  generation: session.generation,
                  provider: "agentflow",
                  action,
                  payload,
                });
              } catch {
                setMessage("Agentflow action could not be sent while reconnecting.");
              }
            }}
          />
        ) : (
          <BackgroundDashboard
            data={providers.background?.data}
            connected={ready}
            onAction={(action, payload) => {
              if (!session.generation || !ready) return;
              try {
                transport.current?.send("provider_action", {
                  generation: session.generation,
                  provider: "background",
                  action,
                  payload,
                });
              } catch {
                setMessage("Background action could not be sent while reconnecting.");
              }
            }}
          />
        )}
      </main>

      <Composer
        {...(metadata ? { metadata } : {})}
        {...(session.state?.persisted.sessionId
          ? { sessionId: session.state.persisted.sessionId }
          : {})}
        running={Boolean(isRunning)}
        connected={ready}
        content={content}
        notice={message}
        onContent={setContent}
        onSend={submit}
        requestCompletion={requestCompletion}
        onAbort={() => {
          if (!session.generation || !ready) return;
          try {
            transport.current?.send("abort", { generation: session.generation });
          } catch {
            setMessage("The running turn could not be stopped while reconnecting.");
          }
        }}
      />
    </div>
  );
}
