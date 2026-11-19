import { shortenPath } from "@/utils/shorten-path";
import {
  buildWorkingDirectorySuggestions,
  normalizeDirectoryQuery,
} from "@/utils/working-directory-suggestions";

export interface BuildProjectPickerOptionsInput {
  recommendedPaths: string[];
  serverPaths: string[];
  query: string;
}

export interface ProjectPickerPathOption {
  kind: "path";
  path: string;
}

export interface ProjectPickerSuggestionOption {
  kind: "suggestion";
  path: string;
}

export type ProjectPickerOption = ProjectPickerPathOption | ProjectPickerSuggestionOption;

// Matches the daemon's filesystem semantics, not the client's: POSIX absolute,
// tilde, Windows drive letter (C:\ or C:/), or UNC (\\server\share).
export function isOpenableProjectPath(query: string): boolean {
  const normalizedQuery = normalizeDirectoryQuery(query);
  return (
    normalizedQuery.startsWith("/") ||
    normalizedQuery === "~" ||
    normalizedQuery.startsWith("~/") ||
    normalizedQuery.startsWith("~\\") ||
    normalizedQuery.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(normalizedQuery)
  );
}

export function buildProjectPickerOptions(
  input: BuildProjectPickerOptionsInput,
): ProjectPickerOption[] {
  const suggestedPaths = buildWorkingDirectorySuggestions(input);
  const suggestions = suggestedPaths.map<ProjectPickerSuggestionOption>((path) => ({
    kind: "suggestion",
    path,
  }));
  const normalizedQuery = normalizeDirectoryQuery(input.query);

  if (!isOpenableProjectPath(normalizedQuery)) {
    return suggestions;
  }

  const queryIdentity = pathIdentity(normalizedQuery);
  if (suggestedPaths.some((path) => pathIdentity(path) === queryIdentity)) {
    return suggestions;
  }

  return [{ kind: "path", path: normalizedQuery }, ...suggestions];
}

export function formatDirectoryCompletion(path: string, currentQuery: string): string {
  const trimmedPath = normalizeDirectoryQuery(path);
  if (!trimmedPath) return "";
  const keepAbsolute = currentQuery.trim().startsWith("/");
  const display = keepAbsolute ? trimmedPath : shortenPath(trimmedPath);
  const separator = display.includes("\\") && !display.includes("/") ? "\\" : "/";
  return display.endsWith("/") || display.endsWith("\\") ? display : `${display}${separator}`;
}

function pathIdentity(value: string): string {
  const normalized = shortenPath(normalizeDirectoryQuery(value))
    .replace(/\\/g, "/")
    .replace(/\/+$/u, "");
  if (!normalized) return "/";
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}
