import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";

export interface NestedRepo {
  path: string;
  name: string;
  isWorktree: boolean;
  branch: string | null;
}

interface NestedReposState {
  repos: NestedRepo[];
  loading: boolean;
  error: string | null;
}

/**
 * Scan a directory for nested git repositories (subfolders containing a `.git`).
 * Used by the sidebar to surface repos inside a project folder as startable sessions.
 *
 * ponytail: one-shot scan on mount + on `refresh`; no polling/watch.
 */
export function useNestedRepos(
  getClient: (serverId: string) => DaemonClient | null,
  serverId: string | null,
  parentCwd: string | null,
): NestedReposState & { refresh: () => void } {
  const [state, setState] = useState<NestedReposState>({
    repos: [],
    loading: false,
    error: null,
  });
  const [refreshCount, setRefreshCount] = useState(0);
  // COMPAT(projectNestedRepos): added in v0.3.2, remove gate after 2027-08-11.
  // Older daemons reject the scan RPC, so skip it entirely instead of surfacing
  // an access-denied error (or a request timeout) in the sidebar.
  const supportsNestedRepos = useSessionStore(
    (sessionState) =>
      serverId !== null &&
      sessionState.sessions[serverId]?.serverInfo?.features?.projectNestedRepos === true,
  );
  // Keep the client accessor in a ref so parent re-renders (new function identity)
  // don't retrigger the scan effect below.
  const getClientRef = useRef(getClient);
  getClientRef.current = getClient;

  useEffect(() => {
    if (!serverId || !parentCwd || !supportsNestedRepos) {
      return;
    }
    const client = getClientRef.current(serverId);
    if (!client) {
      return;
    }
    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    void client
      .scanNestedRepos(parentCwd)
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setState({ repos: payload.repos, loading: false, error: payload.error });
        return;
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setState({
          repos: [],
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [parentCwd, refreshCount, serverId, supportsNestedRepos]);

  const refresh = useCallback(() => {
    setRefreshCount((current) => current + 1);
  }, []);

  return { ...state, refresh };
}
