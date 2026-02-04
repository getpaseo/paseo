import { useCallback } from "react";
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

export function useFileExplorerActions(serverId: string) {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const setFileExplorer = useSessionStore((state) => state.setFileExplorer);

  const updateExplorerState = useCallback(
    (agentId: string, updater: (prev: AgentFileExplorerState) => AgentFileExplorerState) => {
      setFileExplorer(serverId, (prev) => {
        const next = new Map(prev);
        const current = next.get(agentId) ?? createExplorerState();
        next.set(agentId, updater(current));
        return next;
      });
    },
    [serverId, setFileExplorer]
  );

  const requestDirectoryListing = useCallback(
    (agentId: string, path: string, options?: { recordHistory?: boolean }) => {
      const normalizedPath = path && path.length > 0 ? path : ".";
      const shouldRecordHistory = options?.recordHistory ?? true;

      updateExplorerState(agentId, (state) => ({
        ...state,
        isLoading: true,
        lastError: null,
        pendingRequest: { path: normalizedPath, mode: "list" },
        currentPath: normalizedPath,
        history: shouldRecordHistory ? pushHistory(state.history, normalizedPath) : state.history,
        lastVisitedPath: normalizedPath,
      }));

      if (!client) {
        updateExplorerState(agentId, (state) => ({
          ...state,
          isLoading: false,
          lastError: "Host is not connected",
          pendingRequest: null,
        }));
        return;
      }

      void client
        .exploreFileSystem(agentId, normalizedPath, "list")
        .then((payload) => {
          updateExplorerState(agentId, (state) => {
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
        })
        .catch((error) => {
          updateExplorerState(agentId, (state) => ({
            ...state,
            isLoading: false,
            lastError: error instanceof Error ? error.message : "Failed to list directory",
            pendingRequest: null,
          }));
        });
    },
    [client, updateExplorerState]
  );

  const requestFilePreview = useCallback(
    (agentId: string, path: string) => {
      const normalizedPath = path && path.length > 0 ? path : ".";
      updateExplorerState(agentId, (state) => ({
        ...state,
        isLoading: true,
        pendingRequest: { path: normalizedPath, mode: "file" },
      }));

      if (!client) {
        updateExplorerState(agentId, (state) => ({
          ...state,
          isLoading: false,
          lastError: "Host is not connected",
          pendingRequest: null,
        }));
        return;
      }

      void client
        .exploreFileSystem(agentId, normalizedPath, "file")
        .then((payload) => {
          updateExplorerState(agentId, (state) => {
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
        })
        .catch(() => {
          updateExplorerState(agentId, (state) => ({
            ...state,
            isLoading: false,
            pendingRequest: null,
          }));
        });
    },
    [client, updateExplorerState]
  );

  const requestFileDownloadToken = useCallback(
    async (agentId: string, path: string) => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      const payload = await client.requestDownloadToken(agentId, path);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload;
    },
    [client]
  );

  const navigateExplorerBack = useCallback(
    (agentId: string) => {
      let targetPath: string | null = null;

      updateExplorerState(agentId, (state) => {
        if (state.history.length <= 1) {
          return state;
        }
        const nextHistory = state.history.slice(0, -1);
        targetPath = nextHistory[nextHistory.length - 1] ?? ".";
        return {
          ...state,
          isLoading: true,
          lastError: null,
          pendingRequest: { path: targetPath, mode: "list" },
          currentPath: targetPath,
          history: nextHistory,
          lastVisitedPath: targetPath,
        };
      });

      if (!targetPath) {
        return null;
      }

      requestDirectoryListing(agentId, targetPath, { recordHistory: false });
      return targetPath;
    },
    [requestDirectoryListing, updateExplorerState]
  );

  return {
    requestDirectoryListing,
    requestFilePreview,
    requestFileDownloadToken,
    navigateExplorerBack,
  };
}

