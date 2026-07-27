import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LIMITS } from "../shared/limits.js";
import type { ClientCommand } from "../shared/wire.js";

const COOKIE_PREFIX = "pi_web_ui_";

export interface StandalonePrincipal {
  kind: "standalone-controller";
}

export interface AuthFailure {
  ok: false;
  status: 401 | 403;
  message: string;
}

export interface AuthSuccess {
  ok: true;
  principal: StandalonePrincipal;
}

export type AuthResult = AuthSuccess | AuthFailure;

export interface AuthenticationProvider {
  authenticateHttp(request: IncomingMessage): AuthResult;
  authenticateWebSocket(request: IncomingMessage): AuthResult;
  authorize(principal: StandalonePrincipal, command: ClientCommand): boolean;
}

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

export class StandaloneAuthentication implements AuthenticationProvider {
  readonly sessionToken = token();
  readonly cookieName = `${COOKIE_PREFIX}${token(9)}`;
  private readonly bootstrapDigests = new Map<string, number>();

  constructor(
    private readonly cookiePath: string,
    private readonly secureCookie: boolean,
  ) {}

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

  authenticateHttp(request: IncomingMessage): AuthResult {
    return this.authenticate(request);
  }

  authenticateWebSocket(request: IncomingMessage): AuthResult {
    return this.authenticate(request);
  }

  authorize(_principal: StandalonePrincipal, _command: ClientCommand): boolean {
    return true;
  }

  setSessionCookie(response: ServerResponse): void {
    response.setHeader(
      "Set-Cookie",
      `${this.cookieName}=${this.sessionToken}; HttpOnly; SameSite=Strict; Path=${this.cookiePath}${this.secureCookie ? "; Secure" : ""}`,
    );
  }

  clear(): void {
    this.bootstrapDigests.clear();
  }

  private authenticate(request: IncomingMessage): AuthResult {
    const candidate = parseCookies(request.headers.cookie).get(this.cookieName);
    return candidate !== undefined && equals(candidate, this.sessionToken)
      ? { ok: true, principal: { kind: "standalone-controller" } }
      : { ok: false, status: 401, message: "Authentication required" };
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
