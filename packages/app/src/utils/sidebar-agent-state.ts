import type { AgentLifecycleStatus } from "@server/shared/agent-lifecycle";

export type SidebarAttentionReason =
  | "finished"
  | "error"
  | "permission"
  | null
  | undefined;

export type SidebarStateBucket =
  | "needs_input"
  | "failed"
  | "running"
  | "attention"
  | "done";

export function deriveSidebarStateBucket(input: {
  status: AgentLifecycleStatus;
  pendingPermissionCount?: number;
  requiresAttention?: boolean;
  attentionReason?: SidebarAttentionReason;
}): SidebarStateBucket {
  if ((input.pendingPermissionCount ?? 0) > 0) {
    return "needs_input";
  }
  // Legacy fallback for snapshots persisted before permission state was decoupled
  // from unread attention.
  if (input.attentionReason === "permission") {
    return "needs_input";
  }
  if (input.status === "error" || input.attentionReason === "error") {
    return "failed";
  }
  if (input.status === "running") {
    return "running";
  }
  if (input.requiresAttention) {
    // Unread/attention-needed completed agents are active in sidebar logic.
    return "attention";
  }
  return "done";
}

export function isSidebarActiveAgent(input: {
  status: AgentLifecycleStatus;
  pendingPermissionCount?: number;
  requiresAttention?: boolean;
  attentionReason?: SidebarAttentionReason;
}): boolean {
  return deriveSidebarStateBucket(input) !== "done";
}
