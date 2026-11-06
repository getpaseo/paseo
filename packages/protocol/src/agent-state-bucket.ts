import type { AgentLifecycleStatus } from "./agent-lifecycle.js";
import type { WorkspaceStateBucket } from "./messages.js";

export type { WorkspaceStateBucket };
export type AgentAttentionReason = "finished" | "error" | "permission" | null | undefined;

export interface AgentStateBucketInput {
  status: AgentLifecycleStatus;
  pendingPermissionCount?: number;
  requiresAttention?: boolean;
  attentionReason?: AgentAttentionReason;
  backgroundWork?: { count: number } | null;
}

const WORKSPACE_STATE_BUCKET_PRIORITY = {
  needs_input: 0,
  failed: 1,
  running: 2,
  attention: 3,
  done: 4,
} as const satisfies Record<WorkspaceStateBucket, number>;

// An error is a notification like a finish: once the user has seen it, the agent stops showing as
// failed even though its lifecycle stays "error" until the next turn starts.
function hasUnreadError(input: AgentStateBucketInput): boolean {
  return input.requiresAttention === true && input.attentionReason === "error";
}

export function deriveAgentStateBucket(input: AgentStateBucketInput): WorkspaceStateBucket {
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return "needs_input";
  }
  if (hasUnreadError(input)) {
    return "failed";
  }
  if (input.status === "running" || (input.backgroundWork?.count ?? 0) > 0) {
    return "running";
  }
  if (input.requiresAttention) {
    return "attention";
  }
  return "done";
}

export function getWorkspaceStateBucketPriority(bucket: WorkspaceStateBucket): number {
  return WORKSPACE_STATE_BUCKET_PRIORITY[bucket];
}

export function getAgentStatusPriority(input: AgentStateBucketInput): number {
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return 0;
  }
  if (hasUnreadError(input)) {
    return 1;
  }
  if (input.status === "running" || (input.backgroundWork?.count ?? 0) > 0) {
    return 2;
  }
  if (input.status === "initializing") {
    return 3;
  }
  return 4;
}
