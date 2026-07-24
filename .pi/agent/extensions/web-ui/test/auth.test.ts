import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "../src/shared/limits.js";
import { RunAuthentication } from "../src/server/auth.js";

describe("run authentication", () => {
  it("exchanges bootstrap credentials once before expiry", () => {
    const authentication = new RunAuthentication();
    const credential = authentication.issueBootstrap(1_000);
    expect(authentication.exchangeBootstrap(credential, 1_001)).toBe(true);
    expect(authentication.exchangeBootstrap(credential, 1_002)).toBe(false);

    const expired = authentication.issueBootstrap(2_000);
    expect(
      authentication.exchangeBootstrap(expired, 2_000 + LIMITS.bootstrapCredentialTtlMs + 1),
    ).toBe(false);
  });

  it("sets and verifies an HttpOnly same-site session cookie", () => {
    const authentication = new RunAuthentication();
    expect(authentication.cookieName).not.toBe(new RunAuthentication().cookieName);
    const setHeader = vi.fn();
    authentication.setSessionCookie({ setHeader } as unknown as ServerResponse, true);
    expect(setHeader).toHaveBeenCalledWith(
      "Set-Cookie",
      expect.stringContaining("HttpOnly; SameSite=Strict; Path=/; Secure"),
    );

    const request = {
      headers: { cookie: `${authentication.cookieName}=${authentication.sessionToken}` },
    } as IncomingMessage;
    expect(authentication.authenticate(request)).toBe(true);
    expect(
      authentication.authenticate({
        headers: { cookie: `${authentication.cookieName}=wrong` },
      } as IncomingMessage),
    ).toBe(false);
  });
});
