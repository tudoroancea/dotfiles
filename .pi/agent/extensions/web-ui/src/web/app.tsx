import { useEffect, useRef, useState } from "preact/hooks";
import type { ServerMessage } from "../shared/wire.js";
import { BrowserSessionStore, useBrowserSession } from "./session-store.js";
import {
  connectWebSocket,
  exchangeBootstrapCredential,
  type ConnectionState,
  type WebTransport,
} from "./transport.js";
import "./styles.css";

type SendMode = "prompt" | "steer" | "follow_up";

export function App() {
  const transport = useRef<WebTransport>();
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

  const submit = (event: Event) => {
    event.preventDefault();
    const value = content.trim();
    if (!value || !session.generation || transport.current?.socket.readyState !== WebSocket.OPEN)
      return;
    transport.current.send(mode, { content: value, generation: session.generation });
    setContent("");
    setMessage("Sending…");
  };

  return (
    <main class="shell">
      <header>
        <h1>Pi Web UI</h1>
        <span class={`status status--${connection}`}>{connection}</span>
      </header>
      <section class="notice" aria-live="polite">
        {message}
      </section>
      <form onSubmit={submit}>
        <label for="mode">Delivery</label>
        <select
          id="mode"
          value={mode}
          onChange={(event) => setMode(event.currentTarget.value as SendMode)}
        >
          <option value="prompt">Prompt</option>
          <option value="steer">Steer</option>
          <option value="follow_up">Follow-up</option>
        </select>
        <label for="prompt">Message</label>
        <textarea
          id="prompt"
          rows={6}
          value={content}
          onInput={(event) => setContent(event.currentTarget.value)}
        />
        <div class="actions">
          <button
            type="submit"
            disabled={connection !== "open" || !session.generation || !content.trim()}
          >
            Send
          </button>
          <button
            type="button"
            disabled={connection !== "open" || !session.generation}
            onClick={() =>
              session.generation &&
              transport.current?.send("abort", { generation: session.generation })
            }
          >
            Abort
          </button>
        </div>
      </form>
    </main>
  );
}
