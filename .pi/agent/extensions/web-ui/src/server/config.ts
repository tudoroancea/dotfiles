export interface WebUiConfig {
  host: string;
  port: number;
  remoteUrl?: URL;
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PI_WEB_UI_PORT must be an integer between 0 and 65535");
  }
  return port;
}

function parseRemoteUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PI_WEB_UI_REMOTE_URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("PI_WEB_UI_REMOTE_URL cannot contain credentials, a query, or a fragment");
  }
  if (url.pathname !== "/") {
    throw new Error("PI_WEB_UI_REMOTE_URL must use the origin root path");
  }
  url.pathname = "/";
  return url;
}

export function readWebUiConfig(env: NodeJS.ProcessEnv = process.env): WebUiConfig {
  const remoteUrl = parseRemoteUrl(env.PI_WEB_UI_REMOTE_URL);
  return {
    host: env.PI_WEB_UI_HOST || "127.0.0.1",
    port: parsePort(env.PI_WEB_UI_PORT),
    ...(remoteUrl ? { remoteUrl } : {}),
  };
}
