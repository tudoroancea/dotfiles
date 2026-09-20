import { randomUUID } from "node:crypto";
import { startLocalApi, type StartedLocalApi } from "./api/server.ts";
import type { PriorTrustPolicy } from "./config/roots.ts";
import type { DaemonConfig } from "./config/schema.ts";
import { LocalLaunches } from "./host/launches.ts";
import { LaunchRegistry, type SessionHostFactory } from "./host/registry.ts";

export * from "./api/index.ts";
export * from "./config/index.ts";
export * from "./host/launches.ts";
export * from "./host/registry.ts";
export * from "./host/session-host.ts";
export type { ProjectionAttachment } from "./projection/live-projection.ts";

export interface RemoteSessionDaemonOptions {
  config: DaemonConfig;
  hostFactory: SessionHostFactory;
  priorTrust: PriorTrustPolicy;
  daemonId?: string;
}

export interface RemoteSessionDaemon {
  api: StartedLocalApi;
  registry: LaunchRegistry;
  launches: LocalLaunches;
  stop(): Promise<void>;
}

export async function startRemoteSessionDaemon(
  options: RemoteSessionDaemonOptions,
): Promise<RemoteSessionDaemon> {
  const registry = new LaunchRegistry({
    capacity: options.config.limits.loadedHosts,
    totalLaunches: options.config.limits.totalLaunches,
    memoryBytes: options.config.limits.memoryBytes,
    queueCount: options.config.limits.queueCount,
    queueBytes: options.config.limits.queueBytes,
    hostFactory: options.hostFactory,
  });
  const launches = new LocalLaunches(registry, options.config.approvedRoots, options.priorTrust);
  const api = await startLocalApi({
    config: options.config,
    launches,
    daemonId: options.daemonId ?? randomUUID(),
  });
  let sweeping = false;
  const sweep = setInterval(
    () => {
      if (sweeping) return;
      sweeping = true;
      void registry.unloadIdle(options.config.limits.idleUnloadMs).finally(() => {
        sweeping = false;
      });
    },
    Math.min(options.config.limits.idleUnloadMs, 60_000),
  );
  sweep.unref();
  let stopPromise: Promise<void> | undefined;
  return {
    api,
    registry,
    launches,
    stop() {
      stopPromise ??= (async () => {
        clearInterval(sweep);
        const results = await Promise.allSettled([api.close(), registry.stopAll()]);
        const errors = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (errors.length)
          throw new AggregateError(
            errors.map((result) => result.reason),
            "Daemon shutdown failed",
          );
      })();
      return stopPromise;
    },
  };
}

export const startDaemon = startRemoteSessionDaemon;
