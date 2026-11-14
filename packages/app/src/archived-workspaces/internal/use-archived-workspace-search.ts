import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useAgentHistory } from "@/hooks/use-agent-history";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  groupArchivedWorkspaces,
  type ActiveWorkspaceIdsByServer,
  type ArchivedWorkspace,
} from "./group";

const SEARCH_DEBOUNCE_MS = 200;
const NO_WORKSPACES: Record<string, ReadonlyMap<string, WorkspaceDescriptor>> = {};
const NO_ARCHIVED_WORKSPACES: ArchivedWorkspace[] = [];

export interface ArchivedWorkspaceSearch {
  /** Newest archive first. Empty without a query. */
  workspaces: ArchivedWorkspace[];
  /**
   * The host matched these for the current query. Its search forgives typos, so its matches
   * can include rows the caller cannot match itself. False while the previous query's
   * results stand in for the next one; those rows must still match the query on their own.
   */
  matchedByHost: boolean;
  /** Still searching for the current query, debounce included. */
  pending: boolean;
}

function useActiveWorkspaceIds(enabled: boolean): ActiveWorkspaceIdsByServer {
  // Each host's workspace map is replaced only when its workspaces change, so this does not
  // re-render on agent activity.
  const workspacesByServer = useSessionStore(
    useShallow((state) =>
      enabled
        ? Object.fromEntries(
            Object.entries(state.sessions).map(([serverId, session]) => [
              serverId,
              session.workspaces,
            ]),
          )
        : NO_WORKSPACES,
    ),
  );
  return useMemo(
    () =>
      new Map(
        Object.entries(workspacesByServer).map(([serverId, workspaces]) => [
          serverId,
          new Set(workspaces.keys()),
        ]),
      ),
    [workspacesByServer],
  );
}

/**
 * Archived workspaces whose name, project, branch, or agent titles match `query`, searched on
 * every host that supports history search. Hosts that predate it contribute nothing.
 */
export function useArchivedWorkspaceSearch(
  query: string,
  options: { enabled: boolean },
): ArchivedWorkspaceSearch {
  const trimmed = query.trim();
  const search = useDebouncedValue(trimmed, SEARCH_DEBOUNCE_MS);
  const enabled = options.enabled && trimmed.length > 0;
  const activeIds = useActiveWorkspaceIds(enabled);
  const history = useAgentHistory({
    search,
    enabled: enabled && search.length > 0,
    searchableHostsOnly: true,
    keepPreviousResults: true,
  });
  const workspaces = useMemo(
    () =>
      enabled
        ? groupArchivedWorkspaces({ agents: history.agents, activeIds })
        : NO_ARCHIVED_WORKSPACES,
    [activeIds, enabled, history.agents],
  );
  const matchedByHost = search === trimmed && !history.isLoading && !history.isPreviousResults;
  return { workspaces, matchedByHost, pending: enabled && !matchedByHost };
}
