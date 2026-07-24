import { describe, expect, it } from "vitest";
import { readWebUiConfig } from "../src/server/config.js";

describe("web UI configuration", () => {
  it("defaults to an ephemeral loopback listener", () => {
    expect(readWebUiConfig({})).toEqual({ host: "127.0.0.1", port: 0 });
  });

  it("accepts only root HTTP(S) remote URLs without URL credentials", () => {
    expect(readWebUiConfig({ PI_WEB_UI_REMOTE_URL: "https://pi.example/" }).remoteUrl?.href).toBe(
      "https://pi.example/",
    );
    for (const value of [
      "https://pi.example/prefix/",
      "https://user:password@pi.example/",
      "https://pi.example/?token=x",
      "file:///tmp/pi",
    ]) {
      expect(() => readWebUiConfig({ PI_WEB_UI_REMOTE_URL: value })).toThrow();
    }
  });
});
