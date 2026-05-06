import { resolve } from "node:path";

export function parseGitRevParsePath(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  const lines = trimmed.split(/\r?\n/);
  if (lines.length !== 1) {
    return null;
  }

  const path = lines[0]?.trim() ?? "";
  if (!path || path.startsWith("--")) {
    return null;
  }

  return path;
}

export function resolveGitRevParsePath(cwd: string, stdout: string): string | null {
  const parsed = parseGitRevParsePath(stdout);
  return parsed ? resolve(cwd, parsed) : null;
}
