import type { ExplorerDirectory, ExplorerEntry } from "@/stores/session-store";
import type { SortOption } from "@/stores/panel-store/state";
import { DIRECTORY_LISTING_INVALIDATED, type DirectoryListingResult } from "./directory-listings";
import { filterVisibleExplorerEntries, isHiddenExplorerPath } from "./visibility";

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

type RestoredExpandedPaths = string[] | typeof DIRECTORY_LISTING_INVALIDATED;

interface RestoreExpandedDirectoriesInput {
  rootDirectory: ExplorerDirectory;
  persistedExpandedPaths: ReadonlySet<string>;
  showHiddenFiles: boolean;
  requestDirectoryListing: (path: string) => Promise<DirectoryListingResult>;
}

interface ShowHiddenFilesAndRestoreExpandedDirectoriesInput extends Omit<
  RestoreExpandedDirectoriesInput,
  "showHiddenFiles"
> {
  showHiddenFiles: () => void;
}

interface ReconcileRestoredExpandedPathsInput {
  persistedExpandedPaths: ReadonlySet<string>;
  currentExpandedPaths: ReadonlySet<string>;
  restoredExpandedPaths: RestoredExpandedPaths;
}

interface SetExpandedDirectoryPathInput {
  currentExpandedPaths: readonly string[];
  directoryPath: string;
  expanded: boolean;
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
}: RestoreExpandedDirectoriesInput): Promise<RestoredExpandedPaths> {
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
    if (requestedDirectories.includes(DIRECTORY_LISTING_INVALIDATED))
      return DIRECTORY_LISTING_INVALIDATED;
    parentDirectories = [];
    for (const directory of requestedDirectories) {
      if (!directory || directory === DIRECTORY_LISTING_INVALIDATED) {
        continue;
      }
      restoredPaths.push(directory.path);
      parentDirectories.push(directory);
    }
  }

  return restoredPaths;
}

export function showHiddenFilesAndRestoreExpandedDirectories({
  rootDirectory,
  persistedExpandedPaths,
  showHiddenFiles,
  requestDirectoryListing,
}: ShowHiddenFilesAndRestoreExpandedDirectoriesInput): Promise<RestoredExpandedPaths> {
  showHiddenFiles();
  return restoreExpandedDirectories({
    rootDirectory,
    persistedExpandedPaths,
    showHiddenFiles: true,
    requestDirectoryListing,
  });
}

export function reconcileRestoredExpandedPaths({
  persistedExpandedPaths,
  currentExpandedPaths,
  restoredExpandedPaths,
}: ReconcileRestoredExpandedPathsInput): string[] {
  if (restoredExpandedPaths === DIRECTORY_LISTING_INVALIDATED)
    return Array.from(currentExpandedPaths);
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

export function setExpandedDirectoryPath({
  currentExpandedPaths,
  directoryPath,
  expanded,
}: SetExpandedDirectoryPathInput): string[] {
  const nextPaths = new Set(currentExpandedPaths);
  if (expanded) {
    nextPaths.add(directoryPath);
  } else {
    nextPaths.delete(directoryPath);
  }
  return Array.from(nextPaths);
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

/** Load and expand the path to a directory selected outside the tree. */
export async function revealExplorerDirectory(input: {
  directoryPath: string;
  requestDirectoryListing: (path: string) => Promise<DirectoryListingResult>;
  expandPaths: (paths: string[]) => void;
  showHiddenFiles: () => void;
}): Promise<void> {
  if (isHiddenExplorerPath(input.directoryPath)) input.showHiddenFiles();
  const paths = ["."];
  if (input.directoryPath !== ".") {
    const segments = input.directoryPath.split("/").filter(Boolean);
    for (let length = 1; length <= segments.length; length += 1) {
      paths.push(segments.slice(0, length).join("/"));
    }
  }
  for (const path of paths) {
    const directory = await input.requestDirectoryListing(path);
    if (!directory || directory === DIRECTORY_LISTING_INVALIDATED) return;
  }
  input.expandPaths(paths);
}

/**
 * Files Refresh: re-lists the expanded directories (and the root), and drops the cached
 * listing of every other directory. Expanding a directory only fetches when it has no
 * cached listing, so keeping a collapsed directory's old listing would show it as it was
 * before the refresh.
 */
export async function refreshExplorerDirectories({
  hasWorkspaceScope,
  expandedPaths,
  showHiddenFiles,
  requestDirectoryListing,
  invalidateDirectoryListings,
}: {
  hasWorkspaceScope: boolean;
  expandedPaths: Set<string>;
  showHiddenFiles: boolean;
  requestDirectoryListing: (
    path: string,
    opts?: { recordHistory?: boolean; setCurrentPath?: boolean },
  ) => Promise<DirectoryListingResult>;
  invalidateDirectoryListings: (retainedPaths: readonly string[]) => void;
}): Promise<null> {
  if (!hasWorkspaceScope) {
    return null;
  }
  const directoryPaths = Array.from(expandedPaths).filter(
    (path) => showHiddenFiles || !isHiddenExplorerPath(path),
  );
  if (!directoryPaths.includes(".")) {
    directoryPaths.unshift(".");
  }
  invalidateDirectoryListings(directoryPaths);
  await Promise.all(
    directoryPaths.map((path) =>
      requestDirectoryListing(path, {
        recordHistory: false,
        setCurrentPath: false,
      }),
    ),
  );
  return null;
}
