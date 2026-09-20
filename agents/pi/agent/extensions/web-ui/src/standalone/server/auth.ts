import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BOOTSTRAP_CODE_TTL_MS, MAX_BOOTSTRAP_CODES, MAX_REQUEST_BODY_BYTES } from "../config.js";

const COOKIE_NAME = `pi_wus_${randomBytes(6).toString("base64url")}`;

interface BootstrapCode {
  expiresAt: number;
  timer: NodeJS.Timeout;
}

function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name) cookies.set(name, part.slice(index + 1).trim());
  }
  return cookies;
}

export function readBody(
  request: IncomingMessage,
  maxBytes = MAX_REQUEST_BODY_BYTES,
  timeoutMs?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish(new Error("Request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onAborted = () => finish(new Error("Request aborted"));
    const onError = (error: Error) => finish(error);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        finish(new Error("Request body timed out"));
        request.destroy();
      }, timeoutMs);
      timeout.unref?.();
    }
  });
}

export class SessionAuthentication {
  private readonly sessionToken = randomBytes(32).toString("base64url");
  private readonly bootstrapCodes = new Map<string, BootstrapCode>();
  private readonly allowedOrigins = new Set<string>();

  constructor(private readonly basePath: string) {}

  authenticated(request: IncomingMessage): boolean {
    const cookie = parseCookies(request.headers.cookie).get(COOKIE_NAME);
    return cookie !== undefined && timingSafeEqualString(cookie, this.sessionToken);
  }

  allowOrigin(origin: string): void {
    try {
      this.allowedOrigins.add(new URL(origin).origin);
    } catch {
      // Invalid public origins never become authorized.
    }
  }

  sameOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin || origin === "null") return false;
    try {
      return this.allowedOrigins.has(new URL(origin).origin);
    } catch {
      return false;
    }
  }

  exchange(code: unknown, response: ServerResponse): boolean {
    const bootstrapCode = typeof code === "string" ? this.bootstrapCodes.get(code) : undefined;
    if (typeof code !== "string" || !bootstrapCode || bootstrapCode.expiresAt <= Date.now()) {
      if (typeof code === "string" && bootstrapCode) {
        clearTimeout(bootstrapCode.timer);
        this.bootstrapCodes.delete(code);
      }
      return false;
    }
    clearTimeout(bootstrapCode.timer);
    this.bootstrapCodes.delete(code);
    response.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=${this.sessionToken}; HttpOnly; SameSite=Strict; Path=${this.basePath}`,
    );
    return true;
  }

  bootstrapUrl(origin: string): string {
    this.allowOrigin(origin);
    const now = Date.now();
    for (const [code, bootstrapCode] of this.bootstrapCodes) {
      if (bootstrapCode.expiresAt > now) continue;
      clearTimeout(bootstrapCode.timer);
      this.bootstrapCodes.delete(code);
    }
    while (this.bootstrapCodes.size >= MAX_BOOTSTRAP_CODES) {
      const oldestCode = this.bootstrapCodes.keys().next().value;
      if (oldestCode === undefined) break;
      clearTimeout(this.bootstrapCodes.get(oldestCode)?.timer);
      this.bootstrapCodes.delete(oldestCode);
    }
    const code = randomBytes(24).toString("base64url");
    const timer = setTimeout(() => this.bootstrapCodes.delete(code), BOOTSTRAP_CODE_TTL_MS);
    timer.unref?.();
    this.bootstrapCodes.set(code, { expiresAt: now + BOOTSTRAP_CODE_TTL_MS, timer });
    return `${origin}${this.basePath}#code=${code}`;
  }

  close(): void {
    for (const bootstrapCode of this.bootstrapCodes.values()) clearTimeout(bootstrapCode.timer);
    this.bootstrapCodes.clear();
  }
}
