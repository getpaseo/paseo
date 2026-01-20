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
