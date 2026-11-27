import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { GithubRepositoryChoice } from "./model";
import { resolveSearch, type SearchResult } from "./search-result";

export type { SearchResult } from "./search-result";

const SEARCH_DEBOUNCE_MS = 250;
const EMPTY_PATHS: string[] = [];
const EMPTY_REPOSITORIES: GithubRepositoryChoice[] = [];

/** Directories on the host matching `query`, debounced while the user types. */
export function useDirectorySearch(input: {
  hostId: string | null;
  query: string;
  enabled: boolean;
}): SearchResult<string> {
  const { hostId } = input;
  const client = useHostRuntimeClient(hostId ?? "");
  const debouncedQuery = useDebouncedValue(input.query, SEARCH_DEBOUNCE_MS);
  const enabled = Boolean(client && input.enabled);
  const search = useFetchQuery({
    queryKey: ["add-project-flow-directories", hostId, debouncedQuery],
    queryFn: async () => {
      if (!client) throw new Error("Host is unavailable");
      const payload = await client.getDirectorySuggestions({
        query: debouncedQuery,
        includeDirectories: true,
        includeFiles: false,
        limit: 30,
      });
      const items =
        payload.entries?.flatMap((entry) => (entry.kind === "directory" ? [entry.path] : [])) ?? [];
      return { hostId, query: debouncedQuery, items, error: payload.error ?? null };
    },
    enabled,
    dataShape: "list",
    retry: false,
    staleTimeMs: 15_000,
  });
  const failed = search.isError ? "Unable to search folders" : null;
  return useMemo(
    () =>
      resolveSearch({
        enabled,
        hostId,
        query: input.query,
        debouncedQuery,
        data: search.data,
        failed,
        empty: EMPTY_PATHS,
      }),
    [debouncedQuery, enabled, failed, hostId, input.query, search.data],
  );
}

/** GitHub repositories the host's account can see, matching `query`. */
export function useGithubRepositorySearch(input: {
  hostId: string | null;
  query: string;
  enabled: boolean;
}): SearchResult<GithubRepositoryChoice> {
  const { hostId } = input;
  const client = useHostRuntimeClient(hostId ?? "");
  const debouncedQuery = useDebouncedValue(input.query, SEARCH_DEBOUNCE_MS);
  const enabled = Boolean(client && input.enabled);
  const search = useFetchQuery({
    queryKey: ["add-project-flow-github", hostId, debouncedQuery],
    queryFn: async () => {
      if (!client) throw new Error("Host is unavailable");
      const payload = await client.searchGithubRepositories({ query: debouncedQuery, limit: 30 });
      let error: string | null = payload.error ?? null;
      if (!error && payload.available === false) error = "GitHub search is unavailable";
      return {
        hostId,
        query: debouncedQuery,
        items: error ? EMPTY_REPOSITORIES : payload.repositories,
        error,
      };
    },
    enabled,
    dataShape: "list",
    retry: false,
    staleTimeMs: 15_000,
  });
  const failed = search.isError ? "Unable to search GitHub" : null;
  return useMemo(
    () =>
      resolveSearch({
        enabled,
        hostId,
        query: input.query,
        debouncedQuery,
        data: search.data,
        failed,
        empty: EMPTY_REPOSITORIES,
      }),
    [debouncedQuery, enabled, failed, hostId, input.query, search.data],
  );
}
