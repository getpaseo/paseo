import { useQuery } from "@tanstack/react-query";
import type { GitHubSearchRequest, GitHubSearchResponse } from "@getpaseo/protocol/messages";

export const GITHUB_SEARCH_STALE_TIME = 30_000;

export type GitHubSearchPayload = GitHubSearchResponse["payload"];

export interface GitHubSearchClient {
  searchGitHub: (
    options: {
      cwd: string;
      query: string;
      limit?: number;
      kinds?: GitHubSearchRequest["kinds"];
    },
    requestId?: string,
  ) => Promise<GitHubSearchPayload>;
}

interface GitHubSearchQueryInput {
  client: GitHubSearchClient | null;
  serverId: string;
  cwd: string;
  query: string;
  kinds?: GitHubSearchRequest["kinds"];
  enabled: boolean;
}

export function githubSearchQueryKey(
  serverId: string,
  cwd: string,
  query: string,
  kinds?: GitHubSearchRequest["kinds"],
) {
  const trimmedQuery = query.trim();
  if (!kinds) {
    return ["github-search", serverId, cwd, trimmedQuery] as const;
  }
  return ["github-search", serverId, cwd, trimmedQuery, [...kinds].sort().join(",")] as const;
}

export function buildGithubSearchQueryOptions(input: GitHubSearchQueryInput) {
  const query = input.query.trim();

  return {
    queryKey: githubSearchQueryKey(input.serverId, input.cwd, query, input.kinds),
    queryFn: async (): Promise<GitHubSearchPayload> => {
      if (!input.client) {
        throw new Error("Host is not connected");
      }
      const request = { cwd: input.cwd, query, limit: 20 };
      if (input.kinds) {
        return input.client.searchGitHub({ ...request, kinds: input.kinds });
      }
      return input.client.searchGitHub(request);
    },
    enabled: input.enabled && Boolean(input.client),
    staleTime: GITHUB_SEARCH_STALE_TIME,
  };
}

export function useGithubSearchQuery(input: GitHubSearchQueryInput) {
  return useQuery(buildGithubSearchQueryOptions(input));
}
