import { useCallback, useEffect, useMemo, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { openWorkspaceFileFromExplorer } from "@/screens/workspace/workspace-file-open-command";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import {
  isNamedFileSuggestion,
  matchHiddenListingEntries,
  planDaemonFileSearchRequest,
  resolveSuggestedFilePath,
  type DaemonFileSearchPlan,
  type DaemonFileSearchRequest,
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

interface FileSearchResults {
  entries: WorkspaceFileSearchEntry[];
  error: string | null;
}

/**
 * Runs the daemon reads one file query needs and merges them in display order: the named path,
 * then hidden names from the parent listing, then ordinary discovery.
 *
 * They are separate because each filter that keeps the palette quiet in the common case also
 * hides something the caller explicitly asked for: discovery skips hidden and Git-ignored
 * names, and it cannot resolve a hidden partial name at all.
 */
async function collectFileSearchResults(input: {
  client: DaemonClient;
  plan: DaemonFileSearchPlan | null;
  workspaceRoot: string;
  query: string;
}): Promise<FileSearchResults> {
  const { client, plan, workspaceRoot, query } = input;
  const listing = plan?.list ?? { cwd: workspaceRoot, query, root: workspaceRoot };
  const [payload, exactPayload, hiddenListingPayload] = await Promise.all([
    client.getDirectorySuggestions({
      cwd: listing.cwd,
      query: listing.query,
      includeFiles: true,
      includeDirectories: false,
      limit: FILE_SEARCH_LIMIT,
    }),
    namedPathSuggestions({ client, request: plan?.exact ?? null, namedPath: plan?.namedPath }),
    hiddenNameSuggestions({
      client,
      request: plan?.hiddenListing ?? null,
      typedName: listing.query,
    }),
  ]);

  const listedEntries = payload.error ? [] : describeFileEntries(payload.entries, listing.root);
  const listedPaths = new Set(listedEntries.map((entry) => entry.path));
  const hiddenPaths = new Set(hiddenListingPayload.map((entry) => entry.path));
  return {
    entries: [
      ...exactPayload.filter((entry) => !listedPaths.has(entry.path)),
      ...hiddenListingPayload.filter((entry) => !listedPaths.has(entry.path)),
      ...listedEntries.filter((entry) => !hiddenPaths.has(entry.path)),
    ],
    error: payload.error ?? null,
  };
}

/**
 * Retrieves the path the user named. The request falls back to a suffix search when that path
 * does not exist, and the fallback can offer a same-named file deeper under the root — opening
 * that instead of the typed path would be wrong, so only equal paths are kept.
 */
async function namedPathSuggestions(input: {
  client: DaemonClient;
  request: DaemonFileSearchRequest | null;
  namedPath: string | undefined;
}): Promise<WorkspaceFileSearchEntry[]> {
  const { client, request, namedPath } = input;
  if (!request) {
    return [];
  }
  const payload = await client
    .getDirectorySuggestions({
      cwd: request.cwd,
      query: request.query,
      includeFiles: true,
      includeDirectories: false,
      matchMode: "suffix",
      limit: 1,
    })
    .catch(() => null);
  if (!payload || payload.error) {
    return [];
  }
  return describeFileEntries(
    payload.entries.filter((entry) =>
      isNamedFileSuggestion({ root: request.root, path: entry.path, namedPath: namedPath ?? "" }),
    ),
    request.root,
  );
}

/** Partial hidden names never reach discovery, so the parent directory is listed and filtered. */
async function hiddenNameSuggestions(input: {
  client: DaemonClient;
  request: DaemonFileSearchRequest | null;
  typedName: string;
}): Promise<WorkspaceFileSearchEntry[]> {
  const { client, request, typedName } = input;
  if (!request) {
    return [];
  }
  const listing = await client.listDirectory(request.cwd, ".").catch(() => null);
  if (!listing) {
    return [];
  }
  return matchHiddenListingEntries({
    entries: listing.entries,
    typedName,
    limit: FILE_SEARCH_LIMIT,
  }).map((entry) => describeWorkspaceFilePath(`${request.root}/${entry.name}`));
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
        const results = await collectFileSearchResults({
          client: activeClient,
          plan,
          workspaceRoot: activeCwd,
          query: input.query,
        });
        if (cancelled) return;
        setState({ sourceKey, requestKey, ...results, loading: false });
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
        openWorkspaceTabInFocusedPane: (workspaceKey, target, placement) =>
          useWorkspaceLayoutStore.getState().openTab({
            workspaceKey,
            target,
            intent: "reveal",
            placement,
          }),
        revealWorkspaceTab,
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
