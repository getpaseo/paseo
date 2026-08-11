import {
  deriveAgentStateBucket,
  type AgentAttentionReason,
  type AgentStateBucketInput,
} from "@getpaseo/protocol/agent-state-bucket";

export type SidebarStateBucket =
  | "needs_input"
  | "pending_question"
  | "failed"
  | "running"
  | "attention"
  | "done";
export type SidebarAttentionReason = AgentAttentionReason;

export interface SidebarStateBucketInput extends AgentStateBucketInput {
  pendingQuestionCount?: number;
}

/**
 * `pending_question` is a client-only refinement of `needs_input`: it splits out the
 * permissions that are actually questions so the sidebar can show a distinct badge.
 * It deliberately never travels the wire — `WorkspaceStateBucket` in the protocol has
 * no such member, so a new daemon can't emit a value an older app would reject.
 */
export function deriveSidebarStateBucket(input: SidebarStateBucketInput): SidebarStateBucket {
  if ((input.pendingQuestionCount ?? 0) > 0) {
    return "pending_question";
  }
  return deriveAgentStateBucket(input);
}

export function isSidebarActiveAgent(input: SidebarStateBucketInput): boolean {
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
  "pending_question",
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
