import { isAbsolute, normalize } from "node:path";

export const SUPPORTED_PI_VERSION = "0.86.1" as const;
export const MANAGED_EXTENSION_PATHS = [
  "agent/extensions/agentflow/src/index.ts",
  "agent/extensions/background-processes/src/index.ts",
] as const;
export const DAEMON_ROLES = ["viewer", "controller", "launcher", "operator"] as const;

export type DaemonRole = (typeof DAEMON_ROLES)[number];
export interface ApprovedRootConfig {
  alias: string;
  path: string;
}
export interface RoleMappingConfig {
  principal: string;
  roles: DaemonRole[];
}
export interface DaemonLimits {
  loadedHosts: number;
  totalLaunches: number;
  memoryBytes: number;
  queueCount: number;
  queueBytes: number;
  historyConcurrentLoads: number;
  historyPageEntries: number;
  historyPageBytes: number;
  rateWindowMs: number;
  rateLaunches: number;
  rateMutations: number;
  discoveryCandidates: number;
  discoveryConcurrency: number;
  discoveryTimeoutMs: number;
  discoveryBodyBytes: number;
  discoveryCacheMs: number;
  idleUnloadMs: number;
}
export interface DaemonConfig {
  listener: { host: "127.0.0.1" | "::1"; port: number };
  approvedRoots: ApprovedRootConfig[];
  trustedProjects: string[];
  roleMappings: RoleMappingConfig[];
  piVersion: typeof SUPPORTED_PI_VERSION;
  managedExtensionPaths: [string, string];
  limits: DaemonLimits;
  persistencePath: string;
  tailscaleVersions: { minimum: string; maximumExclusive: string };
}

export const DEFAULT_LIMITS: Readonly<DaemonLimits> = Object.freeze({
  loadedHosts: 4,
  totalLaunches: 256,
  memoryBytes: 1024 * 1024 * 1024,
  queueCount: 32,
  queueBytes: 1024 * 1024,
  historyConcurrentLoads: 2,
  historyPageEntries: 100,
  historyPageBytes: 1024 * 1024,
  rateWindowMs: 60_000,
  rateLaunches: 10,
  rateMutations: 120,
  discoveryCandidates: 256,
  discoveryConcurrency: 8,
  discoveryTimeoutMs: 3_000,
  discoveryBodyBytes: 4 * 1024,
  discoveryCacheMs: 15_000,
  idleUnloadMs: 15 * 60_000,
});

const LIMIT_RANGES: Record<keyof DaemonLimits, readonly [number, number]> = {
  loadedHosts: [1, 32],
  totalLaunches: [1, 256],
  memoryBytes: [128 * 1024 * 1024, 16 * 1024 * 1024 * 1024],
  queueCount: [1, 256],
  queueBytes: [1024, 16 * 1024 * 1024],
  historyConcurrentLoads: [1, 8],
  historyPageEntries: [1, 100],
  historyPageBytes: [1024, 1024 * 1024],
  rateWindowMs: [1000, 60 * 60_000],
  rateLaunches: [1, 100],
  rateMutations: [1, 1000],
  discoveryCandidates: [1, 256],
  discoveryConcurrency: [1, 8],
  discoveryTimeoutMs: [250, 10_000],
  discoveryBodyBytes: [256, 4 * 1024],
  discoveryCacheMs: [1000, 60_000],
  idleUnloadMs: [10_000, 24 * 60 * 60_000],
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new TypeError(`${label} has unknown field: ${extra[0]}`);
}
function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0)
    throw new TypeError(`${label} must be a non-empty trimmed string`);
  return value;
}
function boundedInteger(value: unknown, label: string, range: readonly [number, number]): number {
  if (!Number.isSafeInteger(value) || (value as number) < range[0] || (value as number) > range[1])
    throw new RangeError(`${label} must be an integer from ${range[0]} to ${range[1]}`);
  return value as number;
}
function version(value: unknown, label: string): string {
  const result = nonempty(value, label);
  if (!/^\d+\.\d+\.\d+$/.test(result)) throw new TypeError(`${label} must be a semantic version`);
  return result;
}

