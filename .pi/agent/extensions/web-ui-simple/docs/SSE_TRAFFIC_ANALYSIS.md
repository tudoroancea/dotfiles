# SSE full-snapshot traffic analysis

Date: 2026-07-26

## Summary

The current full-snapshot design is simple and robust, but it stops being cheap for a large, actively streaming session. On the representative session below, the active branch alone produces an approximately **5.01 MB SSE frame** near the end. Sending that frame every 500 ms is about **10.0 MB/s (80 Mbps) per connected client** before HTTP/TCP overhead.

A replay model with one full snapshot for each persisted entry transfers **4.17 GB**, while sending every persisted entry once would transfer only **5.95 MB** of entry JSON: roughly a **700x difference**. Streaming updates make the full-snapshot result substantially larger. If the web UI had remained connected for all assistant streaming in this session, the existing 500 ms freshness path alone is estimated at **46.4 GB**; a continuously busy 60 ms broadcast path would be about **386.5 GB**. These are modelled values, not captured network traces.

This does not mean a general-purpose sync engine is immediately necessary. A small, domain-specific protocol—full snapshot for initial/reset, append immutable entries, replace transient tail/status, and revision-check with reset recovery—would capture most of the savings.

## Representative session

Selection scope: recent sessions for this repository under `~/.pi/agent/sessions/--Users-tudoroancea-dotfiles--/`. The largest relevant session from two days before this analysis was:

```text
2026-07-24T16-53-25-699Z_019f950b-ca43-7281-9da7-1623d15d1978.jsonl
```

It ran from 2026-07-24 16:53 UTC to 2026-07-25 07:46 UTC and has the session name `phasewise web ui implementation`. No message contents were copied into this document.

| Measurement | Value |
| --- | ---: |
| Session file | 5,952,376 bytes (5.95 MB / 5.68 MiB) |
| File records | 1 header + 1,403 entries |
| Message entries | 1,368 |
| User / assistant / tool-result messages | 6 / 632 / 730 |
| Entries on final active branch | 1,098 |
| Final active branch JSON | 5,007,930 bytes (5.01 MB / 4.78 MiB) |
| Final SSE frame, entries portion only | 5,007,938 bytes |
| Median / p90 / p99 modelled snapshot | 3.10 / 4.70 / 4.95 MB |

The real frame is slightly larger because it also contains `header`, `leafId`, session state, theme, system prompt, metadata, and pending inputs. The entries-only measurements therefore slightly underestimate traffic. SSE framing adds only `data: ` and two newlines, and this server does not apply response compression.

The file is larger than the final active branch because it is append-only and includes entries from branches that are not ancestors of the final leaf.

## How the current implementation generates traffic

Relevant implementation points:

- `src/index.ts:491-575` builds each snapshot from the complete active `sessionManager.getBranch()` and adds transient assistant/tool entries.
- `src/index.ts:577-584` limits event-triggered broadcasts to at most one every 60 ms.
- `src/server.ts:145-168` versions and serializes the complete snapshot as `data: <JSON>\n\n`.
- `src/server.ts:369-384` retains only the latest frame under backpressure and checks freshness every 500 ms.
- `src/server.ts:413-416` serializes once per broadcast and writes that frame to every client.
- `src/client/app.js:1966-1974` parses each frame and replaces the complete client snapshot.

There is an important amplification detail: transient entries are assigned a new `timestamp` every time `buildSnapshot()` runs. `snapshotVersion()` includes the last entry's timestamp. While a live assistant or visible transient tool result is present, the 500 ms freshness check therefore sees a new version even when no semantic data changed. With at least one connected client, this creates an approximately 2 Hz full-snapshot stream during those periods in addition to event-triggered broadcasts.

Backpressure protects memory by replacing an obsolete pending frame with the newest frame. It does not reduce traffic for a client that can keep up.

## Traffic models

All figures below are decimal units, entries-only, for one connected client. They exclude HTTP/TCP framing, snapshot fields outside `entries`, and transient payload growth unless explicitly stated.

