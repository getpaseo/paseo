import { resolve } from "node:path";

export function parseGitRevParsePath(stdout: string): string | null {
  // Remove Git's record delimiter, not whitespace belonging to the path.
  const path = stdout.replace(/\r?\n$/, "");
  if (!path || /[\r\n]/.test(path) || path.startsWith("--")) {
    return null;
  }

  return path;
}

export function resolveGitRevParsePath(cwd: string, stdout: string): string | null {
  const parsed = parseGitRevParsePath(stdout);
  return parsed ? resolve(cwd, parsed) : null;
}
