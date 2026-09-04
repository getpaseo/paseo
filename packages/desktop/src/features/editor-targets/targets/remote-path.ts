/**
 * Percent-encode a POSIX path for a remote URI. Each segment is encoded separately so the
 * separators and the leading slash survive, and so a space or `&` in a directory name never
 * reaches a shell as itself.
 */
export function encodeRemotePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
