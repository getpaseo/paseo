/**
 * Path utilities for cwd filtering in agent commands.
 */

/**
 * Check if `candidatePath` is the same directory as `basePath` or a descendant of it.
 *
 * Handles both Unix (/) and Windows (\) path separators, including mixed separators.
 * This is important because agent cwd paths come from the agent's OS (could be Windows)
 * while the CLI filter path comes from the user (could also be Windows or Unix).
 */
export function isSameOrDescendantPath(basePath: string, candidatePath: string): boolean {
  // Normalize both paths: replace all backslashes with forward slashes, strip trailing separator
  let normalizedBase = basePath.replace(/\\/g, "/").replace(/\/$/, "");
  let normalizedCandidate = candidatePath.replace(/\\/g, "/").replace(/\/$/, "");

  // Windows paths are case-insensitive — detect by drive letter prefix (e.g. "C:/")
  if (/^[a-zA-Z]:\//.test(normalizedBase) || /^[a-zA-Z]:\//.test(normalizedCandidate)) {
    normalizedBase = normalizedBase.toLowerCase();
    normalizedCandidate = normalizedCandidate.toLowerCase();
  }

  return (
    normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(normalizedBase + "/")
  );
}
