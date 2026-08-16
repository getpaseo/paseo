import type { BoundWorkspaceRuntime } from "../../index.js";

export interface GitCommonObservationCapability {
  observe(listener: () => void): Promise<{ unsubscribe(): Promise<void> }>;
}

const capabilities = new WeakMap<BoundWorkspaceRuntime, GitCommonObservationCapability>();

export function registerGitCommonObservationCapability(
  runtime: BoundWorkspaceRuntime,
  capability: GitCommonObservationCapability,
): void {
  capabilities.set(runtime, capability);
}

export function requireGitCommonObservationCapability(
  runtime: BoundWorkspaceRuntime,
): GitCommonObservationCapability {
  const capability = capabilities.get(runtime);
  if (!capability) throw new Error("Bound workspace runtime cannot observe Git common metadata");
  return capability;
}
