import { delimiter, join } from "node:path";

/**
 * Prepend a directory to a PATH-style value, deduplicating if already present.
 */
export function prependEnvPath(existing: string | undefined, value: string): string {
  const parts = (existing ?? "").split(delimiter).filter(Boolean);
  if (parts.includes(value)) {
    return parts.join(delimiter);
  }
  return [value, ...parts].join(delimiter);
}

/**
 * Find the actual case-sensitive key in a plain object that matches the given
 * key case-insensitively. On Windows, `{...process.env}` produces a plain
 * (case-sensitive) object where PATH is typically stored as `Path`. Using a
 * hardcoded `"PATH"` would miss the existing key and create a duplicate,
 * breaking the child process's PATH.
 *
 * Exact matches win. The exact check scans `Object.keys` rather than using
 * the `in` operator, which is itself case-insensitive on Windows's
 * `process.env` and would defeat the purpose.
 */
export function findEnvKey(env: NodeJS.ProcessEnv, key: string): string {
  const keys = Object.keys(env);
  if (keys.includes(key)) {
    return key;
  }
  const lower = key.toLowerCase();
  for (const k of keys) {
    if (k.toLowerCase() === lower) return k;
  }
  return key;
}

/**
 * Env overlay that lets commands configured in a repo's paseo.json (worktree
 * setup/teardown, scripts, worktree terminals) resolve locally installed CLI
 * tools the way `npm run` does, by prepending `<cwd>/node_modules/.bin` to
 * PATH. Without this, bare devDependency binaries like `cross-env` only
 * resolve when the daemon itself happened to be started from an npm script.
 *
 * The overlay key mirrors the base env's existing PATH key so merging never
 * creates a `Path`/`PATH` duplicate on Windows. The bin directory is added
 * without an existence check: setup envs are built before `npm ci` runs, and
 * a nonexistent PATH entry is harmless. Deliberately cwd-only — npm-style
 * ancestor directory collection could pull unrelated outer projects into the
 * env of a worktree.
 */
export function repoCommandBinPathOverlay(
  cwd: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const key = findEnvKey(baseEnv, "PATH");
  return { [key]: prependEnvPath(baseEnv[key], join(cwd, "node_modules", ".bin")) };
}
