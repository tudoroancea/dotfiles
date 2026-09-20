import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { AdmissionResult, SessionHostCommand } from "./session-host.ts";

interface Deferred {
  resolve(result: AdmissionResult): void;
}
interface AdmissionRecord {
  key: string;
  scope: string;
  command: SessionHostCommand;
  fingerprint: string;
  bytes: number;
  interrupt: boolean;
  state: "queued" | "invoked" | "terminal";
  promise: Promise<AdmissionResult>;
  deferred: Deferred;
  result?: AdmissionResult;
  timer?: NodeJS.Timeout;
}

export interface AdmissionControllerOptions {
  maxPendingCount: number;
  maxPendingBytes: number;
  maxCompletedRecords?: number;
  deadlineMs?: number;
}

export type AdmissionExecutor = (command: SessionHostCommand) => Promise<AdmissionResult>;

function isInterrupt(command: SessionHostCommand): boolean {
  return (
    command.type === "abort" ||
    command.type === "dialog_response" ||
    command.type === "dialog_cancel"
  );
}

function commandBytes(command: SessionHostCommand): number {
  if (command.type === "prompt" || command.type === "steer" || command.type === "follow_up") {
    const imageBytes = (command.images ?? []).reduce(
      (bytes, image) => bytes + image.byteLength + Buffer.byteLength(image.data),
      0,
    );
    return Buffer.byteLength(command.text) + imageBytes;
  }
  if (command.type === "queue_edit") return Buffer.byteLength(command.text);
  if (command.type === "compact" && command.instructions)
    return Buffer.byteLength(command.instructions);
  return 0;
}

export class AdmissionController {
  readonly #maxPendingCount: number;
  readonly #maxPendingBytes: number;
  readonly #maxCompletedRecords: number;
  readonly #deadlineMs: number;
  readonly #execute: AdmissionExecutor;
  readonly #records = new Map<string, AdmissionRecord>();
  readonly #queue: AdmissionRecord[] = [];
  readonly #pendingByScope = new Map<string, { count: number; bytes: number }>();
  #pendingCount = 0;
  #pendingBytes = 0;
  #active?: AdmissionRecord;
  #fenced = false;
  #interrupts = 0;

