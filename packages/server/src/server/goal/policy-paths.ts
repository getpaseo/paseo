/**
 * Whether a repository path is one a goal marked as policy-sensitive (`policyPaths`).
 * A pattern ending in `/` is a directory. `*` matches within one folder and `**` across
 * folders. Any other pattern names a file, or a directory of that name.
 */
export function matchesPolicyPath(path: string, patterns: readonly string[]): boolean {
  const file = normalize(path);
  return patterns.some((pattern) => matchesOne(file, normalize(pattern)));
}

/** The paths among `paths` that match, in the order given. */
export function policyPathsChanged(
  paths: readonly string[],
  patterns: readonly string[],
): string[] {
  return paths.filter((p) => matchesPolicyPath(p, patterns));
}

function normalize(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.?\/+/, "");
}

function matchesOne(file: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return file.startsWith(pattern);
  if (!pattern.includes("*")) return file === pattern || file.startsWith(`${pattern}/`);
  return globToRegExp(pattern).test(file);
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        const slash = pattern[i + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}
