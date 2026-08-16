import type { BoundWorkspaceRuntime } from "../index.js";
import { requireGitCommonObservationCapability } from "./internal/capability.js";

/** Observe metadata shared by Git worktrees without exposing its runtime placement. */
export function observeGitCommonMetadata(
  runtime: BoundWorkspaceRuntime,
  listener: () => void,
): Promise<{ unsubscribe(): Promise<void> }> {
  return requireGitCommonObservationCapability(runtime).observe(listener);
}
