import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTENT_TYPES } from "../config.js";
import { sendJson } from "./http.js";

const CLIENT_ROOT = fileURLToPath(new URL("../../../dist/client/", import.meta.url));

export async function serveStatic(route: string, response: ServerResponse): Promise<void> {
  const relative = route === "" ? "index.html" : route.replace(/^\/+/, "");
  const filePath = normalize(join(CLIENT_ROOT, relative));
  if (filePath !== CLIENT_ROOT.replace(/\/$/, "") && !filePath.startsWith(CLIENT_ROOT)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  try {
    const content = await readFile(filePath);
    response.statusCode = 200;
    response.setHeader(
      "Content-Type",
      CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
    );
    response.setHeader("Cache-Control", "no-store");
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}
