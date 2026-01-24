export interface SelfIdentificationContext {
  cwd?: string;
}

function looksLikePaseoWorktree(cwd?: string): boolean {
  if (!cwd) return false;
  // Simple heuristic: if cwd contains .paseo/worktrees, it's likely a Paseo worktree
  return cwd.includes(".paseo/worktrees") || cwd.includes(".paseo\\worktrees");
}

export function getSelfIdentificationInstructions(
  context?: SelfIdentificationContext
): string {
  const inWorktree = looksLikePaseoWorktree(context?.cwd);

  const lines = [
    "You are running under Paseo, an agent orchestration tool.",
    "You MUST call set_title immediately after understanding the task. Call it exactly once per task—do not repeat.",
  ];

  if (inWorktree) {
    lines.push(
      "You are running inside a Paseo-owned worktree. Call set_branch once (alongside set_title) to name your branch."
    );
  }

  return lines.join("\n");
}
