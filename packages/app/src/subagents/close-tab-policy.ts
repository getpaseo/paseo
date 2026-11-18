import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { Agent } from "@/stores/session-store";
import {
  hasRunningProviderSubagents,
  refreshProviderSubagents,
  useProviderSubagentStore,
  type ProviderSubagentListClient,
} from "./provider-store";

export type CloseAgentTabPolicy =
  | { kind: "archive-on-close"; confirmArchive: boolean }
  | { kind: "layout-only" };

type CloseTabAgent = Pick<Agent, "serverId" | "id" | "parentAgentId" | "status" | "backgroundWork">;

export function resolveCloseAgentTabPolicy(
  agent: CloseTabAgent | null | undefined,
  providerSubagents: ReadonlyMap<string, ProviderSubagentDescriptorPayload>,
): CloseAgentTabPolicy {
  if (agent?.parentAgentId) {
    return { kind: "layout-only" };
  }

  return {
    kind: "archive-on-close",
    confirmArchive: agent ? hasRunningWork(agent, providerSubagents) : false,
  };
}

/**
 * Resolves the policy against the daemon's current subagent list. This client only holds the
 * subagents of agents it has rendered or heard about while connected, so a tab restored after a
 * reload would otherwise close without asking while its background subagent runs.
 */
export async function loadCloseAgentTabPolicy(input: {
  agent: CloseTabAgent | null | undefined;
  /** Null when the host does not report provider subagents or no client is connected. */
  providerSubagents: ProviderSubagentListClient | null;
}): Promise<CloseAgentTabPolicy> {
  const { agent, providerSubagents } = input;
  const cached = resolveCloseAgentTabPolicy(agent, useProviderSubagentStore.getState().descriptors);
  if (!agent || !providerSubagents || cached.kind !== "archive-on-close" || cached.confirmArchive) {
    return cached;
  }
  try {
    await refreshProviderSubagents(providerSubagents, agent.serverId, agent.id);
  } catch {
    return cached;
  }
  return resolveCloseAgentTabPolicy(agent, useProviderSubagentStore.getState().descriptors);
}

// Archiving stops the agent's process, which also stops work it left running after its turn
// ended: background subagents and background shells.
function hasRunningWork(
  agent: CloseTabAgent,
  providerSubagents: ReadonlyMap<string, ProviderSubagentDescriptorPayload>,
): boolean {
  return (
    agent.status === "running" ||
    (agent.backgroundWork?.count ?? 0) > 0 ||
    hasRunningProviderSubagents(providerSubagents, agent.serverId, agent.id)
  );
}
