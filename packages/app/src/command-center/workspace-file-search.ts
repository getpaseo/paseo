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
  requestKey: string | null;
  entries: readonly WorkspaceFileSearchEntry[];
  loading: boolean;
}

const EMPTY_STATE: WorkspaceFileSearchState = {
  requestKey: null,
  entries: [],
  loading: false,
};

function describeFileEntries(
  entries: readonly DirectorySuggestionEntry[],
): WorkspaceFileSearchEntry[] {
  return entries.map(({ path }) => describeWorkspaceFilePath(path));
}

export function useWorkspaceFileSearch(input: { enabled: boolean; query: string }): {
  entries: readonly WorkspaceFileSearchEntry[];
  loading: boolean;
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
  const requestKey = useMemo(
    () =>
      input.enabled && serverId && workspaceId && cwd && client
        ? `${serverId}\0${cwd}\0${input.query}`
        : null,
    [client, cwd, input.enabled, input.query, serverId, workspaceId],
  );

  useEffect(() => {
    if (!requestKey || !client || !cwd) {
      setState(EMPTY_STATE);
      return;
    }
    const activeClient = client;
    const activeCwd = cwd;

    let cancelled = false;
    setState({ requestKey, entries: [], loading: true });
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
          requestKey,
          entries: payload.error ? [] : describeFileEntries(payload.entries),
          loading: false,
        });
      } catch {
        if (!cancelled) setState({ requestKey, entries: [], loading: false });
      }
    }

    const timer = setTimeout(() => void search(), input.query.trim() ? FILE_SEARCH_DEBOUNCE_MS : 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, cwd, input.query, requestKey]);

  const openFile = useCallback(
    (path: string) => {
      if (!serverId || !workspaceId) return;
      clearCommandCenterFocusRestoreElement();
      openWorkspaceFileFromExplorer({
        filePath: path,
        persistenceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
        showMobileAgent: usePanelStore.getState().showMobileAgent,
        openWorkspaceTabFocused: useWorkspaceLayoutStore.getState().openTabFocused,
        focusWorkspaceTab: useWorkspaceLayoutStore.getState().focusTab,
      });
    },
    [serverId, workspaceId],
  );

  return {
    entries: state.requestKey === requestKey ? state.entries : [],
    loading: Boolean(requestKey) && (state.requestKey !== requestKey || state.loading),
    openFile,
  };
}
