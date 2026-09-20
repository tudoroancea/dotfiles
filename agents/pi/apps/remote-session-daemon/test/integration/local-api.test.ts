import { request } from "node:http";
import { createConnection } from "node:net";
import {
  CommandResponseEnvelopeSchema,
  ErrorEnvelopeSchema,
  ModelControlResponseEnvelopeSchema,
} from "@dotfiles/pi-web-ui-client/wire";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { startLocalApi } from "../../src/api/server.ts";
import { LocalLaunches } from "../../src/host/launches.ts";
import { LaunchRegistry } from "../../src/host/registry.ts";
import type { SessionHostListener, SessionHostState } from "../../src/host/session-host.ts";

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: { host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }),
        );
      },
    );
    req.on("error", reject).end();
  });
}

function eventStream(
  port: number,
  launchId: string,
  origin?: string,
): Promise<{ status: number; close(): void }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: `/_pi/api/v1/sessions/${launchId}/events`,
        headers: {
          host: `127.0.0.1:${port}`,
          accept: "text/event-stream",
          ...(origin ? { origin } : {}),
        },
      },
      (res) => {
        res.once("data", () =>
          resolve({
            status: res.statusCode!,
            close: () => {
              res.destroy();
              req.destroy();
            },
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject).end();
  });
}

