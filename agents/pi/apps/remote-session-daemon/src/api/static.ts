import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_ROOT = fileURLToPath(new URL("../../dist/client/", import.meta.url));
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

function staticHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

export function redirectToAppRoot(response: ServerResponse): void {
  staticHeaders(response);
  response.writeHead(308, { location: "/_pi/", "content-length": "0" });
  response.end();
}

export async function serveManagedDocument(response: ServerResponse): Promise<boolean> {
  return serveFile("index.html", response, {
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https:; " +
      "font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; " +
      "frame-ancestors 'none'; object-src 'none'",
  });
}

export async function serveManagedAsset(
  assetName: string,
  response: ServerResponse,
): Promise<boolean> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(assetName)) return false;
  return serveFile(join("assets", assetName), response);
}

async function serveFile(
  relativePath: string,
  response: ServerResponse,
  headers: Readonly<Record<string, string>> = {},
): Promise<boolean> {
  let content: Buffer;
  try {
    content = await readFile(join(CLIENT_ROOT, relativePath));
  } catch {
    return false;
  }
  staticHeaders(response);
  response.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(relativePath)] ?? "application/octet-stream",
    "content-length": content.byteLength,
    ...headers,
  });
  response.end(content);
  return true;
}
