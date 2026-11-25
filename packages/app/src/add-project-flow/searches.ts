import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { GithubRepositoryChoice } from "./model";

const SEARCH_DEBOUNCE_MS = 250;
const EMPTY_PATHS: string[] = [];
const EMPTY_REPOSITORIES: GithubRepositoryChoice[] = [];

/**
 * What a search shows while the user types. `items` keep the last results until the current
 * query's results arrive, so rows do not flash away on every keystroke.
 */
export interface SearchResult<T> {
  items: T[];
  /** Results for the current query have not arrived yet. */
  pending: boolean;
  error: string | null;
}

/** Directories on the host matching `query`, debounced while the user types. */
export function useDirectorySearch(input: {
  hostId: string | null;
  query: string;
  enabled: boolean;
}): SearchResult<string> {
  const client = useHostRuntimeClient(input.hostId ?? "");
  const debouncedQuery = useDebouncedValue(input.query, SEARCH_DEBOUNCE_MS);
  const search = useFetchQuery({
    queryKey: ["add-project-flow-directories", input.hostId, debouncedQuery],
    queryFn: async () => {
      if (!client) return { query: debouncedQuery, paths: EMPTY_PATHS };
      const payload = await client.getDirectorySuggestions({
        query: debouncedQuery,
        includeDirectories: true,
        includeFiles: false,
        limit: 30,
      });
      const paths =
        payload.entries?.flatMap((entry) => (entry.kind === "directory" ? [entry.path] : [])) ?? [];
      return { query: debouncedQuery, paths };
    },
    enabled: Boolean(client && input.enabled),
    dataShape: "list",
    retry: false,
    staleTimeMs: 15_000,
  });
  const paths = search.data?.paths ?? EMPTY_PATHS;
  const settled = search.data?.query === input.query;
  return useMemo(
    () => ({
      items: search.isError ? EMPTY_PATHS : paths,
      pending: input.enabled && !settled && !search.isError,
      error: search.isError ? "Unable to search folders" : null,
    }),
    [input.enabled, paths, search.isError, settled],
  );
}

/** GitHub repositories the host's account can see, matching `query`. */
export function useGithubRepositorySearch(input: {
  hostId: string | null;
  query: string;
  enabled: boolean;
}): SearchResult<GithubRepositoryChoice> {
  const client = useHostRuntimeClient(input.hostId ?? "");
  const debouncedQuery = useDebouncedValue(input.query, SEARCH_DEBOUNCE_MS);
  const search = useFetchQuery({
    queryKey: ["add-project-flow-github", input.hostId, debouncedQuery],
    queryFn: async () => {
      if (!client) throw new Error("Host is unavailable");
      const payload = await client.searchGithubRepositories({ query: debouncedQuery, limit: 30 });
      return { query: debouncedQuery, payload };
    },
    enabled: Boolean(client && input.enabled),
    dataShape: "list",
    retry: false,
    staleTimeMs: 15_000,
  });
  const payload = search.data?.payload;
  const settled = search.data?.query === input.query;
  return useMemo(() => {
    if (search.isError) {
      return { items: EMPTY_REPOSITORIES, pending: false, error: "Unable to search GitHub" };
    }
    const pending = input.enabled && !settled;
    if (payload?.error) return { items: EMPTY_REPOSITORIES, pending, error: payload.error };
    if (payload?.available === false) {
      return { items: EMPTY_REPOSITORIES, pending, error: "GitHub search is unavailable" };
    }
    return { items: payload?.repositories ?? EMPTY_REPOSITORIES, pending, error: null };
  }, [input.enabled, payload, search.isError, settled]);
}
