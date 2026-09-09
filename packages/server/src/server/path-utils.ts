import { homedir } from "node:os";
import { isAbsolute, posix, resolve, win32 } from "node:path";

export function assertAbsolutePath(cwd: string): void {
  if (!posix.isAbsolute(cwd) && !win32.isAbsolute(cwd)) {
    throw new Error("cwd must be absolute path");
  }
}

function hasHomePrefix(value: string): boolean {
  return value === "~" || value.startsWith("~/");
}

export function expandUserPath(value: string): string {
  if (hasHomePrefix(value)) {
    return resolve(homedir(), value.slice(2));
  }
  return resolve(value);
}

export function resolvePathFromBase(baseCwd: string, requestedPath: string): string {
  if (hasHomePrefix(requestedPath) || isAbsolute(requestedPath)) {
    return expandUserPath(requestedPath);
  }
  return resolve(baseCwd, requestedPath);
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
