#!/usr/bin/env node
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:http";
import { promisify } from "node:util";

const exec = promisify(execFile);
const IDENTITY = ["tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic"];
const SPOOF = "phase-0c-forged.invalid";

function argumentsFrom(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) values[argv[i]?.replace(/^--/, "")] = argv[i + 1];
  const url = new URL(values.url);
  const port = Number(values["listen-port"]);
  const heartbeatMs = Number(values["heartbeat-ms"] ?? 1000);
  const minimumVersion = values["minimum-version"];
  const maximumExclusiveVersion = values["maximum-exclusive-version"];
  if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password)
    throw new Error("--url must be an HTTPS origin without path or credentials");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("--listen-port is required");
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 100 || heartbeatMs > 30000)
    throw new Error("invalid --heartbeat-ms");
  if (!semanticVersion(minimumVersion) || !semanticVersion(maximumExclusiveVersion))
    throw new Error(
      "--minimum-version and --maximum-exclusive-version are required semantic versions",
    );
  if (compareVersions(minimumVersion, maximumExclusiveVersion) >= 0)
    throw new Error("audited Tailscale version range is empty");
  return {
    url,
    port,
    heartbeatMs,
    minimumVersion,
    maximumExclusiveVersion,
    evidence: values.evidence,
  };
}

function semanticVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}
function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

async function tailscaleEnvironment() {
  try {
    const [{ stdout }, { stdout: versionOutput }] = await Promise.all([
      exec("tailscale", ["status", "--json"], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      }),
      exec("tailscale", ["version", "--json"], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 64 * 1024,
      }),
    ]);
    const name = JSON.parse(stdout)?.Self?.DNSName;
    const versionInfo = JSON.parse(versionOutput);
    const version = versionInfo?.majorMinorPatch ?? versionInfo?.short;
    return {
      name: typeof name === "string" && name.endsWith(".") ? name.slice(0, -1) : null,
      version: semanticVersion(version) ? version : null,
    };
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message.slice(0, 300) : "unknown" };
  }
}

function backend(options, token, seen) {
  const prefix = `/__pi_tailscale_ingress_spike/${token}`;
  const server = createServer((request, response) => {
    if (request.url === `${prefix}/headers`) {
      seen.headers = {
        origin: request.headers.origin ?? null,
        identity: Object.fromEntries(IDENTITY.map((name) => [name, request.headers[name] ?? null])),
      };
      response.setHeader("content-type", "application/json");
      response.end("{}");
      return;
    }
    if (request.url === `${prefix}/events`) {
      seen.sse.push(request.headers["last-event-id"] ?? null);
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      });
      if (request.headers["last-event-id"] === "1")
        return void response.end("id: 2\ndata: reconnected\n\n");
      response.write("retry: 250\nid: 1\ndata: initial\n\n");
      let count = 0;
      const timer = setInterval(() => {
        count += 1;
        response.write(`: heartbeat ${count}\n\n`);
        if (count === 2) {
          clearInterval(timer);
          seen.sseBackendCloseAt = Date.now();
          response.end("data: close\n\n");
        }
      }, options.heartbeatMs);
      response.on("close", () => clearInterval(timer));
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve({ server, prefix }));
  });
}

async function stream(response, timeoutMs) {
  if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
  const reader = response.body.getReader();
  const start = Date.now();
  let first = null;
  let text = "";
  const timer = setTimeout(() => void reader.cancel("timeout"), timeoutMs);
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (first === null) first = { elapsedMs: Date.now() - start, receivedAt: Date.now() };
      text += new TextDecoder().decode(part.value);
      if (text.length > 16384) throw new Error("SSE evidence exceeded 16 KiB");
    }
  } finally {
    clearTimeout(timer);
  }
  return { text, first, duration: Date.now() - start };
}