function post(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const encoded = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          host: `127.0.0.1:${port}`,
          origin: `http://127.0.0.1:${port}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(encoded),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }),
        );
      },
    );
    req.on("error", reject).end(encoded);
  });
}

describe("local API", () => {
  it("serves only bounded host, root, and launch metadata", async () => {
    const launches = new LocalLaunches(
      new LaunchRegistry({
        capacity: 1,
        hostFactory: async () => {
          throw new Error("unused");
        },
      }),
      [{ alias: "work", path: "/tmp" }],
      { isTrusted: () => true },
    );
    const api = await startLocalApi({
      config: { listener: { host: "127.0.0.1", port: 0 } },
      launches,
      daemonId: "daemon",
    });
    try {
      expect(await get(api.port, "/_pi/api/v1/host")).toEqual({
        status: 200,
        body: { kind: "pi-local-session-host", apiVersion: 1, daemonId: "daemon" },
      });
      expect(await get(api.port, "/_pi/api/v1/roots")).toEqual({
        status: 200,
        body: { roots: [{ alias: "work" }] },
      });
      expect(await get(api.port, "/_pi/api/v1/sessions")).toEqual({
        status: 200,
        body: { launches: [] },
      });
      expect((await get(api.port, "/_pi/api/v1/sessions/x/events")).status).toBe(406);
      expect(
        (
          await get(api.port, "/_pi/api/v1/sessions/x/events", {
            accept: "text/event-stream",
            origin: "http://attacker.invalid",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await get(api.port, "/_pi/api/v1/sessions/x/events?cursor=1", {
            accept: "text/event-stream",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await get(api.port, "/_pi/api/v1/sessions/x/events", {
            accept: "text/event-stream;q=0",
          })
        ).status,
      ).toBe(406);
    } finally {
      await api.close();
    }
  });

  it.each(["started-api", "public-server"] as const)(
    "starts an event stream, enforces capacity, and closes active streams through %s shutdown",
    async (shutdown) => {
      const listeners = new Set<SessionHostListener>();
      let state!: SessionHostState;
      const registry = new LaunchRegistry({
        capacity: 1,
        hostFactory: async (input) => {
          state = {
            launchId: input.launchId,
            hostEpoch: input.hostEpoch,
            sessionEpoch: "session-epoch",
            lifecycle: "ready",
            ready: true,
            running: false,
            settled: true,
            pendingMessages: 0,
            queueCount: 0,
            queueBytes: 0,
            dialog: null,
            model: null,
            thinkingLevel: "off",
            identity: { sessionId: "session", sessionFile: "/tmp/session.jsonl" },
          };
          return {
            get state() {
              return structuredClone(state);
            },
            subscribe(listener) {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
            commands: () => [],
            async command(command) {
              return { status: "accepted" as const, commandId: command.commandId };
            },
            async transition() {
              return { status: "completed" as const };
            },
            async history() {
              return { entries: [], nextCursor: null, degraded: false, omittedEntries: 0 };
            },
            async projectionRead() {
              return {
                sessionEpoch: state.sessionEpoch,
                entries: [],
                beforeCursor: null,
                hasMore: false,
                queue: [],
              };
            },
            async dispose() {},
          };
        },
      });
      const launch = await registry.create("/tmp");
      const launches = new LocalLaunches(registry, [{ alias: "work", path: "/tmp" }], {
        isTrusted: () => true,
      });
      const api = await startLocalApi({
        config: { listener: { host: "127.0.0.1", port: 0 } },
        launches,
      });
      const received: unknown[] = [];
      let ended!: () => void;
      let operationArrived!: () => void;
      const streamEnded = new Promise<void>((resolve) => (ended = resolve));
      const operationReceived = new Promise<void>((resolve) => (operationArrived = resolve));
      const connected = new Promise<void>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: api.port,
            path: `/_pi/api/v1/sessions/${launch.launchId}/events`,
            headers: { host: `127.0.0.1:${api.port}`, accept: "text/event-stream" },
          },
          (res) => {
            expect(res.statusCode).toBe(200);
            expect(res.headers["content-type"]).toContain("text/event-stream");
            let pending = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              pending += chunk;
              let boundary: number;
              while ((boundary = pending.indexOf("\n\n")) >= 0) {
                const event = pending.slice(0, boundary);
                pending = pending.slice(boundary + 2);
                if (event.startsWith("data: ")) {
                  const value = JSON.parse(event.slice(6)) as { type?: string };
                  received.push(value);
                  if (value.type === "operations") operationArrived();
                }
              }
              if (received.length > 0) resolve();
            });
            res.on("end", ended);
            res.on("close", ended);
          },
        );
        req.on("error", reject).end();
      });
      const additionalStreams: Array<{ status: number; close(): void }> = [];
      let nonReading: ReturnType<typeof createConnection> | undefined;
      try {
        await connected;
        expect(received[0]).toMatchObject({
          type: "snapshot",
          generation: launch.generation,
          revision: 0,
        });
        await new Promise<void>((resolve, reject) => {
          const socket = createConnection({ host: "127.0.0.1", port: api.port });
          nonReading = socket;
          socket.once("error", reject);
          socket.once("connect", () => {
            socket.write(
              `GET /_pi/api/v1/sessions/${launch.launchId}/events HTTP/1.1\r\n` +
                `Host: 127.0.0.1:${api.port}\r\nAccept: text/event-stream\r\n\r\n`,
            );
            socket.pause();
            setTimeout(resolve, 10);
          });
        });
        additionalStreams.push(
          ...(await Promise.all(
            Array.from({ length: 6 }, () => eventStream(api.port, launch.launchId)),
          )),
        );
        expect(additionalStreams.every(({ status }) => status === 200)).toBe(true);
        expect(
          (
            await get(api.port, `/_pi/api/v1/sessions/${launch.launchId}/events`, {
              accept: "text/event-stream",
            })
          ).status,
        ).toBe(503);
        for (const listener of listeners)
          listener({ type: "message_start", messageId: "message", role: "assistant" });
        await operationReceived;
        expect(received.some((value) => (value as { type?: string }).type === "operations")).toBe(
          true,
        );
        const shutdownTask =
          shutdown === "started-api"
            ? api.close()
            : new Promise<void>((resolve, reject) =>
                api.server.close((error) => (error ? reject(error) : resolve())),
              );
        await Promise.race([
          shutdownTask,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("SSE shutdown exceeded its bound")), 1000),
          ),
        ]);
        await streamEnded;
      } finally {
        nonReading?.destroy();
        for (const stream of additionalStreams) stream.close();
        await api.close();
        await registry.stopAll();
      }
    },
  );

  it("validates shared session commands and daemon-owned controls", async () => {
    let calls = 0;
    const registry = new LaunchRegistry({
      capacity: 1,
      hostFactory: async (input) => {
        const state: SessionHostState = {
          launchId: input.launchId,
          hostEpoch: input.hostEpoch,
          sessionEpoch: "command-epoch",
          lifecycle: "ready",
          ready: true,
          running: false,
          settled: true,
          pendingMessages: 0,
          queueCount: 0,
          queueBytes: 0,
          dialog: null,
          model: null,
          thinkingLevel: "off",
          identity: { sessionId: "session", sessionFile: "/tmp/session.jsonl" },
        };
        return {
          get state() {
            return structuredClone(state);
          },
          subscribe: () => () => {},
          commands: () => [
            { name: "status", description: "Show status", source: "extension" as const },
          ],
          async command(command: { commandId: string }) {
            calls += 1;
            if (command.commandId.startsWith("rejected")) {
              const code = command.commandId.slice("rejected-".length);
              return {
                status: "rejected" as const,
                commandId: command.commandId,
                code,
                message: "x".repeat(10_000),
              };
            }
            if (command.commandId.startsWith("ambiguous"))
              return {
                status: "ambiguous" as const,
                commandId: command.commandId,
                message: "unknown",
              };
            return { status: "accepted" as const, commandId: command.commandId };
          },
          async transition() {
            return { status: "completed" as const };
          },
          async history() {
            return { entries: [], nextCursor: null, degraded: false, omittedEntries: 0 };
          },
          async projectionRead() {
            return {
              sessionEpoch: state.sessionEpoch,
              entries: [],
              beforeCursor: null,
              hasMore: false,
              queue: [],
            };
          },
          async dispose() {},
        };
      },
    });
    const launch = await registry.create("/tmp");
    const launches = new LocalLaunches(registry, [{ alias: "work", path: "/tmp" }], {
      isTrusted: () => true,
    });
    const api = await startLocalApi({
      config: { listener: { host: "127.0.0.1", port: 0 } },
      launches,
    });
    const command = {
      version: 1,
      type: "command",
      commandId: "browser-command",
      generation: launch.generation,
      commandEpoch: launch.commandEpoch,
      content: "hello",
      delivery: "immediate",
    };
    try {
      expect(
        await post(api.port, `/_pi/api/v1/sessions/${launch.launchId}/reopen`, {}),
      ).toMatchObject({
        status: 200,
        body: { launch: { launchId: launch.launchId, ready: true } },
      });
      expect(await get(api.port, `/_pi/api/v1/sessions/${launch.launchId}/commands`)).toEqual({
        status: 200,
        body: {
          generation: launch.generation,
          commandEpoch: launch.commandEpoch,
          commands: [{ name: "status", description: "Show status", source: "extension" }],
        },
      });
      expect(
        await post(api.port, `/_pi/api/v1/sessions/${launch.launchId}/command`, command),
      ).toEqual({
        status: 200,
        body: {
          version: 1,
          type: "command-response",
          commandId: "browser-command",
          generation: launch.generation,
          commandEpoch: launch.commandEpoch,
          accepted: true,
        },
      });
      await post(api.port, `/_pi/api/v1/sessions/${launch.launchId}/command`, command);
      expect(calls).toBe(1);
      const rejected = await post(api.port, `/_pi/api/v1/sessions/${launch.launchId}/command`, {
        ...command,
        commandId: "rejected",
      });
      expect(rejected.status).toBe(200);
      expect(Check(CommandResponseEnvelopeSchema, rejected.body)).toBe(true);
      const ambiguous = await post(api.port, `/_pi/api/v1/sessions/${launch.launchId}/command`, {
        ...command,
        commandId: "ambiguous",
      });
      expect(ambiguous.status).toBe(409);
      expect(Check(ErrorEnvelopeSchema, ambiguous.body)).toBe(true);
      const modelControl = await post(api.port, `/_pi/api/v1/sessions/${launch.launchId}/command`, {
        version: 1,
        type: "set-thinking",
        commandId: "thinking-max",
        generation: launch.generation,
        commandEpoch: launch.commandEpoch,
        thinkingLevel: "max",
      });
      expect(modelControl.status).toBe(200);
      expect(modelControl.body).toMatchObject({
        type: "command-response",
        commandId: "thinking-max",
        accepted: true,
      });
      expect(Check(ModelControlResponseEnvelopeSchema, modelControl.body)).toBe(true);
      const rejectedModelControl = await post(
        api.port,
        `/_pi/api/v1/sessions/${launch.launchId}/command`,
        {
          version: 1,
          type: "set-model",
          commandId: "rejected-model",
          generation: launch.generation,
          commandEpoch: launch.commandEpoch,
          provider: "provider",
          modelId: "missing",
        },
      );
      expect(rejectedModelControl.status).toBe(200);
      expect(Check(ModelControlResponseEnvelopeSchema, rejectedModelControl.body)).toBe(true);
      expect(rejectedModelControl.body).toMatchObject({ accepted: false, reason: "invalid" });
      for (const [code, reason] of [
        ["capability_off", "capability-off"],
        ["host_not_ready", "session-changed"],
        ["admission_queue_full", "queue-busy"],
        ["invalid_control", "invalid"],
      ] as const) {
        const rejectedControl = await post(
          api.port,
          `/_pi/api/v1/sessions/${launch.launchId}/command`,
          {
            version: 1,
            type: "set-thinking",
            commandId: `rejected-${code}`,
            generation: launch.generation,
            commandEpoch: launch.commandEpoch,
            thinkingLevel: "max",
          },
        );
        expect(Check(ModelControlResponseEnvelopeSchema, rejectedControl.body)).toBe(true);
        expect(rejectedControl.body).toMatchObject({ accepted: false, reason });
      }
      const ambiguousModelControl = await post(
        api.port,
        `/_pi/api/v1/sessions/${launch.launchId}/command`,
        {
          version: 1,
          type: "set-model",
          commandId: "ambiguous-model",
          generation: launch.generation,
          commandEpoch: launch.commandEpoch,
          provider: "provider",
          modelId: "model",
        },
      );
      expect(ambiguousModelControl.status).toBe(409);
      expect(Check(ErrorEnvelopeSchema, ambiguousModelControl.body)).toBe(true);
      const control = await post(api.port, `/_pi/api/v1/sessions/${launch.launchId}/command`, {
        version: 1,
        type: "control",
        control: "abort",
        commandId: "abort",
        generation: launch.generation,
        commandEpoch: launch.commandEpoch,
      });
      expect(control).toMatchObject({
        status: 200,
        body: { admission: { status: "accepted", commandId: "abort" } },
      });
      expect(
        await post(api.port, `/_pi/api/v1/sessions/${launch.launchId}/command`, {
          ...command,
          unexpected: true,
        }),
      ).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    } finally {
      await api.close();
      await registry.stopAll();
    }
  });
});
