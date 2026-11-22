import {
  deriveAgentStateBucket,
  getWorkspaceStateBucketPriority,
  type WorkspaceDisplayStatus,
  type AgentAttentionReason,
  type AgentStateBucketInput,
} from "@getpaseo/protocol/agent-state-bucket";

export type SidebarStateBucket = WorkspaceDisplayStatus;
export type SidebarAttentionReason = AgentAttentionReason;

export function deriveSidebarStateBucket(input: AgentStateBucketInput) {
  return deriveAgentStateBucket(input);
}

export function deriveChatStatusBucket(
  input: AgentStateBucketInput,
  needsFollowUp: boolean,
): SidebarStateBucket {
  const activity = deriveAgentStateBucket(input);
  return activity === "done" && needsFollowUp ? "needs_follow_up" : activity;
}

export function isSidebarActiveAgent(input: AgentStateBucketInput): boolean {
  return deriveSidebarStateBucket(input) !== "done";
}

/**
 * The order states are listed in when all of them are shown side by side rather than collapsed
 * into one — the sidebar's status groups, and the subagent pill's segments. Anything the user has
 * to act on comes before anything that is still moving on its own.
 */
export const STATUS_BUCKET_ORDER: readonly SidebarStateBucket[] = [
  "needs_input",
  "failed",
  "attention",
  "needs_follow_up",
  "running",
  "done",
] as const;

/**
 * Collapses many workspace status buckets into the single most urgent one, so a
 * collapsed project row can stand in for the child rows it hides.
 */
export function aggregateSidebarStateBuckets(
  buckets: Iterable<SidebarStateBucket>,
): SidebarStateBucket {
  let highest: SidebarStateBucket = "done";
  for (const bucket of buckets) {
    if (getWorkspaceStateBucketPriority(bucket) < getWorkspaceStateBucketPriority(highest)) {
      highest = bucket;
    }
  }
  return highest;
}
