import { describe, expect, it } from "vitest";
import { readWebUiConfig } from "../src/server/config.js";
import { listenerOrigin } from "../src/server/server.js";

describe("web UI configuration", () => {
  it("centralizes standalone loopback defaults", () => {
    const config = readWebUiConfig({});
    expect(config).toMatchObject({
      bindHost: "127.0.0.1",
      port: 0,
      basePath: "/",
      authenticationMode: "standalone",
      framing: { frameAncestors: ["'none'"] },
    });
    expect(config.allowedOrigins.size).toBe(0);
  });

  it("derives a base path and exact origin from the public URL", () => {
    const config = readWebUiConfig({
      PI_WEB_UI_PUBLIC_URL: "https://pi.example/_pi/s/launch-id/",
    });
    expect(config.publicUrl?.href).toBe("https://pi.example/_pi/s/launch-id/");
    expect(config.basePath).toBe("/_pi/s/launch-id/");
    expect([...config.allowedOrigins]).toEqual(["https://pi.example"]);
  });

  it("preserves concrete listener hosts and maps only wildcard listeners to loopback", () => {
    expect(listenerOrigin("192.168.1.20", 4321).href).toBe("http://192.168.1.20:4321/");
    expect(listenerOrigin("fd00::1234", 4321).href).toBe("http://[fd00::1234]:4321/");
    expect(listenerOrigin("0.0.0.0", 4321).href).toBe("http://127.0.0.1:4321/");
    expect(listenerOrigin("::", 4321).href).toBe("http://[::1]:4321/");
  });

  it("rejects mismatched paths, URL credentials, wildcard origins, and non-HTTP URLs", () => {
    const invalidEnvironments = [
      {
        PI_WEB_UI_PUBLIC_URL: "https://pi.example/a/",
        PI_WEB_UI_BASE_PATH: "/b/",
      },
      { PI_WEB_UI_PUBLIC_URL: "https://user:password@pi.example/" },
      { PI_WEB_UI_PUBLIC_URL: "https://pi.example/?token=x" },
      { PI_WEB_UI_PUBLIC_URL: "file:///tmp/pi" },
      { PI_WEB_UI_ALLOWED_ORIGINS: "https://*.ts.net" },
    ];
    for (const environment of invalidEnvironments) {
      expect(() => readWebUiConfig(environment)).toThrow();
    }
  });
});
