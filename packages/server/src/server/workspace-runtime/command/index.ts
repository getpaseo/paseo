import type { WorkspaceRuntimeDriver } from "../drivers/index.js";
import type { WorkspaceRuntimeJsonValue } from "../index.js";
import { createCommandRuntime } from "./internal/command-runtime.js";

export interface CommandRuntimeAdapterConfig {
  command: readonly [string, ...string[]];
  options?: Readonly<Record<string, WorkspaceRuntimeJsonValue>>;
}

export function createCommandRuntimeAdapter(
  runtimeId: string,
  config: CommandRuntimeAdapterConfig,
  runtimeInstanceId: string,
  packageResolutionBase: string,
  pathResolutionBase: string,
): WorkspaceRuntimeDriver {
  return createCommandRuntime(
    runtimeId,
    config,
    runtimeInstanceId,
    packageResolutionBase,
    pathResolutionBase,
  );
}
