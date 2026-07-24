import { useEffect, useRef, useState } from "preact/hooks";
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
            } else if (record.type === "snapshot") {
              const snapshot = record.snapshot as { isIdle?: boolean } | undefined;
              if (snapshot) setMode(snapshot.isIdle ? "prompt" : "steer");
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
  }, []);

  const submit = (event: Event) => {
    event.preventDefault();
    const value = content.trim();
    if (!value || transport.current?.socket.readyState !== WebSocket.OPEN) return;
    transport.current.send(mode, { content: value });
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
          <button type="submit" disabled={connection !== "open" || !content.trim()}>
            Send
          </button>
          <button
            type="button"
            disabled={connection !== "open"}
            onClick={() => transport.current?.send("abort")}
          >
            Abort
          </button>
        </div>
      </form>
    </main>
  );
}
