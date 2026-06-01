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
 *
 * The cut snaps to the first `/` at or after the raw budget boundary so the
 * result reads as `…/segment/...` rather than splitting mid-component. When
 * the last segment alone exceeds the budget the snap can't find a separator
 * and we fall back to a raw character slice.
 */
export function shortenPathTail(path: string | undefined | null, maxChars: number): string {
  const short = shortenPath(path);
  if (short.length <= maxChars) {
    return short;
  }
  const keep = Math.max(maxChars - 1, 1);
  const rawStart = short.length - keep;
  const slashStart = short.indexOf("/", rawStart);
  const start = slashStart >= 0 && slashStart < short.length - 1 ? slashStart : rawStart;
  return `…${short.slice(start)}`;
}
