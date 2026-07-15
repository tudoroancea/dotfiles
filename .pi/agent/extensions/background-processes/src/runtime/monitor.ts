import { StringDecoder } from "node:string_decoder";

export const MONITOR_FRAGMENT_BYTES = 16 * 1024;
export const MONITOR_BATCH_MS = 200;
export const MONITOR_BATCH_LINES = 32;
export const MONITOR_BATCH_BYTES = 16 * 1024;
export const MONITOR_MESSAGE_MAX_BYTES = 50 * 1024;
export const MONITOR_METADATA_MAX_BYTES = 4 * 1024;
export const MONITOR_PENDING_BYTES = MONITOR_MESSAGE_MAX_BYTES - MONITOR_METADATA_MAX_BYTES;
export const MONITOR_DELIVERY_ERROR_MAX_BYTES = 512;
export const MONITOR_FORMATTED_MAX_LINES = 2_000;
export const MONITOR_METADATA_MAX_LINES = 9;
export const MONITOR_SEPARATOR_MAX_LINES = 1;
export const MONITOR_PENDING_LINES =
  MONITOR_FORMATTED_MAX_LINES - MONITOR_METADATA_MAX_LINES - MONITOR_SEPARATOR_MAX_LINES;
export const MONITOR_DELIVERY_INTERVAL_MS = 1_000;
export const MONITOR_MAX_DELIVERIES = 30;

export interface MonitorFragment {
  sequence: number;
  part: number;
  text: string;
  bytes: number;
  split: boolean;
}

export interface MonitorWindow {
  fragments: MonitorFragment[];
  firstSequence?: number;
  lastSequence?: number;
  droppedLines: number;
  droppedBytes: number;
  missingFirstSequence?: number;
  missingLastSequence?: number;
  splitLines: number;
  captureBatches: number;
}

export interface MonitorMetrics {
  droppedLines: number;
  droppedBytes: number;
  splitLines: number;
}

export interface MonitorEvent extends Omit<MonitorWindow, "fragments"> {
  jobId: string;
  description: string;
  outputPath: string;
  delivery: number;
  lines: string[];
  captureOnly: boolean;
  deliveryError?: string;
}

export function sanitizeMonitorText(value: string): string {
  let safe = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1b || code === 0x9b || code === 0x9d) {
      const introducer = code === 0x1b ? value[index + 1] : code === 0x9b ? "[" : "]";
      if (code === 0x1b && (introducer === "[" || introducer === "]")) index += 1;
      if (introducer === "[") {
        while (index + 1 < value.length) {
          const next = value.charCodeAt(++index);
          if (next >= 0x40 && next <= 0x7e) break;
        }
      } else if (introducer === "]") {
        while (index + 1 < value.length) {
          const next = value.charCodeAt(++index);
          if (next === 0x07 || next === 0x9c) break;
          if (next === 0x1b && value[index + 1] === "\\") {
            index += 1;
            break;
          }
        }
      }
      safe += " ";
    } else {
      safe += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : value[index];
    }
  }
  return safe;
}

/** Incremental line framer. It never retains more than one model-visible fragment. */
export class MonitorDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffered = "";
  private bufferedBytes = 0;
  private sequence = 1;
  private part = 1;
  private lineStarted = false;

  write(chunk: Buffer): MonitorFragment[] {
    return this.consume(this.decoder.write(chunk), false);
  }

  end(): MonitorFragment[] {
    return this.consume(this.decoder.end(), true);
  }

  private consume(decoded: string, final: boolean): MonitorFragment[] {
    const result: MonitorFragment[] = [];
    for (const character of decoded) {
      if (character === "\n") {
        if (this.buffered.endsWith("\r")) {
          this.buffered = this.buffered.slice(0, -1);
          this.bufferedBytes -= 1;
        }
        result.push(this.emit(true));
        this.nextLine();
        continue;
      }
      this.lineStarted = true;
      const bytes = Buffer.byteLength(character);
      if (this.bufferedBytes + bytes > MONITOR_FRAGMENT_BYTES && this.buffered) {
        result.push(this.emit(false));
      }
      this.buffered += character;
      this.bufferedBytes += bytes;
    }
    if (final && this.lineStarted) {
      if (this.buffered.endsWith("\r")) {
        this.buffered = this.buffered.slice(0, -1);
        this.bufferedBytes -= 1;
      }
      // A line that ended exactly on a fragment boundary was already represented.
      if (this.buffered || this.part === 1) result.push(this.emit(true));
      this.nextLine();
    }
    return result;
  }

  private emit(finalFragment: boolean): MonitorFragment {
    const text = sanitizeMonitorText(this.buffered);
    const fragment = {
      sequence: this.sequence,
      part: this.part,
      text,
      bytes: Buffer.byteLength(text),
      split: !finalFragment || this.part > 1,
    };
    this.buffered = "";
    this.bufferedBytes = 0;
    this.part += 1;
    return fragment;
  }

  private nextLine(): void {
    this.sequence += 1;
    this.part = 1;
    this.lineStarted = false;
    this.buffered = "";
    this.bufferedBytes = 0;
  }
}

