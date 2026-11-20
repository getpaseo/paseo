import type { AgentFileExplorerState, ExplorerDirectory } from "@/stores/session-store";

export const DIRECTORY_LISTING_INVALIDATED = Symbol("directory-listing-invalidated");
export type DirectoryListingResult =
  | ExplorerDirectory
  | null
  | typeof DIRECTORY_LISTING_INVALIDATED;

type UpdateExplorerState = (
  update: (state: AgentFileExplorerState) => AgentFileExplorerState,
) => AgentFileExplorerState | null;

function pushHistory(history: string[], path: string): string[] {
  const normalizedHistory = history.length === 0 ? ["."] : history;
  return normalizedHistory.at(-1) === path ? normalizedHistory : [...normalizedHistory, path];
}

export async function loadExplorerDirectory({
  path,
  options,
  updateState,
  listDirectory,
  fallbackError,
}: {
  path: string;
  options?: { recordHistory?: boolean; setCurrentPath?: boolean };
  updateState: UpdateExplorerState;
  listDirectory: () => Promise<ExplorerDirectory>;
  fallbackError: string;
}): Promise<DirectoryListingResult> {
  const shouldSetCurrentPath = options?.setCurrentPath ?? true;
  const shouldRecordHistory = options?.recordHistory ?? shouldSetCurrentPath;
  const initial = updateState((state) => ({
    ...state,
    isLoading: true,
    lastError: null,
    pendingRequest: { path, mode: "list" },
    ...(shouldSetCurrentPath
      ? {
          currentPath: path,
          history: shouldRecordHistory ? pushHistory(state.history, path) : state.history,
          lastVisitedPath: path,
        }
      : {}),
  }));
  if (!initial) return null;
  const generation = initial.listingGeneration;
  try {
    const directory = await listDirectory();
    let accepted = false;
    updateState((state) => {
      if (state.listingGeneration !== generation) return state;
      accepted = true;
      const directories = new Map(state.directories);
      directories.set(directory.path, directory);
      return { ...state, directories, isLoading: false, lastError: null, pendingRequest: null };
    });
    return accepted ? directory : DIRECTORY_LISTING_INVALIDATED;
  } catch (error) {
    let invalidated = false;
    updateState((state) => {
      if (state.listingGeneration !== generation) {
        invalidated = true;
        return state;
      }
      return {
        ...state,
        isLoading: false,
        lastError: error instanceof Error ? error.message : fallbackError,
        pendingRequest: null,
      };
    });
    return invalidated ? DIRECTORY_LISTING_INVALIDATED : null;
  }
}

/** Refresh invalidates earlier replies as well as listings of collapsed folders. */
export function invalidateExplorerDirectoryListings(
  updateState: UpdateExplorerState,
  retainedPaths: readonly string[],
): void {
  const retained = new Set(retainedPaths);
  updateState((state) => ({
    ...state,
    listingGeneration: state.listingGeneration + 1,
    directories: new Map([...state.directories].filter(([path]) => retained.has(path))),
    isLoading: false,
    pendingRequest: null,
    lastError: null,
  }));
}
