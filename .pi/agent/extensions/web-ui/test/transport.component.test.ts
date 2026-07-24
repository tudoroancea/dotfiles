// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { connectWebSocket, exchangeBootstrapCredential } from "../src/web/transport.js";

const originalFetch = globalThis.fetch;
const OriginalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = OriginalWebSocket;
  vi.useRealTimers();
  history.replaceState(null, "", "/");
});

describe("browser bootstrap", () => {
  it("exchanges a fragment credential and strips it before the request settles", async () => {
    history.replaceState(null, "", "/#bootstrap=one-time-secret");
    let hashDuringFetch = "not-called";
    globalThis.fetch = vi.fn(async (_input, init) => {
      hashDuringFetch = location.hash;
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
  });

  it("does not contact the server without a fragment credential", async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch;
    await expect(exchangeBootstrapCredential()).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reconnects with bounded backoff after a transient close", () => {
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
    const states: string[] = [];
    const transport = connectWebSocket(
      () => undefined,
      (state) => states.push(state),
    );
    const first = FakeWebSocket.instances[0]!;
    first.readyState = FakeWebSocket.OPEN;
    first.dispatchEvent(new Event("open"));
    first.dispatchEvent(new CloseEvent("close", { code: 1006 }));

    expect(states).toEqual(["connecting", "open", "closed"]);
    vi.advanceTimersByTime(249);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(states.at(-1)).toBe("connecting");

    transport.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
