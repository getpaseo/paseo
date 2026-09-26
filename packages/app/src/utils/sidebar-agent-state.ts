import {
  deriveAgentStateBucket,
  type AgentAttentionReason,
  type AgentStateBucketInput,
} from "@getpaseo/protocol/agent-state-bucket";
import type { SubagentActivity } from "@/utils/subagent-activity";

/**
 * Every state the app can show for an agent or workspace. The protocol's `WorkspaceStateBucket`
 * is a subset: `waiting_on_subagent` is derived on the client and never travels on the wire, so
 * an old client and an old daemon keep their existing five states.
 */
export type SidebarStateBucket =
  | "needs_input"
  | "failed"
  | "running"
  | "attention"
  | "waiting_on_subagent"
  | "done";

export type SidebarAttentionReason = AgentAttentionReason;

export interface AgentDisplayStateInput extends AgentStateBucketInput {
  /** Descendant activity from `selectSubagentActivity`, when the caller can see the directory. */
  subagentActivity?: SubagentActivity;
}

/**
 * The bucket an agent contributes to the UI.
 *
 * Own running, permission, and error states always win: a parent blocked on its own permission
 * must not be relabelled because a child is running. A parent whose own turn has stopped is not
 * finished while it still owns moving descendants, so `attention` (finished) and `done` both give
 * way to `waiting_on_subagent`; a descendant waiting on permission surfaces as `needs_input`.
 */
export function deriveSidebarStateBucket(input: AgentDisplayStateInput): SidebarStateBucket {
  const ownBucket = deriveAgentStateBucket(input);
  if (ownBucket !== "attention" && ownBucket !== "done") {
    return ownBucket;
  }

  const subagentActivity = input.subagentActivity ?? "none";
  if (subagentActivity === "blocked") {
    return "needs_input";
  }
  if (subagentActivity === "active") {
    return "waiting_on_subagent";
  }
  return ownBucket;
}

export function isSidebarActiveAgent(input: AgentDisplayStateInput): boolean {
  return deriveSidebarStateBucket(input) !== "done";
}

// Most urgent first, for collapsing a project's workspaces into one badge. This is
// deliberately NOT STATUS_BUCKET_ORDER below, which ranks "attention" above "running": on a
// collapsed project row we want an actively-working project to keep showing the loader,
// so "running" outranks "attention" here. needs_input and failed still win over both;
// "waiting_on_subagent" tracks running — its child's work is still moving — and done stays last.
const STATUS_BUCKET_PRIORITY: readonly SidebarStateBucket[] = [
  "needs_input",
  "failed",
  "running",
  "waiting_on_subagent",
  "attention",
  "done",
];

/**
 * The order states are listed in when all of them are shown side by side rather than collapsed
 * into one — the sidebar's status groups, and the subagent pill's segments. Anything the user has
 * to act on comes before anything that is still moving on its own.
 */
export const STATUS_BUCKET_ORDER: readonly SidebarStateBucket[] = [
  "needs_input",
  "failed",
  "attention",
  "running",
  "waiting_on_subagent",
  "done",
] as const;

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

/** Lower is more urgent. Used to fold several root agents in one workspace into one state. */
export function getSidebarStateBucketPriority(bucket: SidebarStateBucket): number {
  return STATUS_BUCKET_PRIORITY.indexOf(bucket);
}
