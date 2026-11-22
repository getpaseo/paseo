import type { AgentLifecycleStatus } from "./agent-lifecycle.js";
import type { AgentBackgroundWorkSummary, WorkspaceStateBucket } from "./messages.js";

export type { WorkspaceStateBucket };
export type WorkspaceDisplayStatus = WorkspaceStateBucket | "needs_follow_up";

export function getWorkspaceDisplayStatus(workspace: {
  status: WorkspaceStateBucket;
  reviewResults?: readonly { followUpAt?: string; nested?: boolean }[];
}): WorkspaceDisplayStatus {
  return workspace.status === "done" &&
    workspace.reviewResults?.some((result) => !result.nested && result.followUpAt)
    ? "needs_follow_up"
    : workspace.status;
}

// A later autonomous finish can reuse an unread notification's timestamp.
export function getAttentionKey(input: {
  attentionReason?: AgentAttentionReason;
  attentionTimestamp?: string | null;
  reviewResult?: { id: string };
}): string | null {
  if (!input.attentionTimestamp) return null;
  return JSON.stringify([input.attentionReason, input.attentionTimestamp, input.reviewResult?.id]);
}
export type AgentAttentionReason = "finished" | "error" | "permission" | null | undefined;

export interface AgentStateBucketInput {
  status: AgentLifecycleStatus;
  pendingPermissionCount?: number;
  requiresAttention?: boolean;
  attentionReason?: AgentAttentionReason;
  backgroundWork?: AgentBackgroundWorkSummary | null;
}

export function isAgentRunning(input: {
  status: AgentLifecycleStatus | null | undefined;
  backgroundWork?: AgentBackgroundWorkSummary | null;
}): boolean {
  const { status, backgroundWork } = input;
  return status === "running" || (backgroundWork?.runningCount ?? backgroundWork?.count ?? 0) > 0;
}

const WORKSPACE_STATE_BUCKET_PRIORITY = {
  needs_input: 0,
  failed: 1,
  running: 2,
  attention: 3,
  needs_follow_up: 4,
  done: 5,
} as const satisfies Record<WorkspaceDisplayStatus, number>;

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
  if (isAgentRunning(input)) {
    return "running";
  }
  if (input.requiresAttention) {
    return "attention";
  }
  return "done";
}

export function getWorkspaceStateBucketPriority(bucket: WorkspaceDisplayStatus): number {
  return WORKSPACE_STATE_BUCKET_PRIORITY[bucket];
}

export function getAgentStatusPriority(input: AgentStateBucketInput): number {
  if ((input.pendingPermissionCount ?? 0) > 0 || input.attentionReason === "permission") {
    return 0;
  }
  if (hasUnreadError(input)) {
    return 1;
  }
  if (isAgentRunning(input)) {
    return 2;
  }
  if (input.status === "initializing") {
    return 3;
  }
  return 4;
}