### Initial connection or reconnection

Near the end of the session, one initial snapshot costs approximately **5.01 MB**. This is reasonable by itself and remains useful as the recovery mechanism for any future incremental protocol.

### One full snapshot per persisted append

Replaying the append order and measuring the active parent chain after each entry gives:

| Strategy | Modelled transfer |
| --- | ---: |
| Full active branch once per appended entry | 4.169 GB |
| Send each appended entry once | 5.951 MB |
| Amplification | 700.6x |

This is a comparison model, not an exact trace. The 60 ms debounce can combine closely spaced entries, while message/tool lifecycle events and streaming updates can produce multiple frames between persisted entries.

### Assistant streaming while connected

Assistant message timestamps provide a useful estimate of streaming duration: the inner message timestamp records the start and the outer entry timestamp records persistence at completion.

| Measurement | Value |
| --- | ---: |
| Assistant responses | 632 |
| Combined streaming time | 7,482 s (124.7 min) |
| Median / p90 / p99 duration | 8.23 / 19.63 / 66.01 s |
| Maximum duration | 117.30 s |

Applying the active parent-branch size at each response gives:

| Broadcast model during assistant streaming | Estimated transfer |
| --- | ---: |
| 500 ms freshness only (2 Hz) | 46.4 GB |
| Continuously busy 60 ms debounce (16.7 Hz) | 386.5 GB |
| Both paths firing independently (18.7 Hz) | 432.9 GB |

The 2 Hz estimate is the best baseline for the current code when a client remains connected throughout assistant streaming, because transient timestamps continuously change the snapshot version. The higher figures are capacity/worst-case models: the session file does not record message-update callback frequency, timer overlap, browser connection periods, or actual socket writes, so exact historical traffic cannot be recovered from it.

At the final 5.01 MB frame size:

| Rate | Payload rate per client |
| --- | ---: |
| 2 Hz | 10.0 MB/s, about 80 Mbps |
| 16.7 Hz | 83.5 MB/s, about 668 Mbps |
| 18.7 Hz | 93.5 MB/s, about 748 Mbps |

The average branch size weighted by assistant streaming time was about 3.10 MB, so session-wide active-period rates would be lower than the final-size rates. Traffic scales approximately linearly with the number of clients because serialization is shared but each response receives the frame.

### Incremental alternatives

The final serialized assistant entries total only **2.27 MB** across all 632 responses. As a deliberately conservative proxy, repeatedly sending each assistant's complete *final* entry for its entire streaming duration would cost about **640 MB at 16.7 Hz**. Real growing-tail replacement should be lower because partial messages are smaller than their final form. It would still repeat data within the active assistant message, but would avoid repeating the multi-megabyte transcript.

An operation stream that transmits newly generated content only once should be much closer to the approximately **5.95 MB persisted session payload**, plus protocol fields, status changes, transient tool updates, and occasional reset snapshots. Exact token-delta traffic cannot be reconstructed from the persisted final messages.

## Resource viability

### Local loopback

The bytes do not traverse a physical network for a local browser, but they still incur:

- repeated multi-megabyte `JSON.stringify()` work in the server;
- allocation of each full frame;
- loopback TCP copies;
- repeated multi-megabyte `JSON.parse()` work in every browser;
- Preact state replacement and transcript reconciliation/render work.

A short or mostly idle session is fine. A 5 MB branch streamed at 2–19 Hz is no longer an efficient local implementation even if the machine can sustain it.

### Remote/Tailscale use

The same stream can consume real interface bandwidth when exposed remotely. The final-session rates can saturate ordinary Wi-Fi or uplinks, and hundreds of gigabytes over a long connected run are not viable. Mobile clients are especially sensitive to bandwidth, parsing cost, memory churn, and battery use.

### Current conclusion

