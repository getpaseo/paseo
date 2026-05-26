/**
 * Shared worktree slug extraction and display logic.
 *
 * Paseo worktrees live under $PASEO_HOME/worktrees/<projectHash>/<slug>.
 * This utility ONLY recognizes that canonical path pattern — it never returns
 * a bare "last path component" to avoid false positives on regular directories.
 */

/**
 * Extract the worktree slug from a path that follows the canonical pattern:
 *   .../worktrees/<projectHash>/<slug>[/...]
 *
 * Returns null for any path that does not contain the /worktrees/ marker
 * with both a hash and slug component following it.
 *
 * Handles both POSIX and Windows path separators.
 */
export function extractWorktreeSlug(path: string | undefined | null): string | null {
  if (!path) {
    return null;
  }
  const normalized = path.trim().replace(/\\/g, "/");
  if (!normalized) {
    return null;
  }

  const marker = "/worktrees/";
  const index = normalized.indexOf(marker);
  if (index === -1) {
    return null;
  }

  const after = normalized.slice(index + marker.length);
  const parts = after.split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const slug = parts[1];
  return slug.length > 0 ? slug : null;
}

/**
 * Determine whether a worktree slug should be shown alongside a branch name.
 * Returns false when the slug is null, empty, or identical to the branch name
 * (case-sensitive) to avoid redundant display.
 */
export function shouldShowWorktreeSlug(slug: string | null, branchName: string | null): boolean {
  if (!slug || slug.length === 0) {
    return false;
  }
  if (!branchName || branchName.length === 0) {
    return true;
  }
  return slug !== branchName;
}
