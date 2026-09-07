import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { Query, QueryClient } from "@tanstack/react-query";
import { normalizeWorkspacePath } from "@/utils/workspace-identity";

export const AGENT_COMMANDS_QUERY_ROOT = "agentCommands";

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

export function sessionAgentCommandsQueryKey(input: { serverId: string; agentId: string }) {
  return [...agentCommandsQueryRoot(input.serverId), "session", input.agentId] as const;
}

export function draftAgentCommandsQueryKey(input: {
  serverId: string;
  draftConfig: AgentCommandsDraftConfig;
}) {
  const { draftConfig } = input;
  return [
    ...agentCommandsQueryRoot(input.serverId),
    "draft",
    draftConfig.provider,
    "cwd",
    normalizeAgentCommandsCwd(draftConfig.cwd),
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

export function isDraftAgentCommandsQueryForCwd(input: {
  queryKey: readonly unknown[];
  serverId: string;
  cwd: string;
}): boolean {
  return (
    isDraftAgentCommandsQueryForServer(input) &&
    input.queryKey[5] === normalizeAgentCommandsCwd(input.cwd)
  );
}

function isDraftAgentCommandsQueryForServer(input: {
  queryKey: readonly unknown[];
  serverId: string;
}): boolean {
  return (
    input.queryKey[0] === AGENT_COMMANDS_QUERY_ROOT &&
    input.queryKey[1] === input.serverId &&
    input.queryKey[2] === "draft"
  );
}

// Draft command queries are only enabled while the command menu is open, so timing decides who
// pays for rediscovery. "now" refetches an open menu on the spot. "next-open" marks the cache
// stale and stops there, so a burst of updates cannot restart provider discovery while the user
// is typing; the menu picks up the new commands the next time it opens.
export type DraftAgentCommandsRefreshTiming = "now" | "next-open";

export async function invalidateDraftAgentCommandsForCwd(input: {
  queryClient: QueryClient;
  serverId: string;
  cwd: string;
  timing: DraftAgentCommandsRefreshTiming;
}): Promise<void> {
  const predicate = (query: Query) =>
    isDraftAgentCommandsQueryForCwd({
      queryKey: query.queryKey,
      serverId: input.serverId,
      cwd: input.cwd,
    });
  await invalidateDraftAgentCommands({ ...input, predicate });
}

export async function invalidateDraftAgentCommandsForServer(input: {
  queryClient: QueryClient;
  serverId: string;
  timing: DraftAgentCommandsRefreshTiming;
}): Promise<void> {
  const predicate = (query: Query) =>
    isDraftAgentCommandsQueryForServer({
      queryKey: query.queryKey,
      serverId: input.serverId,
    });
  await invalidateDraftAgentCommands({ ...input, predicate });
}

async function invalidateDraftAgentCommands(input: {
  queryClient: QueryClient;
  timing: DraftAgentCommandsRefreshTiming;
  predicate: (query: Query) => boolean;
}): Promise<void> {
  const hasInFlightQuery =
    input.timing === "next-open" &&
    input.queryClient
      .getQueryCache()
      .findAll({ predicate: input.predicate })
      .some((query) => query.state.fetchStatus !== "idle");
  const cancellation = hasInFlightQuery
    ? input.queryClient.cancelQueries({ predicate: input.predicate })
    : undefined;

  // Mark stale immediately so a menu opening in the same turn observes the invalidation. If an
  // in-flight query was canceled, repeat the mark afterward because cancellation restores its
  // prior state and clears isInvalidated.
  await input.queryClient.invalidateQueries({
    refetchType: input.timing === "next-open" ? "none" : undefined,
    predicate: input.predicate,
  });
  if (cancellation) {
    await cancellation;
    await input.queryClient.invalidateQueries({
      refetchType: "none",
      predicate: input.predicate,
    });
  }
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
