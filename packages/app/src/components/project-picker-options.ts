import { buildWorkingDirectorySuggestions } from "@/utils/working-directory-suggestions";

export interface BuildProjectPickerOptionsInput {
  recommendedPaths: string[];
  serverPaths: string[];
  query: string;
}

export interface BuildProjectPickerBrowseOptionsInput {
  cwd: string;
  childPaths: string[];
}

export interface ProjectPickerPathOption {
  kind: "path";
  path: string;
}

export interface ProjectPickerSuggestionOption {
  kind: "suggestion";
  path: string;
}

export interface ProjectPickerBrowseRootOption {
  kind: "browse-root";
  path: string;
}

export interface ProjectPickerBrowseCurrentOption {
  kind: "browse-current";
  path: string;
}

export interface ProjectPickerBrowseParentOption {
  kind: "browse-parent";
  path: string;
}

export interface ProjectPickerBrowseDirectoryOption {
  kind: "browse-directory";
  path: string;
}

export type ProjectPickerOption = ProjectPickerPathOption | ProjectPickerSuggestionOption;
export type ProjectPickerBrowseOption =
  | ProjectPickerBrowseCurrentOption
  | ProjectPickerBrowseParentOption
  | ProjectPickerBrowseDirectoryOption;
export type ProjectPickerListOption =
  | ProjectPickerOption
  | ProjectPickerBrowseRootOption
  | ProjectPickerBrowseOption;

export const PROJECT_PICKER_HOME_CWD = "~";

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

export function buildProjectPickerBrowseOptions(
  input: BuildProjectPickerBrowseOptionsInput,
): ProjectPickerBrowseOption[] {
  const cwd = normalizeBrowsePath(input.cwd);
  const options: ProjectPickerBrowseOption[] = [{ kind: "browse-current", path: cwd }];
  const parentPath = getProjectPickerBrowseParentPath(cwd);
  if (parentPath) {
    options.push({ kind: "browse-parent", path: parentPath });
  }

  const seen = new Set<string>(options.map((option) => option.path));
  for (const childPath of input.childPaths) {
    const path = joinProjectPickerBrowsePath(cwd, childPath);
    if (!path || seen.has(path)) {
      continue;
    }
    options.push({ kind: "browse-directory", path });
    seen.add(path);
  }

  return options;
}

export function getProjectPickerBrowseParentPath(cwd: string): string | null {
  const normalized = normalizeBrowsePath(cwd);
  if (normalized === PROJECT_PICKER_HOME_CWD || normalized === "/") {
    return null;
  }

  if (normalized.startsWith(`${PROJECT_PICKER_HOME_CWD}/`)) {
    const parent = normalized.slice(0, normalized.lastIndexOf("/"));
    return parent || PROJECT_PICKER_HOME_CWD;
  }

  const withoutTrailingSlash = normalized.replace(/[\\/]+$/, "");
  const slashIndex = Math.max(
    withoutTrailingSlash.lastIndexOf("/"),
    withoutTrailingSlash.lastIndexOf("\\"),
  );
  if (slashIndex <= 0) {
    return withoutTrailingSlash.startsWith("/") ? "/" : null;
  }

  if (/^[a-zA-Z]:[\\/]/.test(withoutTrailingSlash) && slashIndex <= 2) {
    return withoutTrailingSlash.slice(0, 3);
  }

  return withoutTrailingSlash.slice(0, slashIndex);
}

export function joinProjectPickerBrowsePath(cwd: string, childPath: string): string {
  const normalizedCwd = normalizeBrowsePath(cwd);
  const trimmedChild = childPath.trim();
  if (isOpenableProjectPath(trimmedChild)) {
    return normalizeBrowsePath(trimmedChild);
  }

  const normalizedChild = trimmedChild.replace(/^\.\/+/, "");
  if (!normalizedChild || normalizedChild === ".") {
    return normalizedCwd;
  }

  const cwdTail = getBrowsePathTail(normalizedCwd);
  if (cwdTail && normalizedChild === cwdTail) {
    return normalizedCwd;
  }
  if (cwdTail && normalizedChild.startsWith(`${cwdTail}/`)) {
    const parentPath = getProjectPickerBrowseParentPath(normalizedCwd);
    const basePath = parentPath ?? normalizedCwd;
    const separator = basePath.endsWith("/") || basePath.endsWith("\\") ? "" : "/";
    return `${basePath}${separator}${normalizedChild}`;
  }

  const separator = normalizedCwd.endsWith("/") || normalizedCwd.endsWith("\\") ? "" : "/";
  return `${normalizedCwd}${separator}${normalizedChild}`;
}

function getBrowsePathTail(path: string): string | null {
  const normalized = normalizeBrowsePath(path);
  if (normalized === PROJECT_PICKER_HOME_CWD || normalized === "/") {
    return null;
  }
  const slashIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}

function normalizeBrowsePath(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  return trimmed || PROJECT_PICKER_HOME_CWD;
}
