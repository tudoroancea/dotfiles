// Mock standalone server for the Pi web UI.
//
// Replaces the server the TUI normally spawns: it serves the committed
// `dist/client/` bundle over loopback and streams the shared `toolShowcaseScenario()`
// timeline from `@dotfiles/pi-web-ui-client/testing` as protocol v1 envelopes, so the
// production browser client connects unmodified and every tool call can be inspected
// pending, partial, settled and failed without a live Pi session.
//
// The scenario is host-neutral data: this server owns the timers, the speed factor,
// the generation and revision numbers, the append anchors and the routes.
//
// Unlike the shipped server this one skips the one-use authentication bootstrap and
// serves from `/` instead of a random base path — it is a local-only developer aid.
// Every frame is still validated with the real `isServerEnvelope` before it is
// written, so a timeline the browser would reject fails loudly here instead.
//
// Flags:
//   --speed=<factor>  playback rate; 1 is the authored timing, 0.25 is quarter speed
//                     (every wait takes four times as long). Default 1.
//   --port=<number>   listening port; 0 (the default) picks an ephemeral port.
//   --loop            restart the sequence from a fresh generation when it finishes.
//
// Example: node mock/server.mjs --speed=0.25 --port=4173 --loop

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { isServerEnvelope, LIMITS } from "@dotfiles/pi-web-ui-client/wire";
import { TOOL_SHOWCASE_IMAGE, toolShowcaseScenario } from "@dotfiles/pi-web-ui-client/testing";

const CLIENT_ROOT = fileURLToPath(new URL("../dist/client/", import.meta.url));
/** Pause between a finished sequence and the restarted one under `--loop`. */
const LOOP_PAUSE = 3_000;
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const COMPLETION_CANDIDATES = [
  { value: "agent/extensions/web-ui/mock/server.mjs", label: "mock/server.mjs" },
  { value: "packages/pi-web-ui-client/src/testing/tool-showcase.ts", label: "tool-showcase.ts" },
  { value: "packages/pi-web-ui-client/src/wire/protocol.ts", label: "wire/protocol.ts" },
  { value: "packages/pi-web-ui-client/src/client/renderers.tsx", label: "client/renderers.tsx" },
  { value: "agent/extensions/web-ui/README.md", label: "README.md", description: "extension docs" },
];

