import { useCallback, useEffect, useMemo, useState } from "react";
import { openWorkspaceFileFromExplorer } from "@/screens/workspace/workspace-file-open-command";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  describeWorkspaceFilePath,
  type WorkspaceFileSearchEntry,
} from "./workspace-file-search-model";

interface DirectorySuggestionEntry {
  path: string;
}

const FILE_SEARCH_DEBOUNCE_MS = 100;
const FILE_SEARCH_LIMIT = 100;

interface WorkspaceFileSearchState {
  sourceKey: string | null;
  requestKey: string | null;
  entries: readonly WorkspaceFileSearchEntry[];
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: WorkspaceFileSearchState = {
  sourceKey: null,
  requestKey: null,
  entries: [],
  loading: false,
  error: null,
};

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name !== "DaemonRpcError") return error.message;
  return error.message.replace(/ requestType=\S+(?: code=\S+)?$/, "");
}

function describeFileEntries(
  entries: readonly DirectorySuggestionEntry[],
): WorkspaceFileSearchEntry[] {
  return entries.map(({ path }) => describeWorkspaceFilePath(path));
}

export function useWorkspaceFileSearch(input: { enabled: boolean; query: string }): {
  entries: readonly WorkspaceFileSearchEntry[];
  loading: boolean;
  error: string | null;
  openFile(path: string): void;
} {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  const client = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.client ?? null) : null,
  );
  const [state, setState] = useState<WorkspaceFileSearchState>(EMPTY_STATE);
  const sourceKey = useMemo(
    () => (serverId && workspaceId && cwd && client ? `${serverId}\0${workspaceId}\0${cwd}` : null),
    [client, cwd, serverId, workspaceId],
  );
  const requestKey = useMemo(
    () => (input.enabled && sourceKey ? `${sourceKey}\0${input.query}` : null),
    [input.enabled, input.query, sourceKey],
  );

  useEffect(() => {
    if (!requestKey || !client || !cwd) {
      setState(EMPTY_STATE);
      return;
    }
    const activeClient = client;
    const activeCwd = cwd;

    let cancelled = false;
    setState((previous) => ({
      sourceKey,
      requestKey,
      entries: previous.sourceKey === sourceKey ? previous.entries : [],
      loading: true,
      error: null,
    }));
    async function search(): Promise<void> {
      try {
        const payload = await activeClient.getDirectorySuggestions({
          cwd: activeCwd,
          query: input.query,
          includeFiles: true,
          includeDirectories: false,
          limit: FILE_SEARCH_LIMIT,
        });
        if (cancelled) return;
        setState({
          sourceKey,
          requestKey,
          entries: payload.error ? [] : describeFileEntries(payload.entries),
          loading: false,
          error: payload.error ?? null,
        });
      } catch (error) {
        if (!cancelled) {
          setState({
            sourceKey,
            requestKey,
            entries: [],
            loading: false,
            error: errorMessage(error),
          });
        }
      }
    }

    const timer = setTimeout(() => void search(), input.query.trim() ? FILE_SEARCH_DEBOUNCE_MS : 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, cwd, input.query, requestKey, sourceKey]);

  const openFile = useCallback(
    (path: string) => {
      if (!serverId || !workspaceId) return;
      clearCommandCenterFocusRestoreElement();
      openWorkspaceFileFromExplorer({
        filePath: path,
        persistenceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
        showMobileAgent: usePanelStore.getState().showMobileAgent,
        openWorkspaceTabInFocusedPane: useWorkspaceLayoutStore.getState().openTabInFocusedPane,
        focusWorkspaceTab: useWorkspaceLayoutStore.getState().focusTab,
      });
    },
    [serverId, workspaceId],
  );

  return {
    entries: requestKey && state.sourceKey === sourceKey ? state.entries : [],
    loading: Boolean(requestKey) && (state.requestKey !== requestKey || state.loading),
    error: state.requestKey === requestKey ? state.error : null,
    openFile,
  };
}
