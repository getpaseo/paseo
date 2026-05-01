import { createTerminalManager, type TerminalManager } from "./terminal-manager.js";
import { createWorkerTerminalManager } from "./worker-terminal-manager.js";

export type TerminalBackend = "in-process" | "worker";

export function resolveTerminalBackend(env: NodeJS.ProcessEnv = process.env): TerminalBackend {
  // Default to in-process while the worker rollout bakes. Set
  // HUBCODE_TERMINAL_BACKEND=worker to opt in.
  return env.HUBCODE_TERMINAL_BACKEND === "worker" ? "worker" : "in-process";
}

export function createConfiguredTerminalManager(options?: {
  backend?: TerminalBackend;
}): TerminalManager {
  const backend = options?.backend ?? resolveTerminalBackend();
  if (backend === "worker") {
    return createWorkerTerminalManager();
  }
  return createTerminalManager();
}
