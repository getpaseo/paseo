import { useCallback } from "react";
import { useAgentDescriptor } from "@/agent-presentation";
import type { PanelDescriptor } from "@/panels/panel-registry";
import { useLeaveSheet } from "@/screens/workspace/sheet-pane";
import { useSessionStore } from "@/stores/session-store";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { navigateToAgent } from "@/utils/navigate-to-agent";

export interface ParentAgent {
  /** The parent's title, or null while it has none — callers fall back to a generic name. */
  label: string | null;
  icon: PanelDescriptor["icon"];
  statusBucket: SidebarStateBucket | null;
  open: () => void;
}

/** The parent of a managed agent, or null for a root or detached agent. */
export function useParentAgentId(serverId: string, agentId: string): string | null {
  return useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return agent?.parentAgentId ?? null;
  });
}

/** The parent as its own tab presents it, and the way back to it. */
export function useParentAgent(serverId: string, parentAgentId: string): ParentAgent {
  const descriptor = useAgentDescriptor({ kind: "agent", agentId: parentAgentId }, { serverId });
  const leaveSheet = useLeaveSheet();
  // Going back to the parent leaves the sheet the child is shown in. When the child was chosen
  // from the parent's list, closing the sheet already uncovers the parent; otherwise the parent
  // may live anywhere, even another workspace, and navigateToAgent opens it wherever it is.
  const open = useCallback(() => {
    if (leaveSheet({ kind: "agent", agentId: parentAgentId })) return;
    navigateToAgent({ serverId, agentId: parentAgentId });
  }, [leaveSheet, parentAgentId, serverId]);
  return {
    label: descriptor.label || null,
    icon: descriptor.icon,
    statusBucket: descriptor.statusBucket,
    open,
  };
}
