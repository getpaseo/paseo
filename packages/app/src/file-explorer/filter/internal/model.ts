import { describeWorkspaceFilePath } from "@/command-center/workspace-file-search-model";
import { isHiddenExplorerPath } from "@/file-explorer/visibility";

export interface FileFilterResponse {
  /** The query these entries answer. */
  query: string;
  entries: readonly { path: string; kind: "file" | "directory" }[];
}

export interface FileFilterMatch {
  kind: "file" | "directory";
  path: string;
  name: string;
  /** The folder holding the match; empty at the workspace root. */
  directory: string;
}

export type FileFilterView =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string }
  | { status: "results"; matches: FileFilterMatch[] };

/** What the filtered list shows. Earlier matches stay up until the current query answers. */
export function resolveFileFilterView({
  query,
  response,
  error,
  isFetching,
  showHiddenFiles,
}: {
  query: string;
  response: FileFilterResponse | undefined;
  error: string | null;
  isFetching: boolean;
  showHiddenFiles: boolean;
}): FileFilterView {
  const matches = (response?.entries ?? [])
    .filter((entry) => showHiddenFiles || !isHiddenExplorerPath(entry.path))
    .map((entry) => Object.assign(describeWorkspaceFilePath(entry.path), { kind: entry.kind }));
  if (matches.length > 0) return { status: "results", matches };
  if (response?.query === query) return { status: "empty" };
  if (error !== null && !isFetching) return { status: "error", message: error };
  return { status: "loading" };
}
