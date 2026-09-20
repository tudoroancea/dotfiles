import { RootResolutionError } from "../config/roots.ts";
import { RegistryError } from "../host/registry.ts";

export interface ApiFailure {
  status: number;
  body: { error: { code: string } };
}

export function publicApiFailure(error: unknown): ApiFailure {
  if (error instanceof RootResolutionError) {
    const status = error.code === "unknown_root" || error.code === "missing_directory" ? 404 : 400;
    return { status, body: { error: { code: error.code } } };
  }
  if (error instanceof RegistryError) {
    const status =
      error.code === "launch_not_found"
        ? 404
        : error.code === "capacity_exhausted" ||
            error.code === "memory_exhausted" ||
            error.code === "launch_limit_exhausted"
          ? 409
          : 400;
    return { status, body: { error: { code: error.code } } };
  }
  if (error instanceof SyntaxError || error instanceof TypeError)
    return { status: 400, body: { error: { code: "invalid_request" } } };
  return { status: 500, body: { error: { code: "internal_error" } } };
}