  constructor(options: AdmissionControllerOptions, execute: AdmissionExecutor) {
    if (!Number.isSafeInteger(options.maxPendingCount) || options.maxPendingCount < 1)
      throw new RangeError("Pending admission count must be positive");
    if (!Number.isSafeInteger(options.maxPendingBytes) || options.maxPendingBytes < 1)
      throw new RangeError("Pending admission bytes must be positive");
    const maxCompletedRecords = options.maxCompletedRecords ?? 4096;
    const deadlineMs = options.deadlineMs ?? 30_000;
    if (!Number.isSafeInteger(maxCompletedRecords) || maxCompletedRecords < 1)
      throw new RangeError("Completed admission record count must be positive");
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 10 * 60_000)
      throw new RangeError("Admission deadline must be from 1ms to 10 minutes");
    this.#maxPendingCount = options.maxPendingCount;
    this.#maxPendingBytes = options.maxPendingBytes;
    this.#maxCompletedRecords = maxCompletedRecords;
    this.#deadlineMs = deadlineMs;
    this.#execute = execute;
  }

  submit(scope: string, command: SessionHostCommand): Promise<AdmissionResult> {
    const key = `${scope}\0${command.commandId}`;
    const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("base64url");
    const existing = this.#records.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        return Promise.resolve({
          status: "rejected",
          commandId: command.commandId,
          code: "command_id_conflict",
          message: "Command ID was already used for different input",
        });
      return existing.promise;
    }
    if (this.#records.size >= this.#maxCompletedRecords)
      return Promise.resolve({
        status: "rejected",
        commandId: command.commandId,
        code: "command_epoch_exhausted",
        message: "Command replay window is exhausted for this epoch",
      });
    if (this.#fenced || (this.#interrupts > 0 && !isInterrupt(command)))
      return Promise.resolve({
        status: "rejected",
        commandId: command.commandId,
        code: "host_not_ready",
        message: "Host is fenced",
      });

    const bytes = commandBytes(command);
    if (!isInterrupt(command)) {
      const pending = this.#pendingByScope.get(scope) ?? { count: 0, bytes: 0 };
      if (
        this.#pendingCount >= this.#maxPendingCount ||
        this.#pendingBytes + bytes > this.#maxPendingBytes ||
        pending.count >= this.#maxPendingCount ||
        pending.bytes + bytes > this.#maxPendingBytes
      )
        return Promise.resolve({
          status: "rejected",
          commandId: command.commandId,
          code: "admission_queue_full",
          message: "Command admission queue limit is exhausted",
        });
      this.#pendingCount += 1;
      this.#pendingBytes += bytes;
      this.#pendingByScope.set(scope, { count: pending.count + 1, bytes: pending.bytes + bytes });
    } else {
      const pendingInterrupts = [...this.#records.values()].filter(
        (record) => record.state !== "terminal" && record.interrupt,
      ).length;
      if (pendingInterrupts >= Math.min(this.#maxPendingCount, 8))
        return Promise.resolve({
          status: "rejected",
          commandId: command.commandId,
          code: "interrupt_limit_exhausted",
          message: "Interrupt admission limit is exhausted",
        });
    }

    let resolve!: Deferred["resolve"];
    const promise = new Promise<AdmissionResult>((settle) => {
      resolve = settle;
    });
    const record: AdmissionRecord = {
      key,
      scope,
      command,
      fingerprint,
      bytes,
      interrupt: isInterrupt(command),
      state: isInterrupt(command) ? "invoked" : "queued",
      promise,
      deferred: { resolve },
    };
    record.timer = setTimeout(() => this.#expire(record), this.#deadlineMs);
    record.timer.unref();
    this.#records.set(key, record);
    if (isInterrupt(command)) {
      this.#interrupts += 1;
      for (const queued of this.#queue.slice())
        if (queued.state === "queued")
          this.#settle(queued, {
            status: "rejected",
            commandId: queued.command.commandId,
            code: "admission_interrupted",
            message: "Command was interrupted before SDK invocation",
          });
      this.#invoke(record, true);
    } else {
      this.#queue.push(record);
      this.#pump();
    }
    return promise;
  }

  fence(): void {
    if (this.#fenced) return;
    this.#fenced = true;
    for (const record of this.#queue.slice())
      if (record.state === "queued")
        this.#settle(record, {
          status: "rejected",
          commandId: record.command.commandId,
          code: "host_not_ready",
          message: "Host was fenced before invocation",
        });
  }

  get pendingCount(): number {
    let count = this.#active?.state === "invoked" ? 1 : 0;
    for (const record of this.#records.values())
      if (record.state === "invoked" && record !== this.#active) count += 1;
    return count + this.#queue.filter((record) => record.state === "queued").length;
  }

  #pump(): void {
    if (this.#active || this.#fenced || this.#interrupts > 0) return;
    let next: AdmissionRecord | undefined;
    while ((next = this.#queue.shift())) if (next.state === "queued") break;
    if (!next || next.state !== "queued") return;
    this.#active = next;
    next.state = "invoked";
    this.#invoke(next, false);
  }

  #invoke(record: AdmissionRecord, interrupt: boolean): void {
    void Promise.resolve()
      .then(() => this.#execute(record.command))
      .then(
        (result) => this.#settle(record, result),
        () =>
          this.#settle(record, {
            status: "ambiguous",
            commandId: record.command.commandId,
            message: "Command admission failed without an authoritative outcome",
          }),
      )
      .finally(() => {
        if (interrupt) {
          this.#interrupts -= 1;
          if (this.#interrupts === 0) this.#pump();
        } else if (this.#active === record) {
          this.#active = undefined;
          this.#pump();
        }
      });
  }

  #expire(record: AdmissionRecord): void {
    if (record.state === "terminal") return;
    const invoked = record.state === "invoked";
    if (invoked) this.fence();
    this.#settle(
      record,
      invoked
        ? {
            status: "ambiguous",
            commandId: record.command.commandId,
            message: "Command admission deadline expired after invocation",
          }
        : {
            status: "rejected",
            commandId: record.command.commandId,
            code: "admission_timeout",
            message: "Command admission deadline expired before invocation",
          },
    );
    if (this.#active === record) {
      this.#active = undefined;
      this.#pump();
    }
  }

  #settle(record: AdmissionRecord, result: AdmissionResult): void {
    if (record.state === "terminal") return;
    const wasOrdinary = !record.interrupt;
    record.state = "terminal";
    record.result = result;
    if (record.timer) clearTimeout(record.timer);
    if (wasOrdinary) {
      this.#pendingCount -= 1;
      this.#pendingBytes -= record.bytes;
      const pending = this.#pendingByScope.get(record.scope);
      if (pending) {
        const next = { count: pending.count - 1, bytes: pending.bytes - record.bytes };
        if (next.count === 0) this.#pendingByScope.delete(record.scope);
        else this.#pendingByScope.set(record.scope, next);
      }
    }
    const queuedIndex = this.#queue.indexOf(record);
    if (queuedIndex >= 0) this.#queue.splice(queuedIndex, 1);
    const commandId = record.command.commandId;
    record.command = { type: "abort", commandId };
    record.deferred.resolve(result);
    if (this.#active === record && !this.#fenced) {
      this.#active = undefined;
      this.#pump();
    }
  }
}
