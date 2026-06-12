import { buildWorkingDirectorySuggestions } from "@/utils/working-directory-suggestions";

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
  const trimmedQuery = query.trim();
  return (
    trimmedQuery.startsWith("/") ||
    trimmedQuery.startsWith("~") ||
    trimmedQuery.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(trimmedQuery)
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
  const trimmedQuery = input.query.trim();

  if (!isOpenableProjectPath(trimmedQuery) || suggestedPaths.includes(trimmedQuery)) {
    return suggestions;
  }

  return [{ kind: "path", path: trimmedQuery }, ...suggestions];
}
