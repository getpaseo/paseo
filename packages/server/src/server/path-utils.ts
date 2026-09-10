import { homedir } from "node:os";
import { isAbsolute, posix, resolve, sep, win32 } from "node:path";

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

/**
 * Renders a host-relative path the way every workspace-relative identity crosses the wire: this
 * host's separator becomes "/", and every other character survives, so a Unix file name that
 * contains a backslash stays that file rather than becoming a directory on the client.
 */
export function toWorkspaceRelativePath(relative: string): string {
  return relative.split(sep).join("/");
}
