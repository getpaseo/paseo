import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore, type AgentFileExplorerState } from "@/stores/session-store";
import { usePanelStore } from "@/stores/panel-store";
import { revealExplorerDirectory, revealExplorerEntry } from "@/file-explorer/tree";
import { useExplorerRevealStore } from "@/file-explorer/reveal-request";
import { clearFileFilter } from "@/file-explorer/filter";
import {
  loadExplorerDirectory,
  type DirectoryListingResult,
  invalidateExplorerDirectoryListings,
} from "@/file-explorer/directory-listings";
import { parentExplorerPath } from "@/utils/explorer-paths";

function createExplorerState(): AgentFileExplorerState {
  return {
    listingGeneration: 0,
    directories: new Map(),
    isLoading: false,
    lastError: null,
    pendingRequest: null,
    currentPath: ".",
    history: ["."],
    lastVisitedPath: ".",
    selectedEntryPath: null,
  };
}

export interface FileExplorerWorkspaceScope {
  workspaceId?: string | null;
  workspaceRoot?: string | null;
}

function normalizeWorkspaceValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildWorkspaceExplorerStateKey(scope: FileExplorerWorkspaceScope): string | null {
  const normalizedWorkspaceId = normalizeWorkspaceValue(scope.workspaceId);
  if (normalizedWorkspaceId) {
    return `workspace:${normalizedWorkspaceId}`;
  }
  const normalizedWorkspaceRoot = normalizeWorkspaceValue(scope.workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    return null;
  }
  return `root:${normalizedWorkspaceRoot}`;
}

