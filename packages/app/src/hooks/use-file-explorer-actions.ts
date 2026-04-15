import { useCallback, useMemo } from "react";
import { useSessionStore, type AgentFileExplorerState } from "@/stores/session-store";

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
      const shouldRecordHistory = options?.recordHistory ?? (shouldSetCurrentPath ? true : false);

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
        const payload = await client.exploreFileSystem(
          normalizedWorkspaceRoot,
          normalizedPath,
          "list",
        );
        updateExplorerState((state) => {
          const nextState: AgentFileExplorerState = {
            ...state,
            isLoading: false,
            lastError: payload.error ?? null,
            pendingRequest: null,
            directories: state.directories,
            files: state.files,
          };

          if (!payload.error && payload.directory) {
            const directories = new Map(state.directories);
            directories.set(payload.directory.path, payload.directory);
            nextState.directories = directories;
          }

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
        const payload = await client.exploreFileSystem(
          normalizedWorkspaceRoot,
          normalizedPath,
          "file",
        );
        updateExplorerState((state) => {
          const nextState: AgentFileExplorerState = {
            ...state,
            isLoading: false,
            pendingRequest: null,
            directories: state.directories,
            files: state.files,
          };

          if (!payload.error && payload.file) {
            const files = new Map(state.files);
            files.set(payload.file.path, payload.file);
            nextState.files = files;
          } else if (payload.error) {
            nextState.lastError = payload.error;
          }

          return nextState;
        });
      } catch {
        updateExplorerState((state) => ({
          ...state,
          isLoading: false,
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
