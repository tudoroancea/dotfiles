# Tailscale ingress feasibility

## Status and release gate

Phase 0C supplies a bounded `tailscale status --json` parser, network-free fixtures, and an opt-in real-environment spike. Fixtures do **not** establish a trusted ingress. Real Tailscale/Serve evidence is environment-specific and unavailable in automated tests.

If Tailscale, a suitable tailnet identity, a manually configured Serve route, or a genuine Serve client path is unavailable, status is **unavailable**, not passed. Production remote serving and every remote mutation remain gated until the spike reports `verified` over the actual Serve path for each supported platform/version and required identity class. These artifacts implement no authentication, authorization, or remote mutation.

## Initial single-user loopback trust limitation

The planned daemon listener is loopback-only and Serve forwards identity in HTTP headers. This is only a **single-user local-host trust assumption**. Loopback is not an authentication boundary: loopback peers can forge forwarded Tailscale identity headers. Another process, or another local user where host policy permits access, can directly submit fake headers.

Direct loopback access therefore must not be treated as remotely authenticated. Multi-user hosts require a separately verified non-spoofable ingress boundary. Remote serving remains gated without evidence that spoofed headers are stripped or replaced on the **actual Serve path**; a local mock is insufficient.

## Bounded status parsing

`src/discovery/tailscale-status.ts` reads only `MagicDNSSuffix` (or the tolerated `CurrentTailnet.MagicDNSSuffix` variant), `Self.DNSName`, and peer `DNSName` values from map or array `Peer` forms. Unknown/missing fields are ignored. Input defaults to 1 MiB and output to 256 unique peer candidates.

Candidates must be lower-case, label-valid, fully qualified `DNSName` values ending in a DNS root dot and belonging to the reported MagicDNS suffix. Returned hostnames omit that root dot. Status names are discovery candidates, not reachability or identity evidence. Offline fixture tests cover supported variants, missing/unknown fields, malformed and oversized input, noncanonical/duplicate names, and excessive peers without network access.

## Opt-in real Serve spike

The script starts a temporary probe on `127.0.0.1` and requests it through an already configured HTTPS Serve origin. It never invokes `tailscale serve`, edits Serve state, or modifies machine configuration. The operator must manually configure and remove any route.

1. Select an unused loopback port.
2. Manually configure the whole supplied MagicDNS origin to proxy to that port.
3. Run from a path that genuinely traverses Serve; direct loopback is invalid.
4. Repeat for supported Tailscale versions and applicable user/tagged/shared identity classes. One run establishes only its tested path and identity class.

```sh
TAILSCALE_INGRESS_SPIKE=1 node \
  apps/remote-session-daemon/scripts/tailscale-ingress-spike.mjs \
  --url https://machine.example-tailnet.ts.net \
  --listen-port 43127 \
  --minimum-version 1.70.0 \
  --maximum-exclusive-version 2.0.0 \
  --evidence /tmp/tailscale-ingress-evidence.json
```

The URL must be an HTTPS origin without a path. The audited minimum (inclusive) and maximum (exclusive) semantic Tailscale versions are mandatory. The installed version from `tailscale version --json` is recorded and a run outside that range cannot report `verified`. The evidence path must not already exist; the spike creates it without following symlinks, exclusively, at mode `0600`. Evidence is bounded to 64 KiB and records header presence rather than identity values. Do not commit environment evidence; it still includes hostname, version, and timing information.

The spike checks:

- exact agreement between URL hostname and `Self.DNSName` from bounded `tailscale status --json` output;
- the exact browser-style Origin observed by the backend;
- presence of a non-forged Serve login identity header;
- stripping or replacement of forged `Tailscale-User-*` copies;
- initial Server-Sent Events (SSE) chunk arrival before the backend records close and within a heartbeat-derived threshold, heartbeat comments during an otherwise idle stream, and reconnect delivery with `Last-Event-ID`.

All checks must pass for `verified`. Missing `tailscale`, DNS/Serve access, identity headers, or any incomplete/failed observation yields `unavailable-or-failed` and leaves the gate closed. Preserve dated external evidence with OS, Tailscale version, Serve route description, and identity class.

## Interpretation limits

Identity forwarding is not authorization. Origin evidence does not implement enforcement. Streaming timings characterize one route, heartbeat interval, and network condition. Comparing the client's first chunk timestamp with the backend close timestamp prevents a response buffered until close from being accepted merely because the reader ran longer. Future discovery must still use fixed HTTPS presence paths, TLS validation, disabled redirects, and bounded probes. Network-free tests cannot replace actual Serve-path verification.
