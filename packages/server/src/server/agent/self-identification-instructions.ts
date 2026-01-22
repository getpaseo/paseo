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
    "Immediately after your first message where you understand the task and decide to do multi-step work, call set_title to self-identify. Call it exactly once per task—do not repeat.",
    "Skip set_title in plan/read-only modes or when running a slash command.",
    "Do not call set_title for short, fixed, or single-response requests (e.g., \"say X exactly\", yes/no, one-liners).",
  ];

  if (inWorktree) {
    lines.push(
      "You are running inside a Paseo-owned worktree. Call set_branch once (alongside set_title) to name your branch."
    );
  }

  return lines.join("\n");
}