export function validateDaemonConfig(input: unknown): DaemonConfig {
  const root = object(input, "config");
  keys(
    root,
    [
      "listener",
      "approvedRoots",
      "trustedProjects",
      "roleMappings",
      "piVersion",
      "managedExtensionPaths",
      "limits",
      "persistencePath",
      "tailscaleVersions",
    ],
    "config",
  );
  const listener = object(root.listener ?? {}, "listener");
  keys(listener, ["host", "port"], "listener");
  const host = listener.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new TypeError("listener.host must be loopback");
  const port = boundedInteger(listener.port ?? 7331, "listener.port", [1, 65_535]);

  if (!Array.isArray(root.approvedRoots) || root.approvedRoots.length === 0)
    throw new TypeError("approvedRoots must contain at least one root");
  if (root.approvedRoots.length > 64) throw new RangeError("approvedRoots exceeds 64 roots");
  const aliases = new Set<string>();
  const approvedRoots = root.approvedRoots.map((entry, index) => {
    const item = object(entry, `approvedRoots[${index}]`);
    keys(item, ["alias", "path"], `approvedRoots[${index}]`);
    const alias = nonempty(item.alias, `approvedRoots[${index}].alias`);
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(alias) || aliases.has(alias))
      throw new TypeError(`approvedRoots[${index}].alias is invalid or duplicated`);
    aliases.add(alias);
    const path = normalize(nonempty(item.path, `approvedRoots[${index}].path`));
    if (!isAbsolute(path)) throw new TypeError(`approvedRoots[${index}].path must be absolute`);
    return { alias, path };
  });

  if (!Array.isArray(root.trustedProjects)) throw new TypeError("trustedProjects must be an array");
  if (root.trustedProjects.length > 256) throw new RangeError("trustedProjects exceeds 256 paths");
  const trustedProjects = [
    ...new Set(
      root.trustedProjects.map((entry, index) => {
        const path = normalize(nonempty(entry, `trustedProjects[${index}]`));
        if (!isAbsolute(path)) throw new TypeError(`trustedProjects[${index}] must be absolute`);
        return path;
      }),
    ),
  ];

  if (!Array.isArray(root.roleMappings)) throw new TypeError("roleMappings must be an array");
  if (root.roleMappings.length > 256) throw new RangeError("roleMappings exceeds 256 mappings");
  const principals = new Set<string>();
  const roleMappings = root.roleMappings.map((entry, index) => {
    const item = object(entry, `roleMappings[${index}]`);
    keys(item, ["principal", "roles"], `roleMappings[${index}]`);
    const principal = nonempty(item.principal, `roleMappings[${index}].principal`).toLowerCase();
    if (principals.has(principal)) throw new TypeError(`duplicate principal: ${principal}`);
    principals.add(principal);
    if (!Array.isArray(item.roles) || item.roles.length === 0)
      throw new TypeError(`roleMappings[${index}].roles must not be empty`);
    const roles = [
      ...new Set(
        item.roles.map((role) => {
          if (!DAEMON_ROLES.includes(role as DaemonRole))
            throw new TypeError(`unknown role: ${String(role)}`);
          return role as DaemonRole;
        }),
      ),
    ];
    return { principal, roles };
  });

  if ((root.piVersion ?? SUPPORTED_PI_VERSION) !== SUPPORTED_PI_VERSION)
    throw new TypeError(`piVersion must be ${SUPPORTED_PI_VERSION}`);
  const paths = root.managedExtensionPaths ?? [...MANAGED_EXTENSION_PATHS];
  if (
    !Array.isArray(paths) ||
    paths.length !== 2 ||
    paths.some((path, index) => path !== MANAGED_EXTENSION_PATHS[index])
  )
    throw new TypeError("managedExtensionPaths must exactly match the audited profile");

  const limitsInput = object(root.limits ?? {}, "limits");
  keys(limitsInput, Object.keys(DEFAULT_LIMITS), "limits");
  const limits = Object.fromEntries(
    Object.entries(DEFAULT_LIMITS).map(([name, fallback]) => {
      const key = name as keyof DaemonLimits;
      return [
        key,
        boundedInteger(limitsInput[key] ?? fallback, `limits.${key}`, LIMIT_RANGES[key]),
      ];
    }),
  ) as unknown as DaemonLimits;

  const persistencePath = normalize(nonempty(root.persistencePath, "persistencePath"));
  if (!isAbsolute(persistencePath)) throw new TypeError("persistencePath must be absolute");
  const tailscale = object(root.tailscaleVersions, "tailscaleVersions");
  keys(tailscale, ["minimum", "maximumExclusive"], "tailscaleVersions");
  const minimum = version(tailscale.minimum, "tailscaleVersions.minimum");
  const maximumExclusive = version(
    tailscale.maximumExclusive,
    "tailscaleVersions.maximumExclusive",
  );
  if (minimum.localeCompare(maximumExclusive, undefined, { numeric: true }) >= 0)
    throw new RangeError("tailscaleVersions minimum must precede maximumExclusive");

  return {
    listener: { host, port },
    approvedRoots,
    trustedProjects,
    roleMappings,
    piVersion: SUPPORTED_PI_VERSION,
    managedExtensionPaths: [...MANAGED_EXTENSION_PATHS],
    limits,
    persistencePath,
    tailscaleVersions: { minimum, maximumExclusive },
  };
}
