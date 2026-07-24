import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ServerMessage } from "../shared/wire.js";
import { Composer, type ComposerMode } from "./components/Composer.js";
import { Timeline } from "./components/Timeline.js";
import { BrowserSessionStore, useBrowserSession } from "./session-store.js";
import {
  connectWebSocket,
  exchangeBootstrapCredential,
  type ConnectionState,
  type WebTransport,
} from "./transport.js";
import "./styles.css";

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
  const [mode, setMode] = useState<ComposerMode>("prompt");

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

  const submit = () => {
    const value = content.trim();
    if (!value || !session.generation || transport.current?.socket.readyState !== WebSocket.OPEN)
      return;
    const delivery = isRunning ? (mode === "follow_up" ? "follow_up" : "steer") : "prompt";
    transport.current.send(delivery, { content: value, generation: session.generation });
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

      <Composer
        {...(metadata ? { metadata } : {})}
        {...(session.state?.persisted.sessionId
          ? { sessionId: session.state.persisted.sessionId }
          : {})}
        running={Boolean(isRunning)}
        connected={ready}
        content={content}
        mode={mode}
        notice={message}
        onContent={setContent}
        onMode={setMode}
        onSend={submit}
        onAbort={() => {
          if (session.generation) {
            transport.current?.send("abort", { generation: session.generation });
          }
        }}
      />
    </div>
  );
}
