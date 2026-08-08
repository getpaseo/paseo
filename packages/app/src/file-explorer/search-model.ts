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

export function buildFileSearchRows(result: FileSearchResult): FileSearchRow[] {
  const rows: FileSearchRow[] = [];
  for (const file of result.files) {
    rows.push({
      kind: "file",
      key: `file:${file.path}`,
      path: file.path,
      matchCount: file.matches.length,
    });
    file.matches.forEach((match, index) => {
      rows.push({
        kind: "match",
        key: `match:${file.path}:${match.line}:${match.column}:${index}`,
        path: file.path,
        match,
      });
    });
  }
  return rows;
}
