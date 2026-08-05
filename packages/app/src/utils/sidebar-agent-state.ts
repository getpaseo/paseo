import {
  deriveAgentStateBucket,
  type AgentAttentionReason,
  type AgentStateBucketInput,
} from "@getpaseo/protocol/agent-state-bucket";

export type SidebarStateBucket = "needs_input" | "failed" | "running" | "attention" | "done";
export type SidebarAttentionReason = AgentAttentionReason;

export function deriveSidebarStateBucket(input: AgentStateBucketInput): SidebarStateBucket {
  return deriveAgentStateBucket(input);
}

export function isSidebarActiveAgent(input: AgentStateBucketInput): boolean {
  return deriveSidebarStateBucket(input) !== "done";
}

// Most urgent first, for collapsing a project's workspaces into one badge. This is
// deliberately NOT the flat status-list order (STATUS_BUCKET_ORDER in
// hooks/sidebar-status-view-model.ts), which ranks "attention" above "running": on a
// collapsed project row we want an actively-working project to keep showing the loader,
// so "running" outranks "attention" here. Blocked (needs_input) and failed still win over
// both; done stays last.
const STATUS_BUCKET_PRIORITY: readonly SidebarStateBucket[] = [
  "needs_input",
  "failed",
  "running",
  "attention",
  "done",
];

/**
 * Collapses many workspace status buckets into the single most urgent one, so a
 * collapsed project row can stand in for the child rows it hides.
 */
export function aggregateSidebarStateBuckets(
  buckets: Iterable<SidebarStateBucket>,
): SidebarStateBucket {
  let bestRank = STATUS_BUCKET_PRIORITY.length - 1;
  for (const bucket of buckets) {
    const rank = STATUS_BUCKET_PRIORITY.indexOf(bucket);
    if (rank !== -1 && rank < bestRank) {
      bestRank = rank;
    }
  }
  return STATUS_BUCKET_PRIORITY[bestRank] ?? "done";
}
