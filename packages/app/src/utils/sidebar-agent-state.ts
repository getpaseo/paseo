import {
  deriveAgentStateBucket,
  type AgentAttentionReason,
  type AgentStateBucketInput,
} from "@getpaseo/protocol/agent-state-bucket";

export type SidebarStateBucket = "needs_input" | "failed" | "running" | "attention" | "done";
export type SidebarAttentionReason = AgentAttentionReason;

type SidebarAgentStateInput = AgentStateBucketInput & {
  routingNotice?: { status: string };
};

export function deriveSidebarStateBucket(input: SidebarAgentStateInput): SidebarStateBucket {
  if (input.routingNotice?.status === "waiting") {
    return deriveAgentStateBucket({
      ...input,
      status: input.status === "error" ? "error" : "idle",
      requiresAttention:
        input.attentionReason === "permission" || input.attentionReason === "error",
    });
  }
  return deriveAgentStateBucket(input);
}

export function isSidebarActiveAgent(input: SidebarAgentStateInput): boolean {
  return deriveSidebarStateBucket(input) !== "done";
}
const STATUS_BUCKET_PRIORITY: readonly SidebarStateBucket[] = [
  "needs_input",
  "failed",
  "running",
  "attention",
  "done",
];

export const STATUS_BUCKET_ORDER: readonly SidebarStateBucket[] = [
  "needs_input",
  "failed",
  "attention",
  "running",
  "done",
] as const;

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