async function main() {
  if (process.env.TAILSCALE_INGRESS_SPIKE !== "1")
    throw new Error(
      "set TAILSCALE_INGRESS_SPIKE=1 to opt in; Serve configuration is never changed",
    );
  const options = argumentsFrom(process.argv.slice(2));
  const evidence = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    configurationChanged: false,
    target: { origin: options.url.origin, hostname: options.url.hostname },
    auditedTailscaleVersions: {
      minimum: options.minimumVersion,
      maximumExclusive: options.maximumExclusiveVersion,
    },
    checks: {},
    observations: {},
  };
  const seen = { headers: null, sse: [], sseBackendCloseAt: null };
  let server;
  try {
    const running = await backend(options, Math.random().toString(36).slice(2, 14), seen);
    server = running.server;
    const probe = (name) => new URL(`${running.prefix}/${name}`, options.url.origin);
    const environment = await tailscaleEnvironment();
    evidence.observations.tailscaleStatus = environment;
    evidence.checks.magicDns = {
      passed: environment.name === options.url.hostname,
    };
    evidence.checks.tailscaleVersion = {
      passed:
        semanticVersion(environment.version) &&
        compareVersions(environment.version, options.minimumVersion) >= 0 &&
        compareVersions(environment.version, options.maximumExclusiveVersion) < 0,
      observed: environment.version ?? null,
    };

    const headers = { origin: options.url.origin };
    for (const name of IDENTITY) headers[name] = SPOOF;
    const headerResponse = await fetch(probe("headers"), {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!headerResponse.ok) throw new Error(`header probe HTTP ${headerResponse.status}`);
    await headerResponse.arrayBuffer();
    const observed = seen.headers?.identity ?? {};
    evidence.checks.identity = {
      passed: typeof observed[IDENTITY[0]] === "string" && observed[IDENTITY[0]] !== SPOOF,
      headersPresent: Object.fromEntries(
        IDENTITY.map((name) => [name, typeof observed[name] === "string"]),
      ),
    };
    evidence.checks.spoofStripping = {
      passed: IDENTITY.every((name) => observed[name] !== SPOOF),
      forgedMarkerObserved: IDENTITY.some((name) => observed[name] === SPOOF),
    };
    evidence.checks.origin = {
      passed: seen.headers?.origin === options.url.origin,
      exactOrigin: options.url.origin,
    };

    const first = await stream(
      await fetch(probe("events"), {
        redirect: "error",
        signal: AbortSignal.timeout(options.heartbeatMs * 4 + 5000),
      }),
      options.heartbeatMs * 4 + 3000,
    );
    const second = await stream(
      await fetch(probe("events"), {
        headers: { "last-event-id": "1" },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      }),
      5000,
    );
    const heartbeats = (first.text.match(/: heartbeat/g) ?? []).length;
    const flushThresholdMs = options.heartbeatMs + 250;
    const flushed =
      first.first !== null &&
      seen.sseBackendCloseAt !== null &&
      first.first.receivedAt < seen.sseBackendCloseAt &&
      first.first.elapsedMs <= flushThresholdMs;
    evidence.checks.sse = {
      passed:
        flushed &&
        heartbeats >= 2 &&
        seen.sse[1] === "1" &&
        second.text.includes("data: reconnected"),
      initialFlushObserved: flushed,
      firstChunkMs: first.first?.elapsedMs ?? null,
      backendCloseAt: seen.sseBackendCloseAt,
      flushThresholdMs,
      durationMs: first.duration,
      heartbeatCount: heartbeats,
      reconnectLastEventIdObserved: seen.sse[1] === "1",
    };
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message.slice(0, 500) : "unknown";
  } finally {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  }
  evidence.status = [
    "magicDns",
    "tailscaleVersion",
    "identity",
    "spoofStripping",
    "origin",
    "sse",
  ].every((name) => evidence.checks[name]?.passed)
    ? "verified"
    : "unavailable-or-failed";
  const output = `${JSON.stringify(evidence, null, 2)}\n`;
  if (Buffer.byteLength(output) > 64 * 1024) throw new Error("evidence exceeded 64 KiB");
  if (options.evidence) {
    const evidenceFile = await open(
      options.evidence,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await evidenceFile.writeFile(output);
    } finally {
      await evidenceFile.close();
    }
  }
  process.stdout.write(output);
  process.exitCode = evidence.status === "verified" ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 2;
});
