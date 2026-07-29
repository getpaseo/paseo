import type { ExplorerDirectory, ExplorerEntry } from "@/stores/session-store";
import type { SortOption } from "@/stores/panel-store/state";
import { filterVisibleExplorerEntries } from "./visibility";

export const MAX_AUTO_EXPANDED_DIRECTORY_DEPTH = 5;

export interface ExplorerTreeRow {
  entry: ExplorerEntry;
  depth: number;
}

interface FlattenExplorerTreeInput {
  directories: ReadonlyMap<string, ExplorerDirectory>;
  expandedPaths: ReadonlySet<string>;
  sortOption: SortOption;
  showHiddenFiles: boolean;
}

interface RestoreExpandedDirectoriesInput {
  rootDirectory: ExplorerDirectory;
  persistedExpandedPaths: ReadonlySet<string>;
  showHiddenFiles: boolean;
  requestDirectoryListing: (path: string) => Promise<ExplorerDirectory | null>;
}

interface ReconcileRestoredExpandedPathsInput {
  persistedExpandedPaths: ReadonlySet<string>;
  currentExpandedPaths: ReadonlySet<string>;
  restoredExpandedPaths: string[];
}

export function flattenExplorerTree({
  directories,
  expandedPaths,
  sortOption,
  showHiddenFiles,
}: FlattenExplorerTreeInput): ExplorerTreeRow[] {
  const root = directories.get(".");
  if (!root) {
    return [];
  }

  const rows: ExplorerTreeRow[] = [];
  const pending = rowsForDirectory(root, 0, sortOption, showHiddenFiles).toReversed();

  while (pending.length > 0) {
    const row = pending.pop();
    if (!row) {
      break;
    }
    rows.push(row);

    const entry = row.entry;
    if (entry.kind !== "directory" || !expandedPaths.has(entry.path)) {
      continue;
    }
    const childDirectory = directories.get(entry.path);
    if (!childDirectory) {
      continue;
    }
    const childRows = rowsForDirectory(childDirectory, row.depth + 1, sortOption, showHiddenFiles);
    for (let index = childRows.length - 1; index >= 0; index -= 1) {
      pending.push(childRows[index]);
    }
  }

  return rows;
}

export async function restoreExpandedDirectories({
  rootDirectory,
  persistedExpandedPaths,
  showHiddenFiles,
  requestDirectoryListing,
}: RestoreExpandedDirectoriesInput): Promise<string[]> {
  const restoredPaths = ["."];
  const restoredPathSet = new Set(restoredPaths);
  let parentDirectories = [rootDirectory];

  for (let depth = 1; depth <= MAX_AUTO_EXPANDED_DIRECTORY_DEPTH; depth += 1) {
    const pathsToRequest: string[] = [];
    for (const directory of parentDirectories) {
      const entries = filterVisibleExplorerEntries(directory.entries, showHiddenFiles);
      for (const entry of entries) {
        const isPersistedExpandedDirectory =
          entry.kind === "directory" && persistedExpandedPaths.has(entry.path);
        if (isPersistedExpandedDirectory && !restoredPathSet.has(entry.path)) {
          pathsToRequest.push(entry.path);
          restoredPathSet.add(entry.path);
        }
      }
    }
    if (pathsToRequest.length === 0) {
      break;
    }

    const requestedDirectories = await Promise.all(
      pathsToRequest.map((path) => requestDirectoryListing(path)),
    );
    parentDirectories = [];
    for (const directory of requestedDirectories) {
      if (!directory) {
        continue;
      }
      restoredPaths.push(directory.path);
      parentDirectories.push(directory);
    }
  }

  return restoredPaths;
}

export function reconcileRestoredExpandedPaths({
  persistedExpandedPaths,
  currentExpandedPaths,
  restoredExpandedPaths,
}: ReconcileRestoredExpandedPathsInput): string[] {
  const reconciledPaths = new Set(restoredExpandedPaths);

  for (const path of persistedExpandedPaths) {
    if (!currentExpandedPaths.has(path)) {
      reconciledPaths.delete(path);
    }
  }
  for (const path of currentExpandedPaths) {
    if (!persistedExpandedPaths.has(path)) {
      reconciledPaths.add(path);
    }
  }

  return Array.from(reconciledPaths);
}

function rowsForDirectory(
  directory: ExplorerDirectory,
  depth: number,
  sortOption: SortOption,
  showHiddenFiles: boolean,
): ExplorerTreeRow[] {
  const visibleEntries = filterVisibleExplorerEntries(directory.entries, showHiddenFiles);
  const sortedEntries = sortExplorerEntries(visibleEntries, sortOption);
  return sortedEntries.map((entry) => ({ entry, depth }));
}

function sortExplorerEntries(entries: ExplorerEntry[], sortOption: SortOption): ExplorerEntry[] {
  const sorted = [...entries];
  sorted.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }
    switch (sortOption) {
      case "name":
        return a.name.localeCompare(b.name);
      case "modified":
        return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
      case "size":
        return b.size - a.size;
    }
  });
  return sorted;
}
