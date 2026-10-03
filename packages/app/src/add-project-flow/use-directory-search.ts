import { useCallback, useMemo } from "react";
import { useIsFetching } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useFetchQuery } from "@/data/query";
import { useCachedQueryData } from "@/hooks/use-cached-query-data";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { planDirectorySearch, type DirectorySearchResult } from "./directory-search";

export function useDirectorySearch(input: {
  hostId: string | null;
  client: Pick<DaemonClient, "getDirectorySuggestions"> | null;
  enabled: boolean;
  query: string;
  recommendedPaths: string[];
}) {
  const root = useMemo(() => ["add-project-flow-directories", input.hostId], [input.hostId]);
  const cachedResults = useCachedQueryData<DirectorySearchResult>(root);
  const plan = planDirectorySearch({ ...input, cachedResults });
  const query = input.query.trim();
  const pendingOtherSearches = useIsFetching({
    queryKey: root,
    predicate: (cached) => cached.queryKey[2] !== query,
  });
  const candidate =
    input.enabled && input.client && plan.queryToFetch && pendingOtherSearches === 0
      ? JSON.stringify([input.hostId, plan.queryToFetch])
      : null;
  const settledCandidate = useDebouncedValue(candidate, 400);
  const result = useFetchQuery({
    queryKey: [...root, query],
    queryFn: async (): Promise<DirectorySearchResult> => {
      if (!input.client) throw new Error("Host is unavailable");
      const payload = await input.client.getDirectorySuggestions({
        query,
        includeDirectories: true,
        includeFiles: false,
        limit: 30,
      });
      if (payload.error) throw new Error(payload.error);
      return {
        query,
        paths:
          payload.entries?.flatMap((entry) => (entry.kind === "directory" ? [entry.path] : [])) ??
          [],
      };
    },
    enabled: candidate !== null && candidate === settledCandidate,
    dataShape: "value",
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTimeMs: 15_000,
  });
  const refetch = result.refetch;
  const retry = useCallback(() => refetch({ cancelRefetch: false }), [refetch]);
  return {
    paths: plan.paths,
    isFetching: result.isFetching,
    isError: result.isError && candidate !== null,
    isWaiting:
      Boolean(input.enabled && plan.queryToFetch) &&
      (pendingOtherSearches > 0 || candidate !== settledCandidate),
    retry,
  };
}
