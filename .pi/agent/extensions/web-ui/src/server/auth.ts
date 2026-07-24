import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LIMITS } from "../shared/limits.js";

const COOKIE_PREFIX = "pi_web_ui_";

function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function equals(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

export class RunAuthentication {
  readonly sessionToken = token();
  readonly cookieName = `${COOKIE_PREFIX}${token(9)}`;
  private readonly bootstrapDigests = new Map<string, number>();

  issueBootstrap(now = Date.now()): string {
    this.prune(now);
    const credential = token();
    this.bootstrapDigests.set(
      digest(credential).toString("hex"),
      now + LIMITS.bootstrapCredentialTtlMs,
    );
    return credential;
  }

  exchangeBootstrap(credential: string, now = Date.now()): boolean {
    this.prune(now);
    const key = digest(credential).toString("hex");
    const expiresAt = this.bootstrapDigests.get(key);
    if (expiresAt === undefined || expiresAt < now) return false;
    this.bootstrapDigests.delete(key);
    return true;
  }

  authenticate(request: IncomingMessage): boolean {
    const candidate = parseCookies(request.headers.cookie).get(this.cookieName);
    return candidate !== undefined && equals(candidate, this.sessionToken);
  }

  setSessionCookie(response: ServerResponse, secure: boolean): void {
    response.setHeader(
      "Set-Cookie",
      `${this.cookieName}=${this.sessionToken}; HttpOnly; SameSite=Strict; Path=/${secure ? "; Secure" : ""}`,
    );
  }

  clear(): void {
    this.bootstrapDigests.clear();
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.bootstrapDigests) {
      if (expiresAt < now) this.bootstrapDigests.delete(key);
    }
  }
}

export function bearerCredential(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const credential = authorization.slice("Bearer ".length).trim();
  return credential || undefined;
}
