import type { TerminalManager } from "./terminal-manager.js";
import { createWorkerTerminalManager } from "./worker-terminal-manager.js";

export interface ConfiguredTerminalManagerOptions {
  getTerminalActivityUrl?: () => string | null;
  scrollbackLines?: number;
}

export function createConfiguredTerminalManager(
  options: ConfiguredTerminalManagerOptions = {},
): TerminalManager {
  return createWorkerTerminalManager(options);
}