export function formatMonitorFragment(fragment: MonitorFragment): string {
  return fragment.split || fragment.part > 1
    ? `[source ${fragment.sequence} part ${fragment.part}] ${fragment.text}`
    : fragment.text;
}

function formattedFragmentBytes(fragment: MonitorFragment): number {
  return Buffer.byteLength(formatMonitorFragment(fragment));
}

function formattedFragmentLines(fragment: MonitorFragment): number {
  let lines = 1;
  for (const character of fragment.text) if (character === "\n") lines += 1;
  return lines;
}

export class MonitorCoalescer {
  private fragments: MonitorFragment[] = [];
  private bytes = 0;
  private lines = 0;
  private droppedSequence?: number;
  private windowDroppedLines = 0;
  private windowDroppedBytes = 0;
  private windowMissingFirst?: number;
  private windowMissingLast?: number;
  private lastSplitSequence?: number;
  private totalDroppedLines = 0;
  private totalDroppedBytes = 0;
  private totalSplitLines = 0;
  private windowCaptureBatches = 0;

  append(fragments: MonitorFragment[]): void {
    this.windowCaptureBatches += 1;
    for (const fragment of fragments) {
      if (fragment.split && this.lastSplitSequence !== fragment.sequence) {
        this.lastSplitSequence = fragment.sequence;
        this.totalSplitLines += 1;
      }
      if (this.droppedSequence === fragment.sequence) {
        this.windowMissingFirst ??= fragment.sequence;
        this.windowMissingLast = fragment.sequence;
        this.dropFragment(fragment, false);
        continue;
      }
      this.droppedSequence = undefined;
      this.bytes += formattedFragmentBytes(fragment) + (this.fragments.length > 0 ? 1 : 0);
      this.fragments.push(fragment);
      this.lines += formattedFragmentLines(fragment);
      while (this.lines > MONITOR_PENDING_LINES || this.bytes > MONITOR_PENDING_BYTES) {
        this.dropOldestSequence();
      }
    }
  }

  get size(): number {
    return this.fragments.length;
  }

  metrics(): MonitorMetrics {
    return {
      droppedLines: this.totalDroppedLines,
      droppedBytes: this.totalDroppedBytes,
      splitLines: this.totalSplitLines,
    };
  }

  drain(): MonitorWindow {
    const fragments = this.fragments;
    const presentSplitLines = new Set(
      fragments.filter((fragment) => fragment.split).map((fragment) => fragment.sequence),
    ).size;
    const window: MonitorWindow = {
      fragments,
      firstSequence: fragments[0]?.sequence,
      lastSequence: fragments.at(-1)?.sequence,
      droppedLines: this.windowDroppedLines,
      droppedBytes: this.windowDroppedBytes,
      missingFirstSequence: this.windowMissingFirst,
      missingLastSequence: this.windowMissingLast,
      splitLines: presentSplitLines,
      captureBatches: this.windowCaptureBatches,
    };
    this.fragments = [];
    this.bytes = 0;
    this.lines = 0;
    this.windowDroppedLines = 0;
    this.windowDroppedBytes = 0;
    this.windowMissingFirst = undefined;
    this.windowMissingLast = undefined;
    this.windowCaptureBatches = 0;
    return window;
  }

