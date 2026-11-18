import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import type { Agent } from "@/stores/session-store";
import { hasRunningProviderSubagents } from "./provider-store";

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