function parseFlags(argv) {
  const flags = { speed: 1, port: 0, loop: false };
  for (const argument of argv) {
    const [name, value] = argument.split("=");
    // `nub run mock -- --speed=0.25` forwards the separator itself.
    if (name === "--") continue;
    else if (name === "--loop") flags.loop = true;
    else if (name === "--speed") flags.speed = Number(value);
    else if (name === "--port") flags.port = Number(value);
    else {
      process.stderr.write(`Unknown argument: ${argument}\n`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(flags.speed) || flags.speed <= 0) {
    process.stderr.write("--speed must be a positive number\n");
    process.exit(2);
  }
  if (!Number.isInteger(flags.port) || flags.port < 0 || flags.port > 65_535) {
    process.stderr.write("--port must be an integer between 0 and 65535\n");
    process.exit(2);
  }
  return flags;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(body === undefined ? "" : JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function commandResponse(command, accepted, error) {
  return {
    version: 1,
    type: "command-response",
    commandId: command.commandId,
    generation: command.generation,
    commandEpoch: command.commandEpoch,
    ...(accepted ? { accepted: true } : { accepted: false, error }),
  };
}

class MockSession {
  #clients = new Set();
  #completions = [];
  #attachments = new Map();
  #round = 0;
  #generation = "";
  #commandEpoch = "";
  #historyGeneration = "";
  #revision = 0;
  #snapshot;
  #scenario;

  constructor(speed) {
    this.speed = speed;
    this.#load();
  }

  #load() {
    this.#round += 1;
    this.#generation = `mock-generation-${this.#round}`;
    this.#commandEpoch = `mock-command-epoch-${this.#round}`;
    this.#historyGeneration = `mock-history-${this.#round}`;
    this.#revision = 0;
    this.#completions = [];
    this.#scenario = toolShowcaseScenario({
      commandEpoch: this.#commandEpoch,
      historyGeneration: this.#historyGeneration,
    });
    this.#snapshot = this.#scenario.snapshot;
    const appended = this.#scenario.steps.reduce(
      (total, step) =>
        total +
        step.operations.reduce(
          (count, operation) =>
            count + (operation.kind === "append" ? operation.entries.length : 0),
          0,
        ),
      0,
    );
    const total = this.#snapshot.entries.length + appended;
    if (total > LIMITS.maxSnapshotEntries) {
      throw new Error(
        `Scripted timeline has ${total} entries but a snapshot may carry at most ` +
          `${LIMITS.maxSnapshotEntries}; a reconnect near the end of the sequence would fail.`,
      );
    }
    this.entryCount = total;
    this.stepCount = this.#scenario.steps.length;
  }

  get generation() {
    return this.#generation;
  }

  get commandEpoch() {
    return this.#commandEpoch;
  }

  #envelope(envelope) {
    if (!isServerEnvelope(envelope)) {
      throw new Error(`Refusing to send a schema-invalid ${envelope.type} frame`);
    }
    return `data: ${JSON.stringify(envelope)}\n\n`;
  }

  #broadcast(envelope) {
    const frame = this.#envelope(envelope);
    for (const client of this.#clients) client.write(frame);
  }

  #snapshotEnvelope() {
    return {
      version: 1,
      type: "snapshot",
      generation: this.#generation,
      revision: this.#revision,
      snapshot: this.#snapshot,
    };
  }

  #apply(operations) {
    let snapshot = this.#snapshot;
    for (const operation of operations) {
      if (operation.kind === "append") {
        snapshot = {
          ...snapshot,
          entries: [...snapshot.entries, ...operation.entries],
          leafId: operation.entries.at(-1).id,
        };
      } else if (operation.kind === "live-tail") {
        snapshot = { ...snapshot, liveTail: operation.entries };
      } else if (operation.kind === "metadata") {
        snapshot = { ...snapshot, metadata: operation.metadata };
      } else if (operation.kind === "queue") {
        snapshot = { ...snapshot, queue: operation.queue };
      } else if (operation.kind === "running") {
        snapshot = { ...snapshot, running: operation.running };
      } else throw new Error(`Unhandled operation kind: ${operation.kind}`);
    }
    this.#snapshot = snapshot;
  }

  /**
   * Re-anchors an append to the live tail. The scripted anchors would go stale as soon
   * as a submitted command inserts an entry of its own, so the anchor and the entry
   * parents are always assigned here rather than in the timeline.
   */
  #anchor(operation) {
    const afterId = this.#snapshot.entries.at(-1)?.id ?? null;
    let parentId = afterId;
    const entries = operation.entries.map((entry) => {
      const anchored = { id: entry.id, payload: { ...entry.payload, parentId } };
      parentId = entry.id;
      return anchored;
    });
    return { kind: "append", afterId, entries };
  }

  publish(operations) {
    const anchored = operations.map((operation) =>
      operation.kind === "append" ? this.#anchor(operation) : operation,
    );
    const fromRevision = this.#revision;
    this.#apply(anchored);
    this.#revision += 1;
    this.#broadcast({
      version: 1,
      type: "operations",
      generation: this.#generation,
      fromRevision,
      revision: this.#revision,
      operations: anchored,
    });
  }

  #complete(commandId) {
    const envelope = {
      version: 1,
      type: "command-completion",
      commandId,
      generation: this.#generation,
      commandEpoch: this.#commandEpoch,
      revision: this.#revision,
      status: "completed",
    };
    this.#completions.push(envelope);
    this.#broadcast(envelope);
  }

  addClient(response) {
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Connection", "keep-alive");
    response.write(this.#envelope(this.#snapshotEnvelope()));
    for (const completion of this.#completions) response.write(this.#envelope(completion));
    this.#clients.add(response);
    const remove = () => this.#clients.delete(response);
    response.on("close", remove);
    response.on("error", remove);
  }

  /** An append whose anchor and parent are filled in by `#anchor` at publish time. */
  #appendOperation(message) {
    const id = `mock-live-${randomBytes(6).toString("hex")}`;
    return {
      kind: "append",
      afterId: null,
      entries: [
        {
          id,
          payload: {
            id,
            parentId: null,
            timestamp: new Date().toISOString(),
            type: "message",
            message,
          },
        },
      ],
    };
  }

  /** Turns a submitted command into a user entry, a worked turn and a completion. */
  async accept(command, attachments) {
    const content = [
      { type: "text", text: command.content },
      ...attachments.map((attachment) => ({
        type: "image-reference",
        id: attachment.id,
        mimeType: attachment.mimeType,
        width: attachment.width,
        height: attachment.height,
        byteLength: attachment.byteLength,
      })),
    ];
    this.publish([
      this.#appendOperation({ role: "user", content }),
      { kind: "running", running: { isRunning: true, workingWord: "Replying" } },
    ]);
    await sleep(1_200 / this.speed);
    this.publish([
      this.#appendOperation({
        role: "assistant",
        content: [
          {
            type: "text",
            text: "The mock server has no model behind it — your message was appended to\nthe transcript so the submit path stays inspectable.",
          },
        ],
      }),
      { kind: "running", running: { isRunning: false } },
    ]);
    this.#complete(command.commandId);
  }

  mutateQueue(command) {
    const queue = this.#snapshot.queue;
    const item = queue.find((entry) => entry.id === command.itemId);
    if (!item) return "not-found";
    if ((item.itemVersion ?? 1) !== command.expectedItemVersion) return "stale-item";
    const next =
      command.type === "queue-remove"
        ? queue.filter((entry) => entry.id !== command.itemId)
        : queue.map((entry) =>
            entry.id === command.itemId
              ? { ...entry, content: command.content, itemVersion: (entry.itemVersion ?? 1) + 1 }
              : entry,
          );
    this.publish([{ kind: "queue", queue: next }]);
    return undefined;
  }

  historyPage(request) {
    const oldest = this.#snapshot.entries[0]?.id ?? null;
    if (
      request.generation !== this.#generation ||
      request.historyGeneration !== this.#historyGeneration ||
      request.beforeId !== oldest
    ) {
      return undefined;
    }
    return {
      version: 1,
      type: "history-page",
      generation: this.#generation,
      revision: this.#revision,
      historyGeneration: this.#historyGeneration,
      beforeId: request.beforeId,
      entries: this.#scenario.historyPage,
      nextCursor: null,
      hasMore: false,
    };
  }

  storeAttachment(attachment) {
    const id = randomBytes(24).toString("base64url");
    const content = Buffer.from(attachment.data, "base64");
    this.#attachments.set(id, { mimeType: attachment.mimeType, content });
    return {
      id,
      mimeType: attachment.mimeType,
      width: attachment.width,
      height: attachment.height,
      byteLength: attachment.byteLength,
    };
  }

  image(id) {
    if (id === TOOL_SHOWCASE_IMAGE.id) {
      return {
        mimeType: TOOL_SHOWCASE_IMAGE.mimeType,
        content: Buffer.from(TOOL_SHOWCASE_IMAGE.base64, "base64"),
      };
    }
    return this.#attachments.get(id);
  }

  /** Plays the scripted steps, then either idles on the pending tail or restarts. */
  async play(loop) {
    for (;;) {
      let index = 0;
      for (const step of this.#scenario.steps) {
        await sleep(step.delayMs / this.speed);
        this.publish(step.operations);
        index += 1;
      }
      process.stdout.write(`Sequence complete: ${index} steps, ${this.entryCount} entries.\n`);
      if (!loop) return;
      await sleep(LOOP_PAUSE / this.speed);
      this.#load();
      process.stdout.write(`Restarting as generation ${this.#generation}.\n`);
      this.#broadcast(this.#snapshotEnvelope());
    }
  }
}

