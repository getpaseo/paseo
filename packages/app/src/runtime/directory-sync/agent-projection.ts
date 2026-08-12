import type { FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { Agent } from "@/stores/session-store";

export function projectAgentSnapshot(agent: Agent): AgentSnapshotPayload {
  return {
    id: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
    model: agent.model,
    ...(agent.features ? { features: agent.features } : {}),
    thinkingOptionId: agent.thinkingOptionId ?? null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    lastUserMessageAt: agent.lastUserMessageAt?.toISOString() ?? null,
    status: agent.status,
    capabilities: agent.capabilities,
    currentModeId: agent.currentModeId,
    availableModes: agent.availableModes,
    pendingPermissions: agent.pendingPermissions,
    persistence: agent.persistence,
    ...(agent.runtimeInfo ? { runtimeInfo: agent.runtimeInfo } : {}),
    ...(agent.lastUsage ? { lastUsage: agent.lastUsage } : {}),
    ...(agent.lastError ? { lastError: agent.lastError } : {}),
    title: agent.title,
    labels: agent.labels,
    requiresAttention: agent.requiresAttention ?? false,
    attentionReason: agent.attentionReason ?? null,
    attentionTimestamp: agent.attentionTimestamp?.toISOString() ?? null,
    archivedAt: agent.archivedAt?.toISOString() ?? null,
  };
}

export function projectAgentDirectoryEntry(agent: Agent): FetchAgentsEntry | null {
  return agent.projectPlacement
    ? { agent: projectAgentSnapshot(agent), project: agent.projectPlacement }
    : null;
}