- **Simple and viable:** small sessions, brief connections, infrequent updates, or an initial/read-only view.
- **Marginal:** multi-megabyte branches with occasional updates.
- **Not viable as a sustained stream:** multi-megabyte branches during long assistant/tool streaming, especially remotely.

## Recommended optimization path

### 1. Cheap fixes before changing the protocol

1. Give synthetic live entries stable timestamps/versions, or exclude generated timestamps from freshness comparison, so the 500 ms timer only sends semantic changes.
2. Instrument actual behavior before selecting the next design:
   - frame count and total bytes;
   - snapshot byte-size distribution;
   - serialization duration;
   - reason for broadcast (`initial`, Pi event, or freshness);
   - blocked/coalesced frame count;
   - connected-client count;
   - browser parse and render duration.
3. Consider a lower/adaptive update rate for large snapshots. This reduces amplification but does not change its full-history scaling.
4. Treat compression as secondary. It may reduce remote bytes because transcript prefixes repeat internally, but compression adds CPU/latency and some middleware buffers streaming responses unless explicitly flushed. It does not remove stringify, parse, allocation, or render costs.

The stable-version fix is worthwhile independently, but event-triggered updates can still approach the 60 ms cadence.

### 2. Use a small domain protocol, not arbitrary JSON diffs

A practical protocol can remain narrow:

```ts
type ServerUpdate =
  | { type: "snapshot"; revision: number; snapshot: Snapshot }
  | { type: "appendEntries"; from: number; to: number; entries: Entry[] }
  | { type: "replaceLive"; from: number; to: number; live: LiveState }
  | { type: "status"; from: number; to: number; status: StatusState }
  | { type: "reset"; revision: number; snapshot: Snapshot };
```

Rules:

- Send a full snapshot on initial connection.
- Treat persisted branch entries as immutable and append them once.
- Keep assistant/tool partials in a separate replaceable `live` section instead of synthesizing them into the persisted `entries` array.
- Send status/theme/metadata independently from transcript changes.
- Include monotonic revisions. Apply an update only when `from === clientRevision`.
- On a revision gap, reconnect, tree switch, branch change, compaction, or unsupported transition, send a full snapshot/reset.
- Continue coalescing pending output under backpressure, but coalesce to a reset snapshot if intermediate operations would be lost.

This is a synchronization protocol, but not a general sync engine. It needs ordered revisions and a reset path; it does not need arbitrary structural diffs, conflict resolution, offline writes, or durable event replay.

### 3. Add resumable replay only if measurements justify it

SSE `id`/`Last-Event-ID` support and a bounded server-side operation log could avoid a full snapshot after brief reconnects. This adds lifecycle and retention complexity and should come after the basic append/live/reset protocol. A fresh snapshot remains the fallback when the requested revision has expired.

## Decision trigger

Keep the current full-snapshot design while it preserves development simplicity and observed traffic is small. Prioritize the domain protocol when any of these become common:

- active snapshots are multiple megabytes;
- remote use is expected;
- sustained updates happen while a browser is connected;
- serialization/parsing/rendering is visible in profiles;
- measured payload rates reach several MB/s per client.

For the session measured here, that threshold has already been crossed whenever the UI remains open during streaming. The first action should be stable semantic versioning plus telemetry; the next meaningful structural optimization is `snapshot + appendEntries + replaceLive/status + reset`, rather than a generic diff engine.

## Reproduction notes

The measurements were produced by parsing the session JSONL without inspecting or exporting message text, following each entry's `parentId` chain, and using `Buffer.byteLength(JSON.stringify(value))` to match Node's UTF-8 serialization. The historical branch shape was reconstructed incrementally from append order. Assistant duration was calculated as:

```text
outer session-entry timestamp - inner assistant-message timestamp
```

Traffic formulas:

```text
full-snapshot replay = sum(active branch bytes after each append)
stream traffic       = sum(stream duration × active branch bytes × frame rate)
```

These calculations intentionally use the entries portion only. For exact future numbers, record bytes at `response.write()` and the broadcast reason while the application is running.
