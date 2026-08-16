import type { TerminalManager } from "./terminal-manager.js";
import type { TerminalPtyLaunchInput } from "./terminal.js";
import type { WorkspaceTerminal } from "../server/workspace-runtime/index.js";
import { createWorkerTerminalManager } from "./worker-terminal-manager.js";

export interface ConfiguredTerminalManagerOptions {
  getTerminalActivityUrl?: () => string | null;
  launchPty?: (input: TerminalPtyLaunchInput) => Promise<WorkspaceTerminal | null>;
}

export function createConfiguredTerminalManager(
  options: ConfiguredTerminalManagerOptions = {},
): TerminalManager {
  return createWorkerTerminalManager(options);
}
