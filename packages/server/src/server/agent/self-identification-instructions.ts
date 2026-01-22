export function getSelfIdentificationInstructions(): string {
  return [
    "Once you understand the task and are about to execute multi-step work (e.g., edits, tests, or repo changes), call set_title and set_branch exactly once to self-identify.",
    "Skip these calls in plan/read-only modes or when running a slash command.",
    "Do not call set_title or set_branch for short, fixed, or single-response requests (e.g., “say X exactly”, yes/no, one-liners).",
    "Only call set_branch when you are certain you are running inside a Paseo-owned worktree under .paseo/worktrees.",
    "If set_branch fails due to permissions or not being in a Paseo worktree, do not retry.",
  ].join("\n");
}
