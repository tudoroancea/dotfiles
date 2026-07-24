export type AuthenticationMode = "standalone";

export interface FramingPolicy {
  frameAncestors: readonly string[];
}

export interface WebUiConfig {
  bindHost: string;
  port: number;
  publicUrl?: URL;
  basePath: string;
  authenticationMode: AuthenticationMode;
  allowedOrigins: ReadonlySet<string>;
  framing: FramingPolicy;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PI_WEB_UI_PORT must be an integer between 0 and 65535");
  }
  return port;
}

export function normalizeBasePath(value: string | undefined): string {
  if (!value || value === "/") return "/";
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) {
    throw new Error("PI_WEB_UI_BASE_PATH must be an absolute URL path");
  }
  const segments = value.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("PI_WEB_UI_BASE_PATH cannot contain dot segments");
  }
  return `/${segments.join("/")}/`;
}

function parsePublicUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PI_WEB_UI_PUBLIC_URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("PI_WEB_UI_PUBLIC_URL cannot contain credentials, a query, or a fragment");
  }
  return url;
}

function parseOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(",").map((item) => {
    const url = new URL(item.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.origin !== item.trim() ||
      url.hostname.includes("*")
    ) {
      throw new Error("PI_WEB_UI_ALLOWED_ORIGINS must contain exact HTTP(S) origins");
    }
    return url.origin;
  });
}

export function readWebUiConfig(env: NodeJS.ProcessEnv = process.env): WebUiConfig {
  const configuredPublicUrl = parsePublicUrl(env.PI_WEB_UI_PUBLIC_URL ?? env.PI_WEB_UI_REMOTE_URL);
  const configuredBasePath = env.PI_WEB_UI_BASE_PATH
    ? normalizeBasePath(env.PI_WEB_UI_BASE_PATH)
    : undefined;
  const publicBasePath = configuredPublicUrl
    ? normalizeBasePath(configuredPublicUrl.pathname)
    : undefined;
  if (configuredBasePath && publicBasePath && configuredBasePath !== publicBasePath) {
    throw new Error("PI_WEB_UI_BASE_PATH must match the path in PI_WEB_UI_PUBLIC_URL");
  }
  const basePath = configuredBasePath ?? publicBasePath ?? "/";
  const publicUrl = configuredPublicUrl ? new URL(basePath, configuredPublicUrl.origin) : undefined;
  const explicitOrigins = parseOrigins(env.PI_WEB_UI_ALLOWED_ORIGINS);
  const origins = new Set(explicitOrigins);
  if (publicUrl) origins.add(publicUrl.origin);

  return {
    bindHost: env.PI_WEB_UI_HOST || "127.0.0.1",
    port: parsePort(env.PI_WEB_UI_PORT),
    ...(publicUrl ? { publicUrl } : {}),
    basePath,
    authenticationMode: "standalone",
    allowedOrigins: origins,
    framing: { frameAncestors: ["'none'"] },
  };
}