async function serveStatic(route, response) {
  const relative = route === "" ? "index.html" : route;
  const filePath = normalize(join(CLIENT_ROOT, relative));
  if (!filePath.startsWith(CLIENT_ROOT)) {
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

const flags = parseFlags(process.argv.slice(2));
const session = new MockSession(flags.speed);

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    if (!response.headersSent) sendJson(response, 500, { error: "Mock server error" });
    else response.destroy();
  });
});

async function handle(request, response) {
  const route = (request.url ?? "/").split("?")[0].replace(/^\/+/, "");

  if (request.method === "GET" && route === "events") {
    session.addClient(response);
    return;
  }

  if (request.method === "POST" && (route === "input" || route === "input-image")) {
    let command;
    try {
      command = JSON.parse(await readBody(request));
    } catch {
      sendJson(response, 400, { error: "Invalid request" });
      return;
    }
    if (
      command.generation !== session.generation ||
      command.commandEpoch !== session.commandEpoch
    ) {
      sendJson(response, 409, commandResponse(command, false, "Session command epoch is stale"));
      return;
    }
    const attachments = (command.attachments ?? []).map((attachment) =>
      session.storeAttachment(attachment),
    );
    sendJson(response, 202, commandResponse(command, true));
    void session.accept(command, attachments);
    return;
  }

  if (request.method === "POST" && route === "queue") {
    let command;
    try {
      command = JSON.parse(await readBody(request));
    } catch {
      sendJson(response, 400, { error: "Invalid request" });
      return;
    }
    if (
      command.generation !== session.generation ||
      command.commandEpoch !== session.commandEpoch
    ) {
      sendJson(response, 409, {
        ...commandResponse(command, false, "Session command epoch is stale"),
        reason: "session-changed",
      });
      return;
    }
    const rejection = session.mutateQueue(command);
    if (rejection) {
      sendJson(response, 409, {
        ...commandResponse(command, false, `Queue mutation rejected: ${rejection}`),
        reason: rejection,
      });
      return;
    }
    sendJson(response, 202, commandResponse(command, true));
    return;
  }

  if (request.method === "POST" && route === "complete") {
    let query;
    try {
      query = JSON.parse(await readBody(request));
    } catch {
      sendJson(response, 400, { error: "Invalid request" });
      return;
    }
    const needle = String(query.query ?? "").toLowerCase();
    sendJson(response, 200, {
      version: 1,
      type: "completion-response",
      generation: session.generation,
      items: COMPLETION_CANDIDATES.filter((item) => item.value.toLowerCase().includes(needle)),
    });
    return;
  }

  if ((request.method === "POST" || request.method === "GET") && route === "history") {
    let query;
    if (request.method === "POST") {
      try {
        query = JSON.parse(await readBody(request));
      } catch {
        sendJson(response, 400, { error: "Invalid history request" });
        return;
      }
    } else {
      const url = new URL(request.url ?? "/", "http://localhost");
      query = {
        generation: url.searchParams.get("generation") ?? "",
        historyGeneration: url.searchParams.get("historyGeneration") ?? "",
        beforeId: url.searchParams.get("beforeId") ?? "",
      };
    }
    const page = session.historyPage(query);
    if (!page) {
      sendJson(response, 409, {
        version: 1,
        type: "error",
        generation: session.generation,
        code: "STALE_HISTORY",
        message: "History anchor no longer matches this session",
        recoverable: true,
      });
      return;
    }
    sendJson(response, 200, page);
    return;
  }

  if (request.method === "GET" && route.startsWith("image/")) {
    const image = session.image(decodeURIComponent(route.slice("image/".length)));
    if (!image) {
      sendJson(response, 404, { error: "Unknown image reference" });
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", image.mimeType);
    response.setHeader("Content-Length", String(image.content.length));
    response.setHeader("Cache-Control", "no-store");
    response.end(image.content);
    return;
  }

  if (request.method === "GET") {
    await serveStatic(route, response);
    return;
  }

  sendJson(response, 405, { error: "Method not allowed" });
}

server.listen(flags.port, "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(
    `Pi Web UI mock server: http://127.0.0.1:${port}/\n` +
      `  speed ${flags.speed}× · ${session.stepCount} steps · ${session.entryCount} entries` +
      `${flags.loop ? " · looping" : ""}\n`,
  );
  void session.play(flags.loop).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
});
