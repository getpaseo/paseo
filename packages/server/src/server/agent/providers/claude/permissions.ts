import type { AgentMode } from "../../agent-sdk-types.js";

export const CLAUDE_ROOT_BYPASS_DISABLED_REASON =
  "Claude Code does not allow bypassing permissions when Paseo runs as root.";

export function isRunningAsRoot(): boolean {
  return process.getuid?.() === 0;
}

export function applyClaudeRuntimeModeAvailability(
  modes: AgentMode[],
  runningAsRoot = isRunningAsRoot(),
): AgentMode[] {
  if (!runningAsRoot) {
    return modes;
  }
  return modes.map((mode) =>
    mode.id === "bypassPermissions"
      ? { ...mode, disabledReason: CLAUDE_ROOT_BYPASS_DISABLED_REASON }
      : mode,
  );
}
