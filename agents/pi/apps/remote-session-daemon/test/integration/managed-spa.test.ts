import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { startLocalApi } from "../../src/api/server.ts";
import { LocalLaunches } from "../../src/host/launches.ts";
import { LaunchRegistry } from "../../src/host/registry.ts";

function call(
  port: number,
  path: string,
  method = "GET",
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { host: `127.0.0.1:${port}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject).end();
  });
}

function createLaunches(): LocalLaunches {
  return new LocalLaunches(
    new LaunchRegistry({
      capacity: 1,
      hostFactory: async () => {
        throw new Error("unused");
      },
    }),
    [{ alias: "work", path: "/tmp" }],
    { isTrusted: () => true },
  );
}

describe("managed SPA", () => {
  it("serves the app root, direct session links, and exact static assets", async () => {
    const api = await startLocalApi({
      config: { listener: { host: "127.0.0.1", port: 0 } },
      launches: createLaunches(),
    });
    try {
      const redirect = await call(api.port, "/_pi");
      expect(redirect.status).toBe(308);
      expect(redirect.headers.location).toBe("/_pi/");

      for (const path of ["/_pi/", "/_pi/sessions/launch_123"]) {
        const response = await call(api.port, path);
        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toContain("text/html");
        expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["referrer-policy"]).toBe("no-referrer");
        expect(response.body).toContain('id="managed-root"');
        expect(response.body).toContain("/_pi/assets/app.js");
      }

      const script = await call(api.port, "/_pi/assets/app.js");
      expect(script.status).toBe(200);
      expect(script.headers["content-type"]).toContain("text/javascript");
      expect(script.headers["cross-origin-resource-policy"]).toBe("same-origin");
      expect(script.body.length).toBeGreaterThan(1000);

      const stylesheet = await call(api.port, "/_pi/assets/index.css");
      expect(stylesheet.status).toBe(200);
      expect(stylesheet.headers["content-type"]).toContain("text/css");
    } finally {
      await api.close();
    }
  });

  it("does not turn malformed routes, missing assets, or API misses into HTML", async () => {
    const api = await startLocalApi({
      config: { listener: { host: "127.0.0.1", port: 0 } },
      launches: createLaunches(),
    });
    try {
      for (const path of [
        "/_pi/sessions/invalid$id",
        "/_pi/sessions/good/extra",
        "/_pi/assets/missing.js",
        "/_pi/assets/../index.html",
        "/_pi/api/v1/missing",
      ]) {
        const response = await call(api.port, path);
        expect(response.status).toBe(404);
        expect(response.headers["content-type"]).toContain("application/json");
        expect(response.body).not.toContain("managed-root");
      }
      expect((await call(api.port, "/_pi/?x=1")).status).toBe(400);
      expect((await call(api.port, "/_pi/assets/app.js?x=1")).status).toBe(400);
      expect((await call(api.port, "/_pi/", "POST")).status).toBe(405);
    } finally {
      await api.close();
    }
  });
});
