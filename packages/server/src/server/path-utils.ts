import { homedir } from "node:os";
import { isAbsolute, posix, resolve, win32 } from "node:path";

export interface ExpandUserPathOptions {
  cwd?: string;
  homeDir?: string;
}

export function assertAbsolutePath(cwd: string): void {
  if (!posix.isAbsolute(cwd) && !win32.isAbsolute(cwd)) {
    throw new Error("cwd must be absolute path");
  }
}

function hasHomePrefix(value: string): boolean {
  return (
    value === "~" ||
    value.startsWith("~/") ||
    (process.platform === "win32" && value.startsWith("~\\"))
  );
}

export function expandUserPath(value: string, options: ExpandUserPathOptions = {}): string {
  const trimmed = value.trim();
  if (hasHomePrefix(trimmed)) {
    return resolve(options.homeDir ?? homedir(), trimmed === "~" ? "" : trimmed.slice(2));
  }
  return resolve(options.cwd ?? process.cwd(), trimmed);
}

export function resolvePathFromBase(baseCwd: string, requestedPath: string): string {
  const trimmed = requestedPath.trim();
  if (hasHomePrefix(trimmed) || isAbsolute(trimmed)) {
    return expandUserPath(trimmed);
  }
  return resolve(baseCwd, trimmed);
}

export function isSameOrDescendantPath(basePath: string, candidatePath: string): boolean {
  let normalizedBase = basePath.replace(/\\/g, "/").replace(/\/$/, "");
  let normalizedCandidate = candidatePath.replace(/\\/g, "/").replace(/\/$/, "");

  if (/^[a-zA-Z]:\//.test(normalizedBase) || /^[a-zA-Z]:\//.test(normalizedCandidate)) {
    normalizedBase = normalizedBase.toLowerCase();
    normalizedCandidate = normalizedCandidate.toLowerCase();
  }

  return (
    normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(normalizedBase + "/")
  );
}
