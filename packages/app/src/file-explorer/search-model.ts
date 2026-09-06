import type { FileSearchInput, FileSearchResult } from "@getpaseo/client/internal/daemon-client";

export type FileSearchOptions = Pick<
  FileSearchInput,
  "caseSensitive" | "wholeWord" | "useRegex" | "includePattern" | "excludePattern"
>;

export const DEFAULT_FILE_SEARCH_OPTIONS: FileSearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  useRegex: false,
  includePattern: undefined,
  excludePattern: undefined,
};

export type FileSearchState =
  | { status: "idle"; requestKey: 0 }
  | { status: "loading"; requestKey: number }
  | { status: "success"; requestKey: number; result: FileSearchResult }
  | { status: "error"; requestKey: number; error: string };

export type FileSearchAction =
  | { type: "reset" }
  | { type: "start"; requestKey: number }
  | { type: "success"; requestKey: number; result: FileSearchResult }
  | { type: "error"; requestKey: number; error: string };

export type FileSearchRow =
  | { kind: "file"; key: string; path: string; matchCount: number }
  | {
      kind: "match";
      key: string;
      path: string;
      match: FileSearchResult["files"][number]["matches"][number];
    };

export interface FileSearchMatchContent {
  prefix: string;
  match: string;
  suffix: string;
}

export function createInitialFileSearchState(): FileSearchState {
  return { status: "idle", requestKey: 0 };
}

export function fileSearchReducer(
  state: FileSearchState,
  action: FileSearchAction,
): FileSearchState {
  if (action.type === "reset") return createInitialFileSearchState();
  if (action.type === "start") return { status: "loading", requestKey: action.requestKey };
  if (action.requestKey !== state.requestKey) return state;
  if (action.type === "success") {
    return { status: "success", requestKey: action.requestKey, result: action.result };
  }
  return { status: "error", requestKey: action.requestKey, error: action.error };
}

export function splitFileSearchMatchContent(
  match: FileSearchResult["files"][number]["matches"][number],
): FileSearchMatchContent {
  const snippetStartColumn = match.lineContentStartColumn ?? 1;
  const matchStart = Math.max(0, match.column - snippetStartColumn);
  const matchEnd = Math.min(match.lineContent.length, matchStart + match.matchLength);
  return {
    prefix: match.lineContent.slice(0, matchStart),
    match: match.lineContent.slice(matchStart, matchEnd),
    suffix: match.lineContent.slice(matchEnd),
  };
}

export function areAllFileSearchGroupsCollapsed(
  filePaths: readonly string[],
  collapsedPaths: ReadonlySet<string>,
): boolean {
  return filePaths.length > 0 && filePaths.every((path) => collapsedPaths.has(path));
}

export function toggleAllFileSearchGroups(
  filePaths: readonly string[],
  collapsedPaths: ReadonlySet<string>,
): ReadonlySet<string> {
  return areAllFileSearchGroupsCollapsed(filePaths, collapsedPaths)
    ? new Set()
    : new Set(filePaths);
}

export function filterCollapsedFileSearchRows(
  rows: readonly FileSearchRow[],
  collapsedPaths: ReadonlySet<string>,
): FileSearchRow[] {
  const visibleRows: FileSearchRow[] = [];
  for (const row of rows) {
    if (row.kind === "file" || !collapsedPaths.has(row.path)) visibleRows.push(row);
  }
  return visibleRows;
}

export function buildFileSearchRows(result: FileSearchResult): FileSearchRow[] {
  const rows: FileSearchRow[] = [];
  for (const file of result.files) {
    rows.push({
      kind: "file",
      key: `file:${file.path}`,
      path: file.path,
      matchCount: file.matches.length,
    });
    for (const [index, match] of file.matches.entries()) {
      rows.push({
        kind: "match",
        key: `match:${file.path}:${match.line}:${match.column}:${index}`,
        path: file.path,
        match,
      });
    }
  }
  return rows;
}
