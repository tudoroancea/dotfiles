import { Check } from "typebox/value";
import { ServerMessageSchema } from "../shared/wire.js";

export type ConnectionState = "connecting" | "open" | "closed" | "unauthorized";

export interface WebTransport {
  readonly socket: WebSocket;
  send(type: string, fields?: Record<string, unknown>): string;
  close(): void;
}

const RECONNECT_INITIAL_MS = 250;
const RECONNECT_MAX_MS = 5_000;

export function webSocketEndpoint(base: string | URL): URL {
  const url = new URL("ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

function commandId(): string {
  return crypto.randomUUID();
}

export async function exchangeBootstrapCredential(): Promise<boolean> {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const credential = fragment.get("bootstrap");
  if (!credential) return false;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  const response = await fetch(new URL("api/bootstrap", document.baseURI), {
    method: "POST",
    credentials: "same-origin",
    headers: { Authorization: `Bearer ${credential}` },
  });
  if (!response.ok) throw new Error("The bootstrap link is invalid or expired");
  return true;
}

export function connectWebSocket(
  onMessage: (message: unknown) => void,
  onState: (state: ConnectionState) => void,
): WebTransport {
  const url = webSocketEndpoint(document.baseURI);
  let socket: WebSocket;
  let reconnectTimer: number | undefined;
  let reconnectAttempts = 0;
  let manuallyClosed = false;

  const open = () => {
    onState("connecting");
    socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      reconnectAttempts = 0;
      onState("open");
    });
    socket.addEventListener("close", (event) => {
      if (manuallyClosed) return;
      onState(event.code === 1008 ? "unauthorized" : "closed");
      const delay = Math.min(RECONNECT_INITIAL_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
      reconnectAttempts += 1;
      reconnectTimer = window.setTimeout(open, delay);
    });
    socket.addEventListener("message", (event) => {
      try {
        const message: unknown = JSON.parse(String(event.data));
        if (!Check(ServerMessageSchema, message)) throw new Error("Invalid server message");
        onMessage(message);
      } catch {
        onMessage({ type: "transport_error", error: "Server sent an invalid message" });
      }
    });
  };

  open();
  return {
    get socket() {
      return socket;
    },
    send(type, fields = {}) {
      if (socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open");
      const id = commandId();
      socket.send(JSON.stringify({ type, commandId: id, ...fields }));
      return id;
    },
    close() {
      manuallyClosed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket.close();
    },
  };
}
