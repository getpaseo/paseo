import type { AgentProvider } from "@getpaseo/protocol/agent-types";
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
