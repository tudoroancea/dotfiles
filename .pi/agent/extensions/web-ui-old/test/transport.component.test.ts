// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectWebSocket,
  exchangeBootstrapCredential,
  webSocketEndpoint,
} from "../src/web/transport.js";

const originalFetch = globalThis.fetch;
const OriginalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = OriginalWebSocket;
  vi.useRealTimers();
  history.replaceState(null, "", "/");
});

describe("browser bootstrap and proxy-safe transport", () => {
  it("exchanges a base-path fragment credential and strips it before the request settles", async () => {
    history.replaceState(null, "", "/_pi/s/launch/#bootstrap=one-time-secret");
    let hashDuringFetch = "not-called";
    globalThis.fetch = vi.fn(async (input, init) => {
      hashDuringFetch = location.hash;
      expect(String(input)).toBe("http://localhost:3000/_pi/s/launch/api/bootstrap");
      expect(init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        headers: { Authorization: "Bearer one-time-secret" },
      });
      return new Response(undefined, { status: 204 });
    });

    await expect(exchangeBootstrapCredential()).resolves.toBe(true);
    expect(hashDuringFetch).toBe("");
    expect(location.hash).toBe("");
    expect(location.pathname).toBe("/_pi/s/launch/");
  });

  it("does not contact the server without a fragment credential", async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch;
    await expect(exchangeBootstrapCredential()).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("derives WebSocket protocol and path from the browser-visible URL", () => {
    expect(webSocketEndpoint("https://machine.ts.net/_pi/s/launch/").href).toBe(
      "wss://machine.ts.net/_pi/s/launch/ws",
    );
    expect(webSocketEndpoint("http://127.0.0.1:3000/nested/").href).toBe(
      "ws://127.0.0.1:3000/nested/ws",
    );
  });

  it("reconnects to the same base path with bounded backoff after a transient close", () => {
    vi.useFakeTimers();
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static instances: FakeWebSocket[] = [];
      readonly url: string;
      readyState = 0;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        FakeWebSocket.instances.push(this);
      }

      send() {}
      close() {
        this.readyState = 3;
      }
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    history.replaceState(null, "", "/_pi/s/launch/");
    const states: string[] = [];
    const transport = connectWebSocket(
      () => undefined,
      (state) => states.push(state),
    );
    const first = FakeWebSocket.instances[0]!;
    expect(first.url).toBe("ws://localhost:3000/_pi/s/launch/ws");
    first.readyState = FakeWebSocket.OPEN;
    first.dispatchEvent(new Event("open"));
    first.dispatchEvent(new CloseEvent("close", { code: 1006 }));

    expect(states).toEqual(["connecting", "open", "closed"]);
    vi.advanceTimersByTime(249);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]!.url).toBe(first.url);
    expect(states.at(-1)).toBe("connecting");

    transport.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("sends a caller-supplied command id so history pages correlate exactly", () => {
    const sent: string[] = [];
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      static instances: FakeWebSocket[] = [];
      readyState = FakeWebSocket.OPEN;
      constructor(readonly url: string | URL) {
        super();
        FakeWebSocket.instances.push(this);
      }
      send(data: string) {
        sent.push(data);
      }
      close() {
        this.readyState = 3;
      }
    }
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    history.replaceState(null, "", "/");
    const transport = connectWebSocket(
      () => undefined,
      () => undefined,
    );

    const explicit = transport.send("history_page", { cursor: "opaque" }, "correlation-1234");
    expect(explicit).toBe("correlation-1234");
    const generated = transport.send("ping");
    expect(generated).not.toBe("correlation-1234");

    const first = JSON.parse(sent[0]!) as { commandId: string; cursor: string; type: string };
    expect(first).toMatchObject({
      type: "history_page",
      commandId: "correlation-1234",
      cursor: "opaque",
    });
    const second = JSON.parse(sent[1]!) as { commandId: string };
    expect(second.commandId).toBe(generated);
    expect(second.commandId).not.toBe("correlation-1234");
    transport.close();
  });
});
