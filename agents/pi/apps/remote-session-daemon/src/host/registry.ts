import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { LIMITS } from "@dotfiles/pi-web-ui-client/wire";
import { AdmissionController } from "./admission.ts";
import { LiveProjection, type ProjectionAttachment } from "../projection/live-projection.ts";
import type {
  AdmissionResult,
  HostLifecycleState,
  SessionHost,
  SessionHostCommand,
  SessionCommandInfo,
  SessionIdentity,
} from "./session-host.ts";

export interface ConfirmedResumeTarget {
  readonly sessionId: string;
  readonly sessionFile: string;
}
export interface HostFactoryInput {
  launchId: string;
  hostEpoch: string;
  cwd: string;
  resumeTarget?: ConfirmedResumeTarget;
}
export type SessionHostFactory = (input: HostFactoryInput) => Promise<SessionHost>;
export interface LaunchSummary {
  launchId: string;
  lifecycle: HostLifecycleState;
  generation: string;
  commandEpoch: string;
  hostEpoch: string | null;
  ready: boolean;
  createdAt: number;
  updatedAt: number;
  failureCode?: string;
}
export interface LaunchDetail extends LaunchSummary {
  running: boolean;
  settled: boolean;
}
interface LaunchSlot {
  launchId: string;
  cwd: string;
  lifecycle: HostLifecycleState;
  generation: string;
  commandEpoch: string;
  hostEpoch: string | null;
  host?: SessionHost;
  admission?: AdmissionController;
  projection?: LiveProjection;
  acceptingCommands: boolean;
  fenceEpoch: number;
  unsubscribe?: () => void;
  confirmedIdentity?: ConfirmedResumeTarget;
  reserved: boolean;
  lane: Promise<void>;
  createdAt: number;
  updatedAt: number;
  failureCode?: string;
}
export class RegistryError extends Error {
  constructor(
    readonly code:
      | "capacity_exhausted"
      | "memory_exhausted"
      | "launch_limit_exhausted"
      | "launch_not_found"
      | "launch_stopped"
      | "host_not_ready"
      | "identity_mismatch"
      | "readiness_failed",
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}
export interface LaunchRegistryOptions {
  capacity: number;
  totalLaunches?: number;
  memoryBytes?: number;
  memoryUsage?: () => number;
  queueCount?: number;
  queueBytes?: number;
  admissionDeadlineMs?: number;
  completedAdmissionRecords?: number;
  hostFactory: SessionHostFactory;
  now?: () => number;
  idFactory?: () => string;
}
function sameIdentity(actual: SessionIdentity | null, expected: ConfirmedResumeTarget): boolean {
  return actual?.sessionId === expected.sessionId && actual.sessionFile === expected.sessionFile;
}
export class LaunchRegistry {
  readonly #capacity: number;
  readonly #totalLaunches: number;
  readonly #memoryBytes: number;
  readonly #memoryUsage: () => number;
  readonly #factory: SessionHostFactory;
  readonly #queueCount: number;
  readonly #queueBytes: number;
  readonly #admissionOptions: {
    maxPendingCount: number;
    maxPendingBytes: number;
    deadlineMs?: number;
    maxCompletedRecords?: number;
  };
  readonly #now: () => number;
  readonly #id: () => string;
  readonly #slots = new Map<string, LaunchSlot>();
  #stopping = false;

