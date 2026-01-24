import type { CheckoutStatusPayload } from "@/hooks/use-checkout-status-query";

/**
 * Derives the branch label to display for an agent.
 * Returns null if there's no branch to show (not a git repo, or on the base branch).
 */
export function deriveBranchLabel(
  checkout: CheckoutStatusPayload | null
): string | null {
  if (!checkout || !checkout.isGit) {
    return null;
  }
  const currentBranch: string | null = checkout.currentBranch ?? null;
  const baseRef: string | null = checkout.baseRef ?? null;
  if (!currentBranch) {
    return null;
  }
  if (baseRef && currentBranch === baseRef) {
    return null;
  }
  return currentBranch;
}

/**
 * Derives the project path to display for an agent.
 * If inside a Paseo worktree, shows just the worktree-relative path.
 * Otherwise uses the repo root or cwd.
 */
export function deriveProjectPath(
  cwd: string,
  checkout: CheckoutStatusPayload | null
): string {
  const basePath = checkout?.isGit ? (checkout.repoRoot ?? cwd) : cwd;
  const worktreeMarker = ".paseo/worktrees/";
  const idx = basePath.indexOf(worktreeMarker);
  if (idx !== -1) {
    const afterMarker = basePath.slice(idx + worktreeMarker.length);
    return afterMarker;
  }
  return basePath;
}
