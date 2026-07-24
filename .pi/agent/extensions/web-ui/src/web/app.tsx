import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ServerMessage } from "../shared/wire.js";
import { Timeline } from "./components/Timeline.js";
import { BrowserSessionStore, useBrowserSession } from "./session-store.js";
import {
  connectWebSocket,
  exchangeBootstrapCredential,
  type ConnectionState,
  type WebTransport,
} from "./transport.js";
import "./styles.css";

type SendMode = "prompt" | "steer" | "follow_up";

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting",
  open: "Live",
  closed: "Reconnecting",
  unauthorized: "Not authorized",
};

export function App() {
  const transport = useRef<WebTransport>();
  const timeline = useRef<HTMLElement | null>(null);
  const stickToBottom = useRef(true);
  const sessionStore = useRef(new BrowserSessionStore()).current;
  const session = useBrowserSession(sessionStore);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [message, setMessage] = useState("Authenticate with /copy-remote-url in Pi.");
  const [content, setContent] = useState("");
  const [mode, setMode] = useState<SendMode>("prompt");

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
  useEffect(() => {
    if (isRunning !== undefined) setMode(isRunning ? "steer" : "prompt");
  }, [isRunning]);

  useLayoutEffect(() => {
    const element = timeline.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [session.revision, session.state]);

  const submit = (event: Event) => {
    event.preventDefault();
    const value = content.trim();
    if (!value || !session.generation || transport.current?.socket.readyState !== WebSocket.OPEN)
      return;
    transport.current.send(mode, { content: value, generation: session.generation });
    setContent("");
    setMessage("Sending…");
  };

  const metadata = session.state?.metadata;
  const ready = connection === "open" && Boolean(session.generation);

  return (
    <div class="shell">
      <header class="topbar">
        <div class="topbar__brand">
          <span class="topbar__mark" aria-hidden="true">
            pi
          </span>
          <h1 class="topbar__title">Session timeline</h1>
        </div>
        <span
          class={`conn conn--${connection}`}
          role="status"
          aria-live="polite"
          data-running={connection === "open" && isRunning ? "true" : "false"}
        >
          <span class="conn__dot" aria-hidden="true" />
          {connection === "open" && isRunning ? "Working" : CONNECTION_LABEL[connection]}
        </span>
      </header>

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
        {session.state ? (
          <Timeline state={session.state} />
        ) : (
          <p class="timeline__empty">Waiting for the session snapshot…</p>
        )}
      </main>

      <footer class="composer">
        <p class="composer__notice" aria-live="polite">
          {message}
        </p>
        <form class="composer__form" onSubmit={submit}>
          <div class="composer__meta">
            {metadata?.model ? <span class="composer__model">{metadata.model.name}</span> : null}
            {metadata?.cwd ? <span class="composer__cwd">{metadata.cwd}</span> : null}
          </div>
          <textarea
            class="composer__input"
            aria-label="Message"
            rows={3}
            value={content}
            placeholder={isRunning ? "Steer the running turn…" : "Send a prompt…"}
            onInput={(event) => setContent(event.currentTarget.value)}
          />
          <div class="composer__controls">
            <label class="composer__mode" for="mode">
              <span class="composer__mode-label">Deliver as</span>
              <select
                id="mode"
                value={mode}
                onChange={(event) => setMode(event.currentTarget.value as SendMode)}
              >
                <option value="prompt">Prompt</option>
                <option value="steer">Steer</option>
                <option value="follow_up">Follow-up</option>
              </select>
            </label>
            <div class="composer__actions">
              <button
                type="button"
                class="btn btn--ghost"
                disabled={!ready}
                onClick={() =>
                  session.generation &&
                  transport.current?.send("abort", { generation: session.generation })
                }
              >
                Abort
              </button>
              <button type="submit" class="btn btn--send" disabled={!ready || !content.trim()}>
                Send
              </button>
            </div>
          </div>
        </form>
      </footer>
    </div>
  );
}