  constructor(options: LaunchRegistryOptions) {
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 1)
      throw new RangeError("Registry capacity must be positive");
    const totalLaunches = options.totalLaunches ?? 256;
    if (!Number.isSafeInteger(totalLaunches) || totalLaunches < 1)
      throw new RangeError("Total launch limit must be positive");
    const memoryBytes = options.memoryBytes ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 1)
      throw new RangeError("Memory limit must be positive");
    this.#capacity = options.capacity;
    this.#totalLaunches = totalLaunches;
    this.#memoryBytes = memoryBytes;
    this.#memoryUsage = options.memoryUsage ?? (() => process.memoryUsage().rss);
    this.#factory = options.hostFactory;
    this.#queueCount = options.queueCount ?? 32;
    this.#queueBytes = options.queueBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.#queueCount) || this.#queueCount < 1)
      throw new RangeError("Queue count limit must be positive");
    if (!Number.isSafeInteger(this.#queueBytes) || this.#queueBytes < 1)
      throw new RangeError("Queue byte limit must be positive");
    this.#admissionOptions = {
      maxPendingCount: this.#queueCount,
      // Image commands retain both encoded and decoded source bytes until
      // authoritative preflight/settlement; keep the ordinary count bound while
      // making the advertised image aggregate usable.
      maxPendingBytes: Math.max(
        this.#queueBytes,
        LIMITS.maxImageSourceBytesPerEntry +
          Math.ceil((LIMITS.maxImageSourceBytesPerEntry / 3) * 4) +
          512 * 1024,
      ),
      ...(options.admissionDeadlineMs === undefined
        ? {}
        : { deadlineMs: options.admissionDeadlineMs }),
      ...(options.completedAdmissionRecords === undefined
        ? {}
        : { maxCompletedRecords: options.completedAdmissionRecords }),
    };
    this.#now = options.now ?? Date.now;
    this.#id = options.idFactory ?? randomUUID;
  }
  get reservedCapacity(): number {
    this.#assertInvariants();
    return [...this.#slots.values()].filter((slot) => slot.reserved).length;
  }
  async create(canonicalCwd: string): Promise<LaunchDetail> {
    if (this.#stopping) throw new RegistryError("launch_stopped", "Registry is stopping");
    this.#reserve();
    this.#makeLaunchSlotAvailable();
    const now = this.#now();
    const slot: LaunchSlot = {
      launchId: this.#id(),
      cwd: canonicalCwd,
      lifecycle: "unloaded",
      generation: this.#id(),
      commandEpoch: this.#id(),
      hostEpoch: null,
      acceptingCommands: false,
      fenceEpoch: 0,
      reserved: true,
      lane: Promise.resolve(),
      createdAt: now,
      updatedAt: now,
    };
    this.#slots.set(slot.launchId, slot);
    return this.#serialize(slot, () => this.#load(slot));
  }
  list(): LaunchSummary[] {
    this.#assertInvariants();
    return [...this.#slots.values()].map((slot) => this.#summary(slot));
  }
  detail(launchId: string): LaunchDetail {
    const slot = this.#required(launchId);
    const state = slot.host?.state;
    return {
      ...this.#summary(slot),
      running: state?.running ?? false,
      settled: state?.settled ?? true,
    };
  }
  reopen(launchId: string): Promise<LaunchDetail> {
    const slot = this.#required(launchId);
    return this.#serialize(slot, async () => {
      if (slot.lifecycle === "stopped")
        throw new RegistryError("launch_stopped", "Stopped launches cannot be reopened");
      if (slot.host) return this.detail(launchId);
      if (!slot.confirmedIdentity)
        throw new RegistryError("identity_mismatch", "Launch has no confirmed resume identity");
      if (!slot.reserved) {
        this.#reserve();
        slot.reserved = true;
      }
      return this.#load(slot);
    });
  }
  unload(launchId: string): Promise<LaunchDetail> {
    const slot = this.#required(launchId);
    const assertUnloadable = () => {
      const state = slot.host?.state;
      if (!slot.confirmedIdentity)
        throw new RegistryError("identity_mismatch", "Launch has no confirmed resume identity");
      if (
        !state?.ready ||
        !state.settled ||
        state.running ||
        state.pendingMessages !== 0 ||
        (slot.admission?.pendingCount ?? 0) !== 0
      )
        throw new RegistryError("host_not_ready", "Only an idle reconciled host may unload");
    };
    if (slot.host) {
      try {
        assertUnloadable();
      } catch (error) {
        return Promise.reject(error);
      }
      this.#fence(slot);
    }
    return this.#serialize(slot, async () => {
      const host = slot.host;
      if (!host) return this.detail(launchId);
      if (slot.acceptingCommands) {
        assertUnloadable();
        this.#fence(slot);
      }
      this.#set(slot, "unloading");
      slot.unsubscribe?.();
      slot.unsubscribe = undefined;
      slot.projection?.dispose();
      slot.projection = undefined;
      try {
        await host.dispose();
        slot.host = undefined;
        slot.admission = undefined;
        slot.reserved = false;
        slot.hostEpoch = null;
        slot.commandEpoch = this.#id();
        this.#set(slot, "unloaded");
      } catch (error) {
        slot.host = host;
        slot.reserved = true;
        slot.failureCode = "dispose_failed";
        this.#set(slot, "failed");
        throw error;
      }
      return this.detail(launchId);
    });
  }
  async unloadIdle(idleForMs: number): Promise<LaunchDetail[]> {
    if (!Number.isSafeInteger(idleForMs) || idleForMs < 0)
      throw new RangeError("Idle duration must be a non-negative integer");
    const cutoff = this.#now() - idleForMs;
    const candidates = [...this.#slots.values()].filter((slot) => {
      const state = slot.host?.state;
      return (
        slot.lifecycle === "ready" &&
        slot.updatedAt <= cutoff &&
        Boolean(slot.confirmedIdentity) &&
        Boolean(state?.ready && state.settled && !state.running && state.pendingMessages === 0)
      );
    });
    const results = await Promise.allSettled(candidates.map((slot) => this.unload(slot.launchId)));
    return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  }
  stop(launchId: string): Promise<LaunchDetail> {
    const slot = this.#required(launchId);
    this.#fence(slot);
    return this.#serialize(slot, async () => {
      const host = slot.host;
      this.#set(slot, "stopping");
      slot.unsubscribe?.();
      slot.unsubscribe = undefined;
      slot.projection?.dispose();
      slot.projection = undefined;
      try {
        await host?.dispose();
        slot.host = undefined;
        slot.admission = undefined;
        slot.reserved = false;
        slot.hostEpoch = null;
        slot.commandEpoch = this.#id();
        this.#set(slot, "stopped");
      } catch (error) {
        slot.host = host;
        slot.reserved = Boolean(host);
        slot.failureCode = "dispose_failed";
        this.#set(slot, "failed");
        throw error;
      }
      return this.detail(launchId);
    });
  }
  command(
    launchId: string,
    generation: string,
    commandEpoch: string,
    command: SessionHostCommand,
    scope = "local",
  ): Promise<AdmissionResult> {
    const slot = this.#required(launchId);
    if (
      slot.generation !== generation ||
      slot.commandEpoch !== commandEpoch ||
      !slot.acceptingCommands ||
      (slot.lifecycle !== "ready" && slot.lifecycle !== "running") ||
      !slot.host?.state.ready ||
      !slot.admission
    )
      return Promise.resolve({
        status: "rejected",
        commandId: command.commandId,
        code: "host_not_ready",
        message: "Host generation is stale or fenced",
      });
    return slot.admission.submit(scope, command);
  }
  projection(launchId: string): ProjectionAttachment {
    const slot = this.#required(launchId);
    if (
      !slot.acceptingCommands ||
      !slot.projection ||
      !slot.host?.state.ready ||
      (slot.lifecycle !== "ready" && slot.lifecycle !== "running")
    )
      throw new RegistryError("host_not_ready", "Projection is fenced");
    return slot.projection.attachment();
  }
  commands(launchId: string): {
    generation: string;
    commandEpoch: string;
    commands: readonly SessionCommandInfo[];
  } {
    const slot = this.#required(launchId);
    if (!slot.acceptingCommands || !slot.host?.state.ready)
      throw new RegistryError("host_not_ready", "Host is fenced");
    return {
      generation: slot.generation,
      commandEpoch: slot.commandEpoch,
      commands: slot.host.commands(),
    };
  }
  async stopAll(): Promise<void> {
    this.#stopping = true;
    const results = await Promise.allSettled(
      [...this.#slots.values()]
        .filter((slot) => slot.lifecycle !== "stopped")
        .map((slot) => this.stop(slot.launchId)),
    );
    const errors = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        "Registry shutdown failed",
      );
  }
  async #load(slot: LaunchSlot): Promise<LaunchDetail> {
    this.#set(slot, slot.hostEpoch ? "restarting" : "loading");
    const loadFenceEpoch = slot.fenceEpoch;
    const hostEpoch = this.#id();
    const generation = this.#id();
    let candidate: SessionHost | undefined;
    try {
      candidate = await this.#factory({
        launchId: slot.launchId,
        hostEpoch,
        cwd: slot.cwd,
        resumeTarget: slot.confirmedIdentity ? { ...slot.confirmedIdentity } : undefined,
      });
      const state = candidate.state;
      if (
        !state.ready ||
        state.running ||
        !state.settled ||
        state.pendingMessages !== 0 ||
        state.launchId !== slot.launchId ||
        state.hostEpoch !== hostEpoch ||
        !state.identity
      )
        throw new RegistryError("readiness_failed", "Candidate did not reach exact idle readiness");
      if (slot.confirmedIdentity && !sameIdentity(state.identity, slot.confirmedIdentity))
        throw new RegistryError("identity_mismatch", "Resumed session identity did not match");
      let projection!: LiveProjection;
      projection = await LiveProjection.create(candidate, generation, () => {
        if (slot.host !== candidate || slot.projection !== projection) return;
        slot.failureCode = "projection_failed";
        this.#fence(slot);
        this.#set(slot, "failed");
      });
      const projectedState = candidate.state;
      if (
        !projectedState.ready ||
        projectedState.running ||
        !projectedState.settled ||
        projectedState.pendingMessages !== 0 ||
        projectedState.launchId !== slot.launchId ||
        projectedState.hostEpoch !== hostEpoch ||
        projectedState.sessionEpoch !== state.sessionEpoch ||
        !projectedState.identity ||
        projectedState.identity.sessionId !== state.identity.sessionId ||
        projectedState.identity.sessionFile !== state.identity.sessionFile
      ) {
        projection.dispose();
        throw new RegistryError(
          "readiness_failed",
          "Candidate changed during initial projection reconciliation",
        );
      }
      if (slot.fenceEpoch !== loadFenceEpoch) projection.dispose();
      slot.host = candidate;
      slot.projection = projection;
      slot.reserved = true;
      slot.hostEpoch = hostEpoch;
      const lifecycleFenced = slot.fenceEpoch !== loadFenceEpoch;
      if (!lifecycleFenced) slot.generation = generation;
      slot.commandEpoch = state.sessionEpoch;
      slot.acceptingCommands = !lifecycleFenced;
      slot.admission = this.#createAdmission(slot, candidate);
      if (lifecycleFenced) slot.admission.fence();
      slot.confirmedIdentity =
        state.identity.sessionFile === null
          ? undefined
          : { sessionId: state.identity.sessionId, sessionFile: state.identity.sessionFile };
      slot.failureCode = undefined;
      slot.unsubscribe = candidate.subscribe((event) => {
        if (slot.host !== candidate) return;
        if (event.type === "host_lost") {
          slot.failureCode = "host_lost";
          if (slot.acceptingCommands || slot.projection) this.#fence(slot);
          this.#set(slot, "failed");
          return;
        }
        if (event.type !== "state") return;
        if (event.state.ready && event.state.sessionEpoch !== slot.commandEpoch) {
          const previousAdmission = slot.admission;
          slot.commandEpoch = event.state.sessionEpoch;
          previousAdmission?.fence();
          slot.admission = this.#createAdmission(slot, candidate!);
        }
        if (event.state.lifecycle === "running" || event.state.lifecycle === "ready")
          this.#set(slot, event.state.lifecycle);
        else if (event.state.lifecycle === "failed") {
          slot.failureCode = "host_failed";
          if (slot.acceptingCommands || slot.projection) this.#fence(slot);
          this.#set(slot, "failed");
        }
      });
      this.#set(slot, "ready");
      this.#assertInvariants();
      return this.detail(slot.launchId);
    } catch (error) {
      if (candidate) {
        slot.unsubscribe?.();
        slot.unsubscribe = undefined;
        if (slot.host === candidate) {
          slot.projection?.dispose();
          slot.projection = undefined;
          slot.host = undefined;
          slot.admission = undefined;
          slot.acceptingCommands = false;
          slot.hostEpoch = null;
        }
        try {
          await candidate.dispose();
          slot.reserved = false;
        } catch {
          slot.host = candidate;
          slot.reserved = true;
          slot.failureCode = "dispose_failed";
          this.#set(slot, "failed");
          throw error;
        }
      } else slot.reserved = false;
      slot.failureCode = error instanceof RegistryError ? error.code : "host_creation_failed";
      this.#set(slot, "failed");
      throw error;
    }
  }
  #createAdmission(slot: LaunchSlot, candidate: SessionHost): AdmissionController {
    return new AdmissionController(this.#admissionOptions, async (command) => {
      const host = slot.host;
      if (
        !slot.acceptingCommands ||
        !host ||
        host !== candidate ||
        (slot.lifecycle !== "ready" && slot.lifecycle !== "running") ||
        !host.state.ready
      )
        return {
          status: "rejected",
          commandId: command.commandId,
          code: "host_not_ready",
          message: "Host was fenced before SDK invocation",
        };
      if ((command.type === "steer" || command.type === "follow_up") && host.state.running) {
        const state = host.state;
        const bytes = Buffer.byteLength(command.text);
        if (state.queueCount >= this.#queueCount || state.queueBytes + bytes > this.#queueBytes)
          return {
            status: "rejected",
            commandId: command.commandId,
            code: "message_queue_full",
            message: "Pending message queue limit is exhausted",
          };
      }
      return host.command(command);
    });
  }
  #makeLaunchSlotAvailable(): void {
    if (this.#slots.size < this.#totalLaunches) return;
    const retired = [...this.#slots.values()]
      .filter((slot) => slot.lifecycle === "stopped" && !slot.host && !slot.reserved)
      .sort((left, right) => left.updatedAt - right.updatedAt)[0];
    if (!retired)
      throw new RegistryError("launch_limit_exhausted", "Total launch slots are exhausted");
    this.#slots.delete(retired.launchId);
  }
  #reserve(): void {
    if (this.reservedCapacity >= this.#capacity)
      throw new RegistryError("capacity_exhausted", "Loaded host capacity is exhausted");
    if (this.#memoryUsage() >= this.#memoryBytes)
      throw new RegistryError("memory_exhausted", "Daemon RSS memory admission limit is exhausted");
  }
  #serialize<T>(slot: LaunchSlot, operation: () => Promise<T>): Promise<T> {
    const result = slot.lane.then(operation, operation);
    slot.lane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  #required(launchId: string): LaunchSlot {
    const slot = this.#slots.get(launchId);
    if (!slot) throw new RegistryError("launch_not_found", "Launch was not found");
    return slot;
  }
  #fence(slot: LaunchSlot): void {
    slot.fenceEpoch += 1;
    slot.acceptingCommands = false;
    slot.projection?.dispose();
    slot.projection = undefined;
    slot.generation = this.#id();
    slot.admission?.fence();
  }
  #set(slot: LaunchSlot, lifecycle: HostLifecycleState): void {
    slot.lifecycle = lifecycle;
    slot.updatedAt = this.#now();
  }
  #assertInvariants(): void {
    for (const slot of this.#slots.values())
      if (slot.host && !slot.reserved)
        throw new Error("Registry invariant violated: installed host lacks reservation");
  }
  #summary(slot: LaunchSlot): LaunchSummary {
    if (slot.host && !slot.reserved)
      throw new Error("Registry invariant violated: installed host lacks reservation");
    return {
      launchId: slot.launchId,
      lifecycle: slot.lifecycle,
      generation: slot.generation,
      commandEpoch: slot.commandEpoch,
      hostEpoch: slot.hostEpoch,
      ready:
        slot.acceptingCommands &&
        Boolean(slot.host?.state.ready) &&
        (slot.lifecycle === "ready" || slot.lifecycle === "running"),
      createdAt: slot.createdAt,
      updatedAt: slot.updatedAt,
      ...(slot.failureCode ? { failureCode: slot.failureCode } : {}),
    };
  }
}
