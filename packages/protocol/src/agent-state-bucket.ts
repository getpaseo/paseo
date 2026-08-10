import type { AgentLifecycleStatus } from "./agent-lifecycle.js";
import type { WorkspaceStateBucket } from "./messages.js";

export type { WorkspaceStateBucket };
export type AgentAttentionReason = "finished" | "error" | "permission" | null | undefined;

export interface AgentStateBucketInput {
  status: AgentLifecycleStatus;
  pendingPermissionCount?: number;
  pendingQuestionCount?: number;
  requiresAttention?: boolean;
  attentionReason?: AgentAttentionReason;
}

const WORKSPACE_STATE_BUCKET_PRIORITY = {
  needs_input: 0,
  pending_question: 1,
  failed: 2,
  running: 3,
  attention: 4,
  done: 5,
} as const satisfies Record<WorkspaceStateBucket, number>;

export function deriveAgentStateBucket(input: AgentStateBucketInput): WorkspaceStateBucket {
  if ((input.pendingQuestionCount ?? 0) > 0) {
    return "pending_question";
  }
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return "needs_input";
  }
  if (input.status === "error" || input.attentionReason === "error") {
    return "failed";
  }
  if (input.status === "running") {
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
  if ((input.pendingQuestionCount ?? 0) > 0) {
    return 0;
  }
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return 1;
  }
  if (input.status === "error" || input.attentionReason === "error") {
    return 2;
  }
  if (input.status === "running") {
    return 3;
  }
  if (input.status === "initializing") {
    return 4;
  }
  return 5;
}
