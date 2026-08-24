import { useTranslation } from "react-i18next";
import {
  ForgeSearchItemSchema,
  GitHubSearchItemSchema,
  type ForgeAuthState,
  type ForgeSearchItem,
  ForgeSearchKind,
  type ForgeSearchResponse,
  type GitHubSearchResponse,
} from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { useFetchQuery } from "@/data/query";
import { parseForgeAuthState } from "@/git/forge";

export const FORGE_SEARCH_STALE_TIME = 30_000;

export interface ForgeSearchPayload {
  items: ForgeSearchItem[];
  authState: ForgeAuthState;
  error: string | null;
  requestId: string;
}

interface ForgeSearchOptions {
  cwd: string;
  query: string;
  limit?: number;
  kinds?: ForgeSearchKind[];
}

interface LegacyGitHubSearchOptions {
  cwd: string;
  query: string;
  limit?: number;
  kinds?: LegacyGitHubSearchKind[];
}

export interface ForgeSearchClient {
  searchForge: (
    options: ForgeSearchOptions,
    requestId?: string,
  ) => Promise<ForgeSearchResponse["payload"]>;
  searchGitHub?: (
    options: LegacyGitHubSearchOptions,
    requestId?: string,
  ) => Promise<GitHubSearchResponse["payload"]>;
}

type LegacyGitHubSearchKind = "github-issue" | "github-pr";

interface ForgeSearchQueryInput {
  client: ForgeSearchClient | null;
  serverId: string;
  cwd: string;
  query: string;
  kinds?: ForgeSearchKind[];
  enabled: boolean;
  supportsForgeSearch?: boolean;
  hostDisconnectedMessage?: string;
}

export function forgeSearchQueryKey(
  serverId: string,
  cwd: string,
  query: string,
  kinds?: ForgeSearchKind[],
  transport: "forge" | "github" = "forge",
) {
  const trimmedQuery = query.trim();
  if (!kinds) {
    return ["forge-search", serverId, cwd, transport, trimmedQuery] as const;
  }
  return [
    "forge-search",
    serverId,
    cwd,
    transport,
    trimmedQuery,
    [...kinds].sort().join(","),
  ] as const;
}

export function buildForgeSearchQueryOptions(input: ForgeSearchQueryInput) {
  const query = input.query.trim();
  const transport = input.supportsForgeSearch === true ? "forge" : "github";

  return {
    queryKey: forgeSearchQueryKey(input.serverId, input.cwd, query, input.kinds, transport),
    queryFn: async (): Promise<ForgeSearchPayload> => {
      if (!input.client) {
        throw new Error(
          input.hostDisconnectedMessage ?? i18n.t("workspace.terminal.hostDisconnected"),
        );
      }
      const request = input.kinds
        ? { cwd: input.cwd, query, limit: 20, kinds: input.kinds }
        : { cwd: input.cwd, query, limit: 20 };
      // COMPAT(githubSearchRpc): added in v0.1.106, remove after 2026-12-28 once
      // clients use forge.search.*.
      if (transport === "github" && input.client.searchGitHub) {
        return normalizeLegacyGitHubSearchPayload(
          await input.client.searchGitHub(toLegacyGitHubSearchRequest(request)),
        );
      }
      return normalizeForgeSearchPayload(await input.client.searchForge(request));
    },
    enabled: input.enabled && Boolean(input.client),
    dataShape: "list" as const,
    staleTimeMs: FORGE_SEARCH_STALE_TIME,
  };
}

function normalizeForgeSearchPayload(payload: ForgeSearchResponse["payload"]): ForgeSearchPayload {
  return {
    items: payload.items.flatMap((item) => {
      const result = ForgeSearchItemSchema.safeParse(item);
      return result.success ? [result.data] : [];
    }),
    authState: parseForgeAuthState(payload.authState) ?? "unauthenticated",
    error: payload.error,
    requestId: payload.requestId,
  };
}

function normalizeLegacyGitHubSearchPayload(
  payload: GitHubSearchResponse["payload"],
): ForgeSearchPayload {
  // COMPAT(githubSearchAuthState): added in v0.1.106, remove after 2026-12-28.
  const featuresEnabled = payload.featuresEnabled ?? payload.githubFeaturesEnabled ?? true;
  return {
    items: payload.items.flatMap((item) => {
      const result = GitHubSearchItemSchema.safeParse(item);
      if (!result.success) {
        return [];
      }
      return [
        result.data.kind === "pr"
          ? { ...result.data, kind: "change_request" as const }
          : { ...result.data, kind: "issue" as const },
      ];
    }),
    authState:
      parseForgeAuthState(payload.authState) ??
      (featuresEnabled ? "authenticated" : "unauthenticated"),
    error: payload.error,
    requestId: payload.requestId,
  };
}

function toLegacyGitHubSearchKind(kind: ForgeSearchKind): LegacyGitHubSearchKind {
  return kind === "change_request" ? "github-pr" : "github-issue";
}

function toLegacyGitHubSearchRequest(request: ForgeSearchOptions): LegacyGitHubSearchOptions {
  if (!request.kinds) {
    return { cwd: request.cwd, query: request.query, limit: request.limit };
  }
  return {
    ...request,
    kinds: request.kinds.map(toLegacyGitHubSearchKind),
  };
}

export function useForgeSearchQuery(input: ForgeSearchQueryInput) {
  const { t } = useTranslation();
  return useFetchQuery(
    buildForgeSearchQueryOptions({
      ...input,
      hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
    }),
  );
}
