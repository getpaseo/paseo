import { useEffect } from "react";
import type { AgentStateBucketInput } from "@getpaseo/protocol/agent-state-bucket";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { deriveSidebarStateBucket, type SidebarStateBucket } from "@/utils/sidebar-agent-state";
import {
  providerSubagentKey,
  useProviderSubagentStore,
  watchProviderSubagentParent,
} from "./provider-store";

/**
 * A provider subagent keeps working after its parent's turn ends, so the parent is idle while the
 * work is not. The daemon already counts a running subagent as activity on the owning workspace
 * (`applyProviderSubagentContributions` in workspace-directory), and the agent's own surfaces —
 * the tab, the command center row — have to apply the same rule. Without it a parent waiting on
 * its children reads as "finished, ready for review", which is the one thing it is not.
 */
export function hasRunningProviderSubagent(
  descriptors: ReadonlyMap<string, ProviderSubagentDescriptorPayload>,
  parent: { serverId: string; parentAgentId: string },
): boolean {
  const prefix = providerSubagentKey(parent.serverId, parent.parentAgentId, "");
  for (const [key, descriptor] of descriptors) {
    if (key.startsWith(prefix) && descriptor.status === "running") {
      return true;
    }
  }
  return false;
}

/**
 * The flag the derivation below needs, kept live. Children announce themselves through the
 * provider subagent feed, so a surface that stays mounted flips as they start and settle; the
 * effect only covers the gap a reload leaves behind, since the store lives in memory.
 */
export function useHasRunningProviderSubagent(parent: {
  serverId: string;
  parentAgentId: string;
}): boolean {
  const hasRunning = useProviderSubagentStore((state) =>
    hasRunningProviderSubagent(state.descriptors, parent),
  );
  const client = useSessionStore((state) => state.sessions[parent.serverId]?.client ?? null);
  const supported = useSessionStore(
    (state) => state.sessions[parent.serverId]?.serverInfo?.features?.providerSubagents === true,
  );

  useEffect(() => {
    if (!client || !supported) return;
    // A remount (command center scroll, list recycle) must not ask again. The panel still can.
    // A reconnect clears this cache and refreshes parents that are still mounted.
    return watchProviderSubagentParent(client, parent.serverId, parent.parentAgentId);
  }, [client, parent.parentAgentId, parent.serverId, supported]);

  return hasRunning;
}

/**
 * Running children outrank "finished", and nothing else changes: a pending permission or a
 * failure still wins, because those ask the user for something and a busy child must not hide it.
 */
export function deriveAgentBucketWithSubagentActivity(input: {
  agent: AgentStateBucketInput;
  hasRunningProviderSubagent: boolean;
}): SidebarStateBucket {
  const bucket = deriveSidebarStateBucket(input.agent);
  // Check the real bucket first. Overwriting status to "running" hides an error when the
  // caller did not also pass attentionReason, and it hides a pending permission the same way.
  if (!input.hasRunningProviderSubagent || bucket === "failed" || bucket === "needs_input") {
    return bucket;
  }
  return deriveSidebarStateBucket({ ...input.agent, status: "running" });
}
