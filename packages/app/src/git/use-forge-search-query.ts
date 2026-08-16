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
import type { WorkspaceGitClient, WorkspaceGitReadClient } from "@/git/workspace-git";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export const FORGE_SEARCH_STALE_TIME = 30_000;

export interface ForgeSearchPayload {
  items: ForgeSearchItem[];
  authState: ForgeAuthState;
  error: string | null;
  requestId: string;
}

interface ForgeSearchOptions {
  query: string;
  limit?: number;
  kinds?: ForgeSearchKind[];
}

interface LegacyGitHubSearchOptions {
  query: string;
  limit?: number;
  kinds?: LegacyGitHubSearchKind[];
}

type ForgeSearchTarget = Pick<WorkspaceGitReadClient, "cwd" | "queryIdentity">;
export type ForgeSearchClient = ForgeSearchTarget &
  Pick<WorkspaceGitClient, "searchForge"> &
  Partial<Pick<WorkspaceGitClient, "searchGitHub">>;

type LegacyGitHubSearchKind = "github-issue" | "github-pr";

interface ForgeSearchQueryInput {
  client: ForgeSearchClient | null;
  serverId: string;
  query: string;
  kinds?: ForgeSearchKind[];
  enabled: boolean;
  supportsForgeSearch?: boolean;
  hostDisconnectedMessage?: string;
}

interface LegacyForgeSearchQueryInput extends Omit<ForgeSearchQueryInput, "client"> {
  client: Pick<DaemonClient, "searchForge" | "searchGitHub"> | null;
  cwd: string;
}

export function forgeSearchQueryKey(
  serverId: string,
  target: ForgeSearchTarget,
  query: string,
  kinds?: ForgeSearchKind[],
  transport: "forge" | "github" = "forge",
) {
  const trimmedQuery = query.trim();
  const queryIdentity = forgeSearchClientIdentity(target);
  if (!kinds) {
    return ["forge-search", serverId, queryIdentity, target.cwd, transport, trimmedQuery] as const;
  }
  return [
    "forge-search",
    serverId,
    queryIdentity,
    target.cwd,
    transport,
    trimmedQuery,
    [...kinds].sort().join(","),
  ] as const;
}

export function forgeSearchClientIdentity(client: ForgeSearchTarget) {
  return client.queryIdentity;
}

export function buildForgeSearchQueryOptions(input: ForgeSearchQueryInput) {
  const query = input.query.trim();
  const transport = input.supportsForgeSearch === true ? "forge" : "github";

  return {
    queryKey: input.client
      ? forgeSearchQueryKey(input.serverId, input.client, query, input.kinds, transport)
      : (["forge-search", input.serverId, "unbound", transport, query] as const),
    queryFn: async (): Promise<ForgeSearchPayload> => {
      if (!input.client) {
        throw new Error(
          input.hostDisconnectedMessage ?? i18n.t("workspace.terminal.hostDisconnected"),
        );
      }
      const request = input.kinds ? { query, limit: 20, kinds: input.kinds } : { query, limit: 20 };
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
    return { query: request.query, limit: request.limit };
  }
  return {
    ...request,
    kinds: request.kinds.map(toLegacyGitHubSearchKind),
  };
}

export function buildLegacyForgeSearchQueryOptions(input: LegacyForgeSearchQueryInput) {
  const query = input.query.trim();
  const transport = input.supportsForgeSearch === true ? "forge" : "github";
  return {
    queryKey: ["legacy-forge-search", input.serverId, input.cwd, transport, query] as const,
    queryFn: async (): Promise<ForgeSearchPayload> => {
      if (!input.client) {
        throw new Error(
          input.hostDisconnectedMessage ?? i18n.t("workspace.terminal.hostDisconnected"),
        );
      }
      const request = input.kinds
        ? { cwd: input.cwd, query, limit: 20, kinds: input.kinds }
        : { cwd: input.cwd, query, limit: 20 };
      if (transport === "github") {
        return normalizeLegacyGitHubSearchPayload(
          await input.client.searchGitHub({
            cwd: input.cwd,
            query,
            limit: 20,
            kinds: input.kinds?.map(toLegacyGitHubSearchKind),
          }),
        );
      }
      return normalizeForgeSearchPayload(await input.client.searchForge(request));
    },
    enabled: input.enabled && Boolean(input.client),
    dataShape: "list" as const,
    staleTimeMs: FORGE_SEARCH_STALE_TIME,
  };
}

export function useLegacyForgeSearchQuery(input: LegacyForgeSearchQueryInput) {
  const { t } = useTranslation();
  return useFetchQuery(
    buildLegacyForgeSearchQueryOptions({
      ...input,
      hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
    }),
  );
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
