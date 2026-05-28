/**
 * Shortens a file path by replacing the home directory prefix with ~.
 * Handles both macOS (/Users/username) and Linux (/home/username) paths.
 */
export function shortenPath(path: string | undefined | null): string {
  if (!path) {
    return "";
  }
  return path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
}

/**
 * Like {@link shortenPath} but, when the result is longer than `maxChars`,
 * drops the head and prepends an ellipsis so the meaningful tail (the project /
 * worktree name closest to the cwd) is always visible. Use this for compact
 * list rows where CSS tail-truncation would otherwise hide the only segment
 * that distinguishes one cwd from another.
 */
export function shortenPathTail(path: string | undefined | null, maxChars: number): string {
  const short = shortenPath(path);
  if (short.length <= maxChars) {
    return short;
  }
  const keep = Math.max(maxChars - 1, 1);
  return `…${short.slice(short.length - keep)}`;
}
