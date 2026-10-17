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
  isNamedFileSuggestion,
  planDaemonFileSearchRequest,
  resolveSuggestedFilePath,
} from "./file-search-query";
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
  searchRoot: string | null,
): WorkspaceFileSearchEntry[] {
  return entries.map(({ path }) =>
    describeWorkspaceFilePath(
      searchRoot ? resolveSuggestedFilePath({ root: searchRoot, path }) : path,
    ),
  );
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
    // A typed absolute path may live outside the workspace, which the workspace-scoped search
    // cannot reach. Re-root that query on the typed path's own directory and re-attach the root to
    // the suggestions, so the row opens the same path the user named. The named path is also
    // retrieved on its own, because discovery drops hidden and Git-ignored names.
    const plan = planDaemonFileSearchRequest({ query: input.query, workspaceRoot: activeCwd });
    const exactRequest = plan?.exact ?? null;

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
        const [payload, exactPayload] = await Promise.all([
          activeClient.getDirectorySuggestions({
            cwd: plan?.list.cwd ?? activeCwd,
            query: plan?.list.query ?? input.query,
            includeFiles: true,
            includeDirectories: false,
            limit: FILE_SEARCH_LIMIT,
          }),
          exactRequest
            ? activeClient
                .getDirectorySuggestions({
                  cwd: exactRequest.cwd,
                  query: exactRequest.query,
                  includeFiles: true,
                  includeDirectories: false,
                  matchMode: "suffix",
                  limit: 1,
                })
                .catch(() => null)
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        // The retrieval request falls back to a suffix search when the typed path does not exist;
        // only a result that is the typed path may lead the list.
        const exactRoot = exactRequest?.root ?? null;
        const namedEntries =
          exactPayload && !exactPayload.error
            ? describeFileEntries(
                exactPayload.entries.filter((entry) =>
                  isNamedFileSuggestion({
                    root: exactRoot ?? "",
                    path: entry.path,
                    namedPath: plan?.namedPath ?? "",
                  }),
                ),
                exactRoot,
              )
            : [];
        const listedEntries = payload.error
          ? []
          : describeFileEntries(payload.entries, plan?.list.root ?? null);
        const listedPaths = new Set(listedEntries.map((entry) => entry.path));
        setState({
          sourceKey,
          requestKey,
          entries: [
            ...namedEntries.filter((entry) => !listedPaths.has(entry.path)),
            ...listedEntries,
          ],
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
        closeExplorerAfterOpen: true,
        showMobileAgent: usePanelStore.getState().showMobileAgent,
        openWorkspaceTabInFocusedPane: (workspaceKey, target, placement) =>
          useWorkspaceLayoutStore.getState().openTab({
            workspaceKey,
            target,
            intent: "reveal",
            placement,
          }),
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
