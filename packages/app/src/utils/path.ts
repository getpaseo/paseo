export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Rewrites separators only for a path that is Windows-shaped, meaning it carries a drive letter
 * or a UNC prefix. Everywhere else a backslash is an ordinary file name character, so a POSIX or
 * workspace-relative path is returned untouched.
 */
export function normalizePathSeparators(value: string): string {
  return isWindowsShapedPath(value) ? value.replace(/\\/g, "/") : value;
}

function isWindowsShapedPath(value: string): boolean {
  return value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}
