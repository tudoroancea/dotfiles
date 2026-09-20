import type { ServerResponse } from "node:http";
import { LIMITS } from "@dotfiles/pi-web-ui-client/wire";

// Request/response bounds and security posture shared by every standalone route.

export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const MAX_INPUT_BYTES = 32 * 1024;
// Worst-case JSON expansion is six bytes per input byte (`\u0000`). Splitting
// base64 across attachments can add one padded quartet per attachment; the
// remaining allowance bounds the envelope, identities, and attachment metadata.
export const MAX_IMAGE_COMMAND_BODY_BYTES =
  Math.ceil(LIMITS.maxImageSourceBytesPerEntry / 3) * 4 +
  LIMITS.maxImagesPerEntry * 4 +
  MAX_INPUT_BYTES * 6 +
  LIMITS.maxImagesPerEntry * 512 +
  4 * 1024;
export const MAX_CONCURRENT_IMAGE_COMMAND_BODIES = 4;
export const MAX_RETAINED_IMAGE_ADMISSION_BYTES =
  MAX_CONCURRENT_IMAGE_COMMAND_BODIES * MAX_IMAGE_COMMAND_BODY_BYTES;
export const IMAGE_COMMAND_BODY_TIMEOUT_MS = 15_000;
export const HTTP_HEADERS_TIMEOUT_MS = 10_000;
export const HTTP_REQUEST_TIMEOUT_MS = 20_000;
export const MAX_COMPLETION_QUERY_BYTES = 4 * 1024;
export const MAX_BOOTSTRAP_CODES = 8;
export const BOOTSTRAP_CODE_TTL_MS = 2 * 60 * 1000;

export const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// Strict production Content-Security-Policy. The bundle is fully self-contained:
// scripts and styles load only from the ephemeral same origin. Transcript images
// use authenticated same-origin references; `https:` remains deliberately and only
// for existing Markdown image compatibility. Inline `data:` images are forbidden.
// SSE/fetch stay same-origin, and framing is denied. No `'unsafe-inline'` is
// required because the theme is applied through the CSSOM rather than an injected
// stylesheet.
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
}
