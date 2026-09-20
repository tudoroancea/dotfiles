import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMITS,
  MANAGED_EXTENSION_PATHS,
  validateDaemonConfig,
} from "../../src/config/index.ts";

const valid = () => ({
  approvedRoots: [{ alias: "work", path: "/tmp/work" }],
  trustedProjects: ["/tmp/work/project"],
  roleMappings: [{ principal: "User@Example.COM", roles: ["viewer", "controller"] }],
  persistencePath: "/tmp/daemon-state.json",
  tailscaleVersions: { minimum: "1.70.0", maximumExclusive: "2.0.0" },
});

describe("daemon configuration", () => {
  it("applies bounded safe defaults and normalizes principals", () => {
    const config = validateDaemonConfig(valid());
    expect(config.listener).toEqual({ host: "127.0.0.1", port: 7331 });
    expect(config.limits).toEqual(DEFAULT_LIMITS);
    expect(config.piVersion).toBe("0.86.1");
    expect(config.managedExtensionPaths).toEqual(MANAGED_EXTENSION_PATHS);
    expect(config.roleMappings[0]?.principal).toBe("user@example.com");
  });
  it.each(["0.0.0.0", "::", "localhost", "192.168.1.2"])("rejects non-loopback host %s", (host) => {
    expect(() => validateDaemonConfig({ ...valid(), listener: { host, port: 7331 } })).toThrow(
      /loopback/,
    );
  });
  it("requires unique absolute approved roots and valid roles", () => {
    expect(() =>
      validateDaemonConfig({ ...valid(), approvedRoots: [{ alias: "work", path: "relative" }] }),
    ).toThrow(/absolute/);
    expect(() =>
      validateDaemonConfig({
        ...valid(),
        approvedRoots: [
          { alias: "work", path: "/a" },
          { alias: "work", path: "/b" },
        ],
      }),
    ).toThrow(/duplicated/);
    expect(() =>
      validateDaemonConfig({ ...valid(), roleMappings: [{ principal: "u", roles: ["admin"] }] }),
    ).toThrow(/unknown role/);
  });
  it("requires the exact SDK version and managed extension profile", () => {
    expect(() => validateDaemonConfig({ ...valid(), piVersion: "0.82.1" })).toThrow(/0\.86\.1/);
    expect(() =>
      validateDaemonConfig({
        ...valid(),
        managedExtensionPaths: [...MANAGED_EXTENSION_PATHS].reverse(),
      }),
    ).toThrow(/exactly/);
  });
  it.each([
    ["loadedHosts", 0],
    ["totalLaunches", 0],
    ["memoryBytes", 1],
    ["queueCount", 257],
    ["queueBytes", 17 * 1024 * 1024],
    ["historyConcurrentLoads", 9],
    ["historyPageEntries", 101],
    ["historyPageBytes", 1024 * 1024 + 1],
    ["rateWindowMs", 999],
    ["rateLaunches", 101],
    ["rateMutations", 1001],
    ["discoveryCandidates", 257],
    ["discoveryConcurrency", 9],
    ["discoveryTimeoutMs", 10_001],
    ["discoveryBodyBytes", 4097],
    ["discoveryCacheMs", 999],
    ["idleUnloadMs", 9999],
  ] as const)("bounds %s", (name, value) => {
    expect(() => validateDaemonConfig({ ...valid(), limits: { [name]: value } })).toThrow();
  });
  it("rejects relative persistence and invalid Tailscale ranges", () => {
    expect(() => validateDaemonConfig({ ...valid(), persistencePath: "state.json" })).toThrow(
      /absolute/,
    );
    expect(() =>
      validateDaemonConfig({
        ...valid(),
        tailscaleVersions: { minimum: "2.0.0", maximumExclusive: "1.70.0" },
      }),
    ).toThrow(/precede/);
  });
});
