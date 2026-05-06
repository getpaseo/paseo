import { useCallback, useMemo } from "react";
import { useSessionStore, type AgentFileExplorerState } from "@/stores/session-store";
import { explorerFileFromReadResult } from "@/file-explorer/read-result";

function createExplorerState(): AgentFileExplorerState {
  return {
    directories: new Map(),
    files: new Map(),
    isLoading: false,
    lastError: null,
    pendingRequest: null,
    currentPath: ".",
    history: ["."],
    lastVisitedPath: ".",
    selectedEntryPath: null,
  };
}

function pushHistory(history: string[], path: string): string[] {
  const normalizedHistory = history.length === 0 ? ["."] : history;
  const last = normalizedHistory[normalizedHistory.length - 1];
  if (last === path) {
    return normalizedHistory;
  }
  return [...normalizedHistory, path];
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
    (updater: (prev: AgentFileExplorerState) => AgentFileExplorerState) => {
      if (!workspaceStateKey) {
        return;
      }
      setFileExplorer(serverId, (prev) => {
        const next = new Map(prev);
        const current = next.get(workspaceStateKey) ?? createExplorerState();
        next.set(workspaceStateKey, updater(current));
        return next;
      });
    },
    [serverId, setFileExplorer, workspaceStateKey],
  );

  const requestDirectoryListing = useCallback(
    async (
      path: string,
      options?: { recordHistory?: boolean; setCurrentPath?: boolean },
    ): Promise<boolean> => {
      if (!workspaceStateKey) {
        return false;
      }
      const normalizedPath = path && path.length > 0 ? path : ".";
      const shouldSetCurrentPath = options?.setCurrentPath ?? true;
      const shouldRecordHistory = options?.recordHistory ?? shouldSetCurrentPath;

      updateExplorerState((state) => ({
        ...state,
        isLoading: true,
        lastError: null,
        pendingRequest: { path: normalizedPath, mode: "list" },
        ...(shouldSetCurrentPath
          ? {
              currentPath: normalizedPath,
              history: shouldRecordHistory
                ? pushHistory(state.history, normalizedPath)
                : state.history,
              lastVisitedPath: normalizedPath,
            }
          : {}),
      }));

      if (!normalizedWorkspaceRoot) {
        updateExplorerState((state) => ({
          ...state,
          isLoading: false,
          lastError: "Workspace is unavailable",
          pendingRequest: null,
        }));
        return false;
      }

      if (!client) {
        updateExplorerState((state) => ({
          ...state,
          isLoading: false,
          lastError: "Host is not connected",
          pendingRequest: null,
        }));
        return false;
      }

      try {
        const directory = await client.listDirectory(normalizedWorkspaceRoot, normalizedPath);
        updateExplorerState((state) => {
          const nextState: AgentFileExplorerState = {
            ...state,
            isLoading: false,
            lastError: null,
            pendingRequest: null,
            directories: state.directories,
            files: state.files,
          };

          const directories = new Map(state.directories);
          directories.set(directory.path, directory);
          nextState.directories = directories;

          return nextState;
        });
        return true;
      } catch (error) {
        updateExplorerState((state) => ({
          ...state,
          isLoading: false,
          lastError: error instanceof Error ? error.message : "Failed to list directory",
          pendingRequest: null,
        }));
        return false;
      }
    },
    [client, normalizedWorkspaceRoot, updateExplorerState, workspaceStateKey],
  );

  const requestFilePreview = useCallback(
    async (path: string) => {
      if (!workspaceStateKey) {
        return;
      }
      const normalizedPath = path && path.length > 0 ? path : ".";
      updateExplorerState((state) => ({
        ...state,
        isLoading: true,
        lastError: null,
        pendingRequest: { path: normalizedPath, mode: "file" },
      }));

      if (!normalizedWorkspaceRoot) {
        updateExplorerState((state) => ({
          ...state,
          isLoading: false,
          lastError: "Workspace is unavailable",
          pendingRequest: null,
        }));
        return;
      }

      if (!client) {
        updateExplorerState((state) => ({
          ...state,
          isLoading: false,
          lastError: "Host is not connected",
          pendingRequest: null,
        }));
        return;
      }

      try {
        const file = await client.readFile(normalizedWorkspaceRoot, normalizedPath);
        updateExplorerState((state) => {
          const nextState: AgentFileExplorerState = {
            ...state,
            isLoading: false,
            lastError: null,
            pendingRequest: null,
            directories: state.directories,
            files: state.files,
          };

          const files = new Map(state.files);
          const explorerFile = explorerFileFromReadResult(file);
          files.set(explorerFile.path, explorerFile);
          nextState.files = files;

          return nextState;
        });
      } catch (error) {
        updateExplorerState((state) => ({
          ...state,
          isLoading: false,
          lastError: error instanceof Error ? error.message : "Failed to load file preview",
          pendingRequest: null,
        }));
      }
    },
    [client, normalizedWorkspaceRoot, updateExplorerState, workspaceStateKey],
  );

  const requestFileDownloadToken = useCallback(
    async (path: string) => {
      if (!normalizedWorkspaceRoot) {
        throw new Error("Workspace is unavailable");
      }
      if (!client) {
        throw new Error("Host is not connected");
      }
      const payload = await client.requestDownloadToken(normalizedWorkspaceRoot, path);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot],
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

  return {
    workspaceStateKey,
    requestDirectoryListing,
    requestFilePreview,
    requestFileDownloadToken,
    selectExplorerEntry,
  };
}
