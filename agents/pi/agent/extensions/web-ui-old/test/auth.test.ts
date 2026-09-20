import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "../src/shared/limits.js";
import { StandaloneAuthentication } from "../src/server/auth.js";

describe("standalone authentication boundary", () => {
  it("exchanges bootstrap credentials once before expiry", () => {
    const authentication = new StandaloneAuthentication("/session/", false);
    const credential = authentication.issueBootstrap(1_000);
    expect(authentication.exchangeBootstrap(credential, 1_001)).toBe(true);
    expect(authentication.exchangeBootstrap(credential, 1_002)).toBe(false);

    const expired = authentication.issueBootstrap(2_000);
    expect(
      authentication.exchangeBootstrap(expired, 2_000 + LIMITS.bootstrapCredentialTtlMs + 1),
    ).toBe(false);
  });

  it("sets a path-scoped cookie and authenticates HTTP and WebSocket requests", () => {
    const authentication = new StandaloneAuthentication("/_pi/s/launch/", true);
    expect(authentication.cookieName).not.toBe(
      new StandaloneAuthentication("/_pi/s/other/", true).cookieName,
    );
    const setHeader = vi.fn();
    authentication.setSessionCookie({ setHeader } as unknown as ServerResponse);
    expect(setHeader).toHaveBeenCalledWith(
      "Set-Cookie",
      expect.stringContaining("SameSite=Strict; Path=/_pi/s/launch/; Secure"),
    );

    const request = {
      headers: { cookie: `${authentication.cookieName}=${authentication.sessionToken}` },
    } as IncomingMessage;
    expect(authentication.authenticateHttp(request)).toMatchObject({ ok: true });
    expect(authentication.authenticateWebSocket(request)).toMatchObject({ ok: true });
    expect(
      authentication.authenticateHttp({
        headers: {
          cookie: `${authentication.cookieName}=wrong`,
          "x-forwarded-user": "spoofed",
          "tailscale-user-login": "spoofed@example.com",
        },
      } as unknown as IncomingMessage),
    ).toMatchObject({ ok: false, status: 401 });
  });
});
