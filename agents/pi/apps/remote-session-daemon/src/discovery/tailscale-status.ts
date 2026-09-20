const DEFAULT_MAX_STATUS_BYTES = 1024 * 1024;
const DEFAULT_MAX_CANDIDATES = 256;
const MAX_DNS_NAME_LENGTH = 253;

export interface TailscaleStatusParseOptions {
  maxInputBytes?: number;
  maxCandidates?: number;
}

export interface TailscaleStatusDiscovery {
  selfMagicDnsName?: string;
  candidateMagicDnsNames: string[];
  candidatesTruncated: boolean;
}

export class TailscaleStatusParseError extends Error {
  readonly code: "input-too-large" | "malformed-json";

  constructor(code: "input-too-large" | "malformed-json", message: string) {
    super(message);
    this.name = "TailscaleStatusParseError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bound(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value >= 0 ? value : fallback;
}

function isCanonicalDnsName(value: string): boolean {
  if (!value || value.length > MAX_DNS_NAME_LENGTH || value !== value.toLowerCase()) return false;
  const labels = value.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  );
}

function canonicalSuffix(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const suffix = value.endsWith(".") ? value.slice(0, -1) : value;
  return isCanonicalDnsName(suffix) ? suffix : undefined;
}

function magicDnsName(value: unknown, suffix: string | undefined): string | undefined {
  if (typeof value !== "string" || suffix === undefined || !value.endsWith(".")) return undefined;
  const name = value.slice(0, -1);
  if (!isCanonicalDnsName(name) || name === suffix || !name.endsWith(`.${suffix}`))
    return undefined;
  return name;
}

function nodeName(value: unknown, suffix: string | undefined): string | undefined {
  return isRecord(value) ? magicDnsName(value.DNSName, suffix) : undefined;
}

/** Parse only bounded, non-authoritative fields needed for later discovery probes. */
export function parseTailscaleStatusJson(
  input: string | Uint8Array,
  options: TailscaleStatusParseOptions = {},
): TailscaleStatusDiscovery {
  const maxInputBytes = bound(options.maxInputBytes, DEFAULT_MAX_STATUS_BYTES);
  const maxCandidates = bound(options.maxCandidates, DEFAULT_MAX_CANDIDATES);
  const bytes = typeof input === "string" ? Buffer.byteLength(input) : input.byteLength;
  if (bytes > maxInputBytes) {
    throw new TailscaleStatusParseError(
      "input-too-large",
      `tailscale status JSON exceeds ${maxInputBytes} bytes`,
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(typeof input === "string" ? input : new TextDecoder().decode(input));
  } catch {
    throw new TailscaleStatusParseError(
      "malformed-json",
      "tailscale status returned malformed JSON",
    );
  }
  if (!isRecord(decoded)) return { candidateMagicDnsNames: [], candidatesTruncated: false };

  const currentTailnet = isRecord(decoded.CurrentTailnet) ? decoded.CurrentTailnet : undefined;
  const suffix =
    canonicalSuffix(decoded.MagicDNSSuffix) ?? canonicalSuffix(currentTailnet?.MagicDNSSuffix);
  const selfMagicDnsName = nodeName(decoded.Self, suffix);
  const peers = Array.isArray(decoded.Peer)
    ? decoded.Peer
    : isRecord(decoded.Peer)
      ? Object.values(decoded.Peer)
      : [];
  const candidateMagicDnsNames: string[] = [];
  const seen = new Set<string>();
  let candidatesTruncated = false;
  for (const peer of peers) {
    const name = nodeName(peer, suffix);
    if (name === undefined || name === selfMagicDnsName || seen.has(name)) continue;
    if (candidateMagicDnsNames.length === maxCandidates) {
      candidatesTruncated = true;
      break;
    }
    seen.add(name);
    candidateMagicDnsNames.push(name);
  }
  return {
    ...(selfMagicDnsName === undefined ? {} : { selfMagicDnsName }),
    candidateMagicDnsNames,
    candidatesTruncated,
  };
}
