import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTailscaleStatusJson } from "../../src/discovery/tailscale-status.ts";

const fixture = (name: string) =>
  readFile(fileURLToPath(new URL(`../fixtures/tailscale/${name}`, import.meta.url)), "utf8");

describe("parseTailscaleStatusJson", () => {
  it("extracts canonical names from the peer-map shape", async () => {
    expect(parseTailscaleStatusJson(await fixture("status-map.json"))).toEqual({
      selfMagicDnsName: "laptop.example-tailnet.ts.net",
      candidateMagicDnsNames: ["desktop.example-tailnet.ts.net", "server.example-tailnet.ts.net"],
      candidatesTruncated: false,
    });
  });

  it("supports peer-array/current-tailnet and ignores unknown or noncanonical data", async () => {
    expect(parseTailscaleStatusJson(await fixture("status-array-current-tailnet.json"))).toEqual({
      selfMagicDnsName: "laptop.example-tailnet.ts.net",
      candidateMagicDnsNames: ["phone.example-tailnet.ts.net"],
      candidatesTruncated: false,
    });
  });

  it("tolerates missing and unknown fields", () => {
    expect(parseTailscaleStatusJson('{"Future":{"shape":true}}')).toEqual({
      candidateMagicDnsNames: [],
      candidatesTruncated: false,
    });
    expect(parseTailscaleStatusJson("null")).toEqual({
      candidateMagicDnsNames: [],
      candidatesTruncated: false,
    });
  });

  it("rejects malformed and oversized fixture input", async () => {
    const malformed = await fixture("malformed.txt");
    expect(() => parseTailscaleStatusJson(malformed)).toThrowError(
      expect.objectContaining({ code: "malformed-json" }),
    );
    expect(() => parseTailscaleStatusJson("12345", { maxInputBytes: 4 })).toThrowError(
      expect.objectContaining({ code: "input-too-large" }),
    );
  });

  it("caps excessive peers", () => {
    const Peer = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [
        `key:${index}`,
        { DNSName: `peer-${index}.example-tailnet.ts.net.` },
      ]),
    );
    const parsed = parseTailscaleStatusJson(
      JSON.stringify({ MagicDNSSuffix: "example-tailnet.ts.net", Peer }),
    );
    expect(parsed.candidateMagicDnsNames).toHaveLength(256);
    expect(parsed.candidatesTruncated).toBe(true);
  });

  it("honors a smaller candidate bound", () => {
    const status = JSON.stringify({
      MagicDNSSuffix: "example-tailnet.ts.net",
      Peer: [
        { DNSName: "one.example-tailnet.ts.net." },
        { DNSName: "two.example-tailnet.ts.net." },
      ],
    });
    expect(parseTailscaleStatusJson(status, { maxCandidates: 1 })).toMatchObject({
      candidateMagicDnsNames: ["one.example-tailnet.ts.net"],
      candidatesTruncated: true,
    });
  });
});