  private dropOldestSequence(): void {
    const sequence = this.fragments[0]!.sequence;
    this.droppedSequence = sequence;
    this.windowDroppedLines += 1;
    this.totalDroppedLines += 1;
    this.windowMissingFirst ??= sequence;
    this.windowMissingLast = sequence;
    while (this.fragments[0]?.sequence === sequence)
      this.dropFragment(this.fragments.shift()!, true);
  }

  private dropFragment(fragment: MonitorFragment, wasRetained: boolean): void {
    if (wasRetained) {
      this.bytes -= formattedFragmentBytes(fragment) + (this.fragments.length > 0 ? 1 : 0);
      this.lines -= formattedFragmentLines(fragment);
    }
    this.windowDroppedBytes += fragment.bytes;
    this.totalDroppedBytes += fragment.bytes;
  }
}

export class MonitorPipeline {
  private readonly decoder = new MonitorDecoder();
  private readonly pending = new MonitorCoalescer();
  private capture: MonitorFragment[] = [];
  private captureBytes = 0;
  private captureSources = new Set<number>();
  private timer?: NodeJS.Timeout;
  private ended = false;

  constructor(private readonly ready: () => void) {}

  write(chunk: Buffer): void {
    if (!this.ended) this.add(this.decoder.write(chunk));
  }

  finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.add(this.decoder.end(), false);
    this.flushCapture(false);
    this.clearTimer();
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  metrics(): MonitorMetrics {
    return this.pending.metrics();
  }

  drain(): MonitorWindow {
    return this.pending.drain();
  }

  dispose(): void {
    this.ended = true;
    this.capture = [];
    this.captureBytes = 0;
    this.captureSources.clear();
    this.clearTimer();
  }

  private add(fragments: MonitorFragment[], notify = true): void {
    for (const fragment of fragments) {
      this.capture.push(fragment);
      this.captureBytes += fragment.bytes;
      this.captureSources.add(fragment.sequence);
      if (
        this.captureSources.size >= MONITOR_BATCH_LINES ||
        this.captureBytes >= MONITOR_BATCH_BYTES
      ) {
        this.flushCapture(notify);
      }
    }
    if (notify && this.capture.length > 0 && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flushCapture();
      }, MONITOR_BATCH_MS);
    }
  }

  private flushCapture(notify = true): void {
    if (this.capture.length === 0) return;
    const captured = this.capture;
    this.capture = [];
    this.captureBytes = 0;
    this.captureSources.clear();
    this.clearTimer();
    this.pending.append(captured);
    if (notify) this.ready();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value) <= maximumBytes) return value;
  const suffix = "…";
  const bytes = Buffer.from(value);
  let end = maximumBytes - Buffer.byteLength(suffix);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${suffix}`;
}

function metadataText(value: string, maximumBytes: number): string {
  return truncateUtf8(sanitizeMonitorText(value).replace(/\s+/g, " ").trim(), maximumBytes);
}

export function boundedMonitorDeliveryError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return metadataText(value, MONITOR_DELIVERY_ERROR_MAX_BYTES);
}

export function formatMonitorEvent(event: MonitorEvent): string {
  const range =
    event.firstSequence === undefined
      ? "none"
      : `${event.firstSequence}-${event.lastSequence ?? event.firstSequence}`;
  const metadata = [
    `monitor ${metadataText(event.jobId, 64)} (${metadataText(event.description, 2_048)})`,
    `source sequences: ${range}`,
    `dropped: ${event.droppedLines} lines / ${event.droppedBytes} bytes`,
    `split source lines: ${event.splitLines}`,
    `coalesced capture batches: ${event.captureBatches}`,
    event.missingFirstSequence === undefined
      ? undefined
      : `missing source sequences: ${event.missingFirstSequence}-${event.missingLastSequence}`,
    event.deliveryError === undefined
      ? undefined
      : `previous delivery error: ${metadataText(event.deliveryError, MONITOR_DELIVERY_ERROR_MAX_BYTES)}`,
    `output: ${metadataText(event.outputPath, 1_024)}`,
  ].filter((line): line is string => line !== undefined);
  if (event.captureOnly)
    metadata.push("Live delivery limit reached; continuing raw capture only until completion.");
  return `${metadata.join("\n")}\n\n${event.lines.join("\n")}`;
}
