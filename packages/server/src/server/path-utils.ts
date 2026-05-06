import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

function hasHomePrefix(value: string): boolean {
  return value === "~" || value.startsWith("~/");
}

export function expandUserPath(value: string): string {
  const trimmed = value.trim();
  if (hasHomePrefix(trimmed)) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return resolve(trimmed);
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
