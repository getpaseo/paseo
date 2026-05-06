import type { TerminalManager } from "./terminal-manager.js";
import { createWorkerTerminalManager } from "./worker-terminal-manager.js";

export function createConfiguredTerminalManager(): TerminalManager {
  return createWorkerTerminalManager();
}
