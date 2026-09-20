import type { ApprovedRootConfig } from "../config/schema.ts";
import {
  approvedRootByAlias,
  revalidateApprovedDirectory,
  resolveApprovedDirectory,
  type PriorTrustPolicy,
  type ResolvedApprovedDirectory,
} from "../config/roots.ts";
import { LaunchRegistry, type LaunchDetail } from "./registry.ts";

export interface LaunchRequest {
  rootAlias: string;
  relativePath: string;
}

export class LocalLaunches {
  constructor(
    readonly registry: LaunchRegistry,
    readonly roots: readonly ApprovedRootConfig[],
    private readonly trust: PriorTrustPolicy,
  ) {}

  rootSummaries(): { alias: string }[] {
    return this.roots.map(({ alias }) => ({ alias }));
  }

  async resolve(request: LaunchRequest): Promise<ResolvedApprovedDirectory> {
    return resolveApprovedDirectory(
      this.roots,
      request.rootAlias,
      request.relativePath,
      this.trust,
    );
  }

  async create(request: LaunchRequest): Promise<LaunchDetail> {
    const resolved = await this.resolve(request);
    const configured = approvedRootByAlias(this.roots, request.rootAlias);
    if (!configured) throw new Error("Resolved approved root disappeared");
    await revalidateApprovedDirectory(configured, request.relativePath, resolved);
    return this.registry.create(resolved.canonicalCwd);
  }
}
