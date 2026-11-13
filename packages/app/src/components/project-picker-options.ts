import { buildWorkingDirectorySuggestions } from "@/utils/working-directory-suggestions";

export interface BuildProjectPickerOptionsInput {
  recommendedPaths: string[];
  serverPaths: string[];
  query: string;
  // Set when the query names an existing file: its directory replaces the typed path.
  typedFile?: { parent: string; name: string } | null;
}

export interface ProjectPickerPathOption {
  kind: "path";
  path: string;
}

export interface ProjectPickerSuggestionOption {
  kind: "suggestion";
  path: string;
}

export interface ProjectPickerFileDirectoryOption {
  kind: "file-directory";
  path: string;
  fileName: string;
}

export type ProjectPickerOption =
  | ProjectPickerPathOption
  | ProjectPickerSuggestionOption
  | ProjectPickerFileDirectoryOption;

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

  // A file cannot be opened as a project, so its directory takes the typed path's place.
  if (input.typedFile) {
    const { parent, name } = input.typedFile;
    return [
      { kind: "file-directory", path: parent, fileName: name },
      ...suggestions.filter((suggestion) => suggestion.path !== parent),
    ];
  }

  if (!isOpenableProjectPath(trimmedQuery) || suggestedPaths.includes(trimmedQuery)) {
    return suggestions;
  }

  return [{ kind: "path", path: trimmedQuery }, ...suggestions];
}
