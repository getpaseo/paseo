import type { WorkspaceRuntimeDriver } from "../drivers/index.js";
import type { WorkspaceRuntimeJsonValue } from "../index.js";
import { createCommandRuntime } from "./internal/command-runtime.js";
export { isWorkspaceRuntimeRegistrationError } from "./internal/command-runtime.js";

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
  daemonAuthenticationConfigured: boolean,
): WorkspaceRuntimeDriver {
  return createCommandRuntime(
    runtimeId,
    config,
    runtimeInstanceId,
    packageResolutionBase,
    pathResolutionBase,
    daemonAuthenticationConfigured,
  );
}
