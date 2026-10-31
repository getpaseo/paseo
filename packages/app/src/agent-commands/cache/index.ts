import type { QueryClient } from "@tanstack/react-query";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import equal from "fast-deep-equal";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

export const AGENT_COMMANDS_QUERY_ROOT = "agentCommands";
export const sessionCommandQueryPolicy = {
  staleTime: 600_000,
  gcTime: 1_800_000,
  refetchOnMount: true,
  refetchOnWindowFocus: false,
} as const;

export interface AgentCommandsDraftConfig {
  provider: AgentProvider;
  cwd: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

export function normalizeAgentCommandsCwd(cwd: string): string {
  return normalizeWorkspacePath(cwd) ?? "";
}

export function agentCommandsQueryRoot(serverId: string) {
  return [AGENT_COMMANDS_QUERY_ROOT, serverId] as const;
}

/** Snapshot announcements contain provider metadata, not command catalogs. Ignore initial
 * discovery and unrelated providers; explicit refresh still invalidates every catalog. */
export function invalidateCommandsForProviderChange(input: {
  queryClient: QueryClient;
  serverId: string;
  cwd: string | null;
  previous: readonly ProviderSnapshotEntry[] | undefined;
  current: readonly ProviderSnapshotEntry[];
}): Promise<void> {
  const previous = new Map((input.previous ?? []).map((entry) => [entry.provider, entry]));
  const current = new Map(input.current.map((entry) => [entry.provider, entry]));
  const relevant = (entry: ProviderSnapshotEntry | undefined) =>
    entry && {
      status: entry.status,
      enabled: entry.enabled,
      source: entry.source,
      models: entry.models,
      modes: entry.modes,
      defaultModeId: entry.defaultModeId,
    };
  return input.queryClient.invalidateQueries({
    queryKey: agentCommandsQueryRoot(input.serverId),
    predicate: (query) => {
      const isDraft = query.queryKey[2] === "draft";
      const provider =
        query.meta?.agentCommandProvider ?? (isDraft ? query.queryKey[6] : undefined);
      const cwd = query.meta?.agentCommandCwd ?? (isDraft ? query.queryKey[4] : undefined);
      if (input.cwd && typeof cwd === "string" && normalizeAgentCommandsCwd(cwd) !== input.cwd)
        return false;
      if (typeof provider !== "string") return false;
      const before = previous.get(provider);
      const after = current.get(provider);
      if (!before) return after?.status === "ready" && query.state.status === "error";
      if (before.status !== "ready")
        return after?.status === "ready" && query.state.status === "error";
      return !equal(relevant(before), relevant(after));
    },
  });
}

export function sessionAgentCommandsQueryKey(input: { serverId: string; agentId: string }) {
  return [...agentCommandsQueryRoot(input.serverId), "session", input.agentId] as const;
}

function draftAgentCommandsCheckoutScope(input: { serverId: string; cwd: string }) {
  return [
    ...agentCommandsQueryRoot(input.serverId),
    "draft",
    "cwd",
    normalizeAgentCommandsCwd(input.cwd),
  ] as const;
}

export function draftAgentCommandsQueryKey(input: {
  serverId: string;
  draftConfig: AgentCommandsDraftConfig;
}) {
  const { draftConfig } = input;
  return [
    ...draftAgentCommandsCheckoutScope({ serverId: input.serverId, cwd: draftConfig.cwd }),
    "provider",
    draftConfig.provider,
    "mode",
    draftConfig.modeId ?? null,
    "model",
    draftConfig.model ?? null,
    "thinking",
    draftConfig.thinkingOptionId ?? null,
    "features",
    draftConfig.featureValues ?? null,
  ] as const;
}

// Draft commands include project skills read from the checkout. When the checkout moves to
// another branch the cached list describes files that are gone, so it is dropped rather than
// shown while a refetch runs.
export function resetDraftAgentCommandsForCheckout(
  queryClient: QueryClient,
  input: { serverId: string; cwd: string },
): Promise<void> {
  return queryClient.resetQueries({ queryKey: draftAgentCommandsCheckoutScope(input) });
}

export function agentCommandsQueryKey(input: {
  serverId: string;
  agentId: string;
  draftConfig?: AgentCommandsDraftConfig;
}) {
  if (input.draftConfig) {
    return draftAgentCommandsQueryKey({
      serverId: input.serverId,
      draftConfig: input.draftConfig,
    });
  }
  return sessionAgentCommandsQueryKey({ serverId: input.serverId, agentId: input.agentId });
}
