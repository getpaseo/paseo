import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { CommitLogEntry, CommitLogScope } from "@getpaseo/protocol/messages";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchInfiniteQuery } from "@/data/query";
import { commitLogQueryKey } from "@/git/query-keys";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

// History only moves when the user commits, pulls, or pushes — all of which
// invalidate this key explicitly. This just keeps a tab switch warm.
const COMMIT_LOG_STALE_TIME = 30_000;
const COMMIT_LOG_PAGE_LIMIT = 50;

interface CommitLogPageData {
  commits: CommitLogEntry[];
  nextCursor: string | null;
  hasMore: boolean;
  cursorExpired: boolean;
  pinnedTipsTruncated: boolean;
}

export interface CommitLogData {
  commits: CommitLogEntry[];
  hasMore: boolean;
  pinnedTipsTruncated: boolean;
}

export type CommitLogQueryResult =
  | { status: "unsupported" }
  | { status: "connecting" }
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "loaded"; data: CommitLogData; isLoadingMore: boolean };

export interface UseCommitLogQuery {
  result: CommitLogQueryResult;
  loadMore: () => void;
  refresh: () => void;
  isRefreshing: boolean;
  /** True once after history moved under a cursor and the list restarted. */
  didResetAfterExpiry: boolean;
  acknowledgeReset: () => void;
}

interface ResolveCommitLogQueryResultInput {
  capabilityPresent: boolean;
  canFetch: boolean;
  data: CommitLogData | undefined;
  isFetchingNextPage: boolean;
  error: Error | null;
}

export function resolveCommitLogQueryResult({
  capabilityPresent,
  canFetch,
  data,
  isFetchingNextPage,
  error,
}: ResolveCommitLogQueryResultInput): CommitLogQueryResult {
  if (!capabilityPresent) {
    return { status: "unsupported" };
  }
  if (data) {
    return { status: "loaded", data, isLoadingMore: isFetchingNextPage };
  }
  if (!canFetch) {
    return { status: "connecting" };
  }
  if (error) {
    return { status: "error", error };
  }
  return { status: "loading" };
}

interface UseCommitLogQueryOptions {
  serverId: string;
  cwd: string;
  scope: CommitLogScope;
  enabled?: boolean;
}

export function useCommitLogQuery({
  serverId,
  cwd,
  scope,
  enabled = true,
}: UseCommitLogQueryOptions): UseCommitLogQuery {
  const queryClient = useQueryClient();
  const retainedPanelActive = useRetainedPanelActive();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const [didResetAfterExpiry, setDidResetAfterExpiry] = useState(false);
  // COMPAT(commitHistoryLog): added in v0.7.0, remove after 2027-08-31.
  // Single capability-detection site; downstream reads a clean load-state union.
  const capabilityPresent = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.commitHistoryLog === true,
  );

  const canFetch = Boolean(cwd) && Boolean(client) && isConnected;
  const queryKey = commitLogQueryKey(serverId, cwd, scope);

  const query = useFetchInfiniteQuery<CommitLogPageData, Error, readonly unknown[], string | null>({
    queryKey,
    enabled: enabled && retainedPanelActive && capabilityPresent && canFetch,
    staleTimeMs: COMMIT_LOG_STALE_TIME,
    initialPageParam: null,
    getNextPageParam: (last) => (last.hasMore && last.nextCursor ? last.nextCursor : undefined),
    queryFn: async ({ pageParam }) => {
      if (!client) {
        throw new Error("Host disconnected");
      }
      const page = await client.listCommitHistory({
        cwd,
        scope,
        limit: COMMIT_LOG_PAGE_LIMIT,
        ...(pageParam ? { cursor: pageParam } : {}),
      });
      return {
        commits: page.commits,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        cursorExpired: page.cursorExpired,
        pinnedTipsTruncated: page.pinnedTipsTruncated,
      };
    },
  });

  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage, isRefetching, refetch } =
    query;

  // A pinned tip vanished under us (force-push, prune, gc). Merging that page
  // would splice a shifted list into the loaded one, so restart from page 1.
  const sawExpiredCursor = (data?.pages ?? []).some((page) => page.cursorExpired);
  useEffect(() => {
    if (!sawExpiredCursor) {
      return;
    }
    setDidResetAfterExpiry(true);
    void queryClient.resetQueries({ queryKey });
    // queryKey is rebuilt every render; its parts are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, sawExpiredCursor, serverId, cwd, scope]);

  const commitLogData = useMemo((): CommitLogData | undefined => {
    const pages = data?.pages;
    if (!pages || pages.length === 0 || sawExpiredCursor) {
      return undefined;
    }
    const seen = new Set<string>();
    const commits: CommitLogEntry[] = [];
    for (const page of pages) {
      for (const commit of page.commits) {
        if (!seen.has(commit.sha)) {
          seen.add(commit.sha);
          commits.push(commit);
        }
      }
    }
    return {
      commits,
      hasMore: pages[pages.length - 1]?.hasMore === true,
      pinnedTipsTruncated: pages[0]?.pinnedTipsTruncated === true,
    };
  }, [data?.pages, sawExpiredCursor]);

  const loadMore = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage) {
      return;
    }
    void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const refresh = useCallback(() => {
    setDidResetAfterExpiry(false);
    void refetch();
  }, [refetch]);

  const acknowledgeReset = useCallback(() => setDidResetAfterExpiry(false), []);

  return {
    result: resolveCommitLogQueryResult({
      capabilityPresent,
      canFetch,
      data: commitLogData,
      isFetchingNextPage,
      error,
    }),
    loadMore,
    refresh,
    isRefreshing: isRefetching,
    didResetAfterExpiry,
    acknowledgeReset,
  };
}
