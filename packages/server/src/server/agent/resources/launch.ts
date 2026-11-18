import type { ChildProcess } from "node:child_process";

// Kept free of runtime imports: `utils/spawn.ts` and the provider types depend on it,
// and those are compiled by packages that cannot load the resource host code.

/** A provider launch, as far as placing it under resource control is concerned. */
export interface ResourceLaunchTarget {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Handed to a provider through `AgentLaunchContext`. Pass it to `spawnProcess` for
 * every process that belongs to the agent; that is the whole provider contract.
 */
export interface AgentResourceLaunch {
  /** Rewrites a launch so the process starts inside the agent's boundary. */
  wrap(target: ResourceLaunchTarget): ResourceLaunchTarget;
  /** Registers the spawned process. Call synchronously after spawning. */
  attach(child: ChildProcess): void;
}
