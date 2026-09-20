import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { startLocalApi } from "../../src/api/server.ts";
import { LocalLaunches } from "../../src/host/launches.ts";
import { LaunchRegistry } from "../../src/host/registry.ts";

function call(
  port: number,
  options: { method?: string; host?: string; origin?: string; type?: string; body?: string },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/_pi/api/v1/sessions",
        method: options.method ?? "POST",
        headers: {
          host: options.host ?? `127.0.0.1:${port}`,
          ...(options.origin ? { origin: options.origin } : {}),
          ...(options.type ? { "content-type": options.type } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      },
    );
    req.on("error", reject).end(options.body);
  });
}

describe("local API security", () => {
  it("rejects unsafe hosts, origins, media types, oversized bodies, fields, and methods", async () => {
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
    });
    try {
      expect(
        await call(api.port, { host: "evil.example", type: "application/json", body: "{}" }),
      ).toBe(400);
      expect(
        await call(api.port, {
          origin: "http://evil.example",
          type: "application/json",
          body: "{}",
        }),
      ).toBe(403);
      expect(await call(api.port, { type: "text/plain", body: "{}" })).toBe(400);
      expect(await call(api.port, { type: "application/json", body: "x".repeat(300 * 1024) })).toBe(
        413,
      );
      expect(
        await call(api.port, {
          type: "application/json",
          body: JSON.stringify({ rootAlias: "work", relativePath: ".", extra: true }),
        }),
      ).toBe(400);
      expect(await call(api.port, { method: "PUT" })).toBe(405);
    } finally {
      await api.close();
    }
  });
});