export function useFileExplorerActions(params: { serverId: string } & FileExplorerWorkspaceScope) {
  const { t } = useTranslation();
  const { serverId, workspaceId, workspaceRoot } = params;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const setFileExplorer = useSessionStore((state) => state.setFileExplorer);
  const normalizedWorkspaceRoot = useMemo(
    () => normalizeWorkspaceValue(workspaceRoot),
    [workspaceRoot],
  );
  const workspaceStateKey = useMemo(
    () =>
      buildWorkspaceExplorerStateKey({
        workspaceId,
        workspaceRoot: normalizedWorkspaceRoot,
      }),
    [workspaceId, normalizedWorkspaceRoot],
  );

  const updateExplorerState = useCallback(
    (
      updater: (prev: AgentFileExplorerState) => AgentFileExplorerState,
    ): AgentFileExplorerState | null => {
      if (!workspaceStateKey) {
        return null;
      }
      let updated: AgentFileExplorerState | null = null;
      setFileExplorer(serverId, (prev) => {
        const next = new Map(prev);
        const current = next.get(workspaceStateKey) ?? createExplorerState();
        updated = updater(current);
        next.set(workspaceStateKey, updated);
        return next;
      });
      return updated;
    },
    [serverId, setFileExplorer, workspaceStateKey],
  );

  const requestDirectoryListing = useCallback(
    async (
      path: string,
      options?: { recordHistory?: boolean; setCurrentPath?: boolean },
    ): Promise<DirectoryListingResult> => {
      if (!workspaceStateKey) {
        return null;
      }
      const normalizedPath = path && path.length > 0 ? path : ".";
      return loadExplorerDirectory({
        path: normalizedPath,
        options,
        updateState: updateExplorerState,
        fallbackError: t("workspace.fileExplorer.errors.failedToListDirectory"),
        listDirectory: async () => {
          if (!normalizedWorkspaceRoot)
            throw new Error(t("workspace.fileExplorer.states.unavailable"));
          if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
          return client.listDirectory(normalizedWorkspaceRoot, normalizedPath);
        },
      });
    },
    [client, normalizedWorkspaceRoot, t, updateExplorerState, workspaceStateKey],
  );

  const showHiddenFiles = useCallback(() => {
    const panel = usePanelStore.getState();
    if (!panel.explorerShowHiddenFiles) panel.toggleExplorerShowHiddenFiles();
  }, []);

  const expandPaths = useCallback(
    (paths: string[]) => {
      if (!workspaceStateKey) return;
      usePanelStore
        .getState()
        .setExpandedPathsForWorkspace(workspaceStateKey, (current) =>
          Array.from(new Set([...current, ...paths])),
        );
    },
    [workspaceStateKey],
  );

  const revealDirectory = useCallback(
    async (directoryPath: string) => {
      if (!workspaceStateKey) return;
      await revealExplorerDirectory({
        directoryPath,
        requestDirectoryListing,
        showHiddenFiles,
        expandPaths,
      });
      clearFileFilter(workspaceStateKey);
    },
    [expandPaths, requestDirectoryListing, showHiddenFiles, workspaceStateKey],
  );

  const selectExplorerEntry = useCallback(
    (path: string | null) => {
      updateExplorerState((state) => ({
        ...state,
        selectedEntryPath: path,
      }));
    },
    [updateExplorerState],
  );

  /** Expands to an entry, selects it, and asks the tree to scroll to it. */
  const revealEntry = useCallback(
    async (entryPath: string): Promise<boolean> => {
      if (!workspaceStateKey) return false;
      const found = await revealExplorerEntry({
        entryPath,
        requestDirectoryListing: (path) =>
          requestDirectoryListing(path, { recordHistory: false, setCurrentPath: false }),
        showHiddenFiles,
        expandPaths,
      });
      if (found) {
        clearFileFilter(workspaceStateKey);
        selectExplorerEntry(entryPath);
        useExplorerRevealStore.getState().request(workspaceStateKey, entryPath);
      }
      return found;
    },
    [expandPaths, requestDirectoryListing, selectExplorerEntry, showHiddenFiles, workspaceStateKey],
  );

  const requestFileDownloadToken = useCallback(
    async (path: string, root: string | null = normalizedWorkspaceRoot) => {
      if (!root) {
        throw new Error(t("workspace.fileExplorer.states.unavailable"));
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.requestDownloadToken(root, path);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, t],
  );

  const requestFileBytes = useCallback(
    async (path: string, maxBytes: number, root: string | null = normalizedWorkspaceRoot) => {
      if (!root) {
        throw new Error(t("workspace.fileExplorer.states.unavailable"));
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      // No request timeout: a large file over a slow relay legitimately takes longer than the
      // 60 s default, and a dead connection still rejects on disconnect.
      return client.readFile(root, path, undefined, maxBytes, 0);
    },
    [client, normalizedWorkspaceRoot, t],
  );

  const createEntry = useCallback(
    async (input: { parentPath: string; name: string; kind: "file" | "directory" }) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const payload = await client.createFileEntry({
        cwd: normalizedWorkspaceRoot,
        ...input,
      });
      if (payload.success) {
        await requestDirectoryListing(input.parentPath, {
          recordHistory: false,
          setCurrentPath: false,
        });
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, requestDirectoryListing],
  );

  const renameEntry = useCallback(
    async (input: { path: string; name: string }) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const payload = await client.renameFileEntry({
        cwd: normalizedWorkspaceRoot,
        ...input,
      });
      if (payload.success) {
        await requestDirectoryListing(parentExplorerPath(input.path), {
          recordHistory: false,
          setCurrentPath: false,
        });
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, requestDirectoryListing],
  );

  const duplicateEntry = useCallback(
    async (path: string) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const payload = await client.duplicateFileEntry({ cwd: normalizedWorkspaceRoot, path });
      if (payload.success) {
        await requestDirectoryListing(parentExplorerPath(path), {
          recordHistory: false,
          setCurrentPath: false,
        });
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, requestDirectoryListing],
  );

  const deleteEntry = useCallback(
    async (path: string) => {
      if (!client || !normalizedWorkspaceRoot) {
        return null;
      }
      const payload = await client.deleteFileEntry({ cwd: normalizedWorkspaceRoot, path });
      if (payload.success) {
        await requestDirectoryListing(parentExplorerPath(path), {
          recordHistory: false,
          setCurrentPath: false,
        });
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, requestDirectoryListing],
  );

  const invalidateDirectoryListings = useCallback(
    (retainedPaths: readonly string[]) =>
      invalidateExplorerDirectoryListings(updateExplorerState, retainedPaths),
    [updateExplorerState],
  );

  return {
    workspaceStateKey,
    revealDirectory,
    revealEntry,
    requestDirectoryListing,
    invalidateDirectoryListings,
    requestFileDownloadToken,
    requestFileBytes,
    createEntry,
    renameEntry,
    duplicateEntry,
    deleteEntry,
    selectExplorerEntry,
  };
}
