import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { HTTP_HEADERS_TIMEOUT_MS, HTTP_REQUEST_TIMEOUT_MS } from "../config.js";
import { SessionAuthentication } from "./auth.js";
import { sendJson } from "./http.js";
import { OperationJournal } from "./journal.js";
import { JournalMetrics } from "./metrics.js";
import { createRouteHandler } from "./routes.js";
import { JournalSse } from "./sse.js";
import type { Snapshot, StartServerOptions, WebUiServer } from "./types.js";

export async function startServer(
  getSnapshot: () => Snapshot,
  options: StartServerOptions = {},
): Promise<WebUiServer> {
  const basePath = `/${randomBytes(18).toString("base64url")}/`;
  const authentication = new SessionAuthentication(basePath);
  const metrics = new JournalMetrics(options.metrics);
  const journal = new OperationJournal(
    {
      getSnapshot,
      getPollKey: options.getPollKey,
      getEntries: options.getEntries,
      getPersistedEntries: options.getPersistedEntries,
      getLiveEntries: options.getLiveEntries,
    },
    metrics,
  );
  const sse = new JournalSse(journal, metrics);
  const handle = createRouteHandler({ basePath, authentication, journal, options, sse });
  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "Server error" });
      else response.destroy();
    });
  });
  server.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  server.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    authentication.close();
    await handle.close();
    sse.close();
    throw error;
  }

  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  authentication.allowOrigin(origin);
  let closePromise: Promise<void> | undefined;

  return {
    url: `${origin}${basePath}`,
    origin,
    port,
    generation: journal.generation,
    get commandEpoch() {
      return journal.commandEpoch;
    },
    get imageAttachmentCapability() {
      return journal.imageAttachmentCapability;
    },
    bootstrapUrl(publicOrigin = origin) {
      return authentication.bootstrapUrl(publicOrigin);
    },
    broadcast(mode) {
      sse.broadcast(mode);
    },
    completeCommand(commandId, commandEpoch, status, error) {
      journal.publishCommandCompletion(commandId, commandEpoch, status, error);
    },
    reset(reason) {
      sse.reset(reason);
    },
    metrics() {
      return metrics.snapshot();
    },
    close() {
      if (closePromise) return closePromise;
      authentication.close();
      sse.close();
      closePromise = (async () => {
        const serverClosed = new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        await Promise.all([handle.close(), serverClosed]);
      })();
      return closePromise;
    },
  };
}

export type {
  CommandAcceptance,
  CompletionItem,
  InputDelivery,
  PendingInput,
  PendingInputBrokerCapability,
  SessionMetadata,
  Snapshot,
  SnapshotTheme,
  StartServerOptions,
  ThemePalette,
  WebUiServer,
} from "./types.js";
export type { JournalMetricsSink, JournalMetricsSnapshot } from "./metrics.js";
