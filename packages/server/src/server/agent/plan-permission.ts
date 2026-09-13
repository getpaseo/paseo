import { createHash } from "node:crypto";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentStreamEvent,
  AgentTimelineItem,
} from "./agent-sdk-types.js";

export interface SyntheticPlanDecision {
  text: string;
  permissionId: string;
  sourceTurnId?: string;
  previousModeId?: string;
  prepared?: true;
  resolution: AgentPermissionResponse;
  outcome: "pending" | "completed" | "outcome_unknown";
}

export function assertSyntheticPlanOutcome(saved: SyntheticPlanDecision): void {
  // COMPAT(synthetic-prepared-boundary): added in v0.8.0, remove after 2027-09-14.
  // Older pending snapshots may already have delivered a prompt.
  if (saved.outcome === "pending" && !saved.prepared)
    throw new Error(
      "Plan approval outcome_unknown. This older pending decision cannot be replayed automatically.",
    );
  if (saved.outcome !== "pending")
    throw new Error(
      "This plan is already resolved. Inspect its durable approval outcome before continuing.",
    );
}

export function assertSyntheticPlanRetry(
  rows: AgentTimelineRow[],
  callId: string,
  saved: SyntheticPlanDecision | undefined,
): void {
  if (!saved) return;
  const current = rows.findLast(({ item }) => item.type === "tool_call" && item.callId === callId);
  if (
    current?.item.type === "tool_call" &&
    (current.item.detail.type !== "plan" ||
      current.item.detail.text !== saved.text ||
      (saved.sourceTurnId !== undefined &&
        current.turnId !== undefined &&
        current.turnId !== saved.sourceTurnId))
  )
    throw new Error(
      "This plan changed after a durable decision. Open a new plan call; the old call cannot be reopened.",
    );
  assertSyntheticPlanOutcome(saved);
}

export function syntheticPlanResolution(
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
  decision: SyntheticPlanDecision,
): AgentTimelineItem {
  return {
    ...item,
    status: "completed",
    error: null,
    metadata: {
      ...item.metadata,
      approved: decision.resolution.behavior === "allow",
      resolution: decision.resolution,
      syntheticPermissionId: decision.permissionId,
      approvalOutcome: decision.outcome,
    },
  };
}

export function restoreSyntheticPlanDecisions(
  history: AgentStreamEvent[],
  decisions: Record<string, SyntheticPlanDecision>,
): AgentStreamEvent[] {
  const latest = new Map<string, number>();
  history.forEach((event, index) => {
    if (event.type === "timeline" && event.item.type === "tool_call")
      latest.set(event.item.callId, index);
  });
  return history.flatMap((event, index) => {
    if (
      event.type !== "timeline" ||
      event.item.type !== "tool_call" ||
      event.item.detail.type !== "plan"
    )
      return [event];
    const decision = decisions[event.item.callId];
    if (
      !decision ||
      latest.get(event.item.callId) !== index ||
      event.item.detail.text !== decision.text ||
      (decision.sourceTurnId !== undefined &&
        event.turnId !== undefined &&
        event.turnId !== decision.sourceTurnId)
    )
      return [event];
    const source = { ...event, turnId: event.turnId ?? decision.sourceTurnId };
    if (decision.outcome === "pending" && decision.prepared) return [source];
    // COMPAT(synthetic-prepared-boundary): added in v0.8.0, remove after 2027-09-14.
    const settled =
      decision.outcome === "pending"
        ? { ...decision, outcome: "outcome_unknown" as const }
        : decision;
    return [source, { ...source, item: syntheticPlanResolution(event.item, settled) }];
  });
}

export function hasPlanDecision(item: AgentTimelineItem): boolean {
  if (item.type !== "tool_call") return false;
  const resolution = item.metadata?.resolution;
  return (
    typeof item.metadata?.approved === "boolean" ||
    (typeof resolution === "object" &&
      resolution !== null &&
      "behavior" in resolution &&
      (resolution.behavior === "allow" || resolution.behavior === "deny"))
  );
}

export function findPlanProposal(rows: AgentTimelineRow[], callId: string) {
  const matching = rows.filter(({ item }) => item.type === "tool_call" && item.callId === callId);
  if (matching.some(({ item }) => hasPlanDecision(item)))
    throw new Error("This plan is already resolved. Open the current plan.");
  const row = matching.at(-1);
  if (
    !row ||
    row.item.type !== "tool_call" ||
    row.item.detail.type !== "plan" ||
    row.item.error ||
    !row.item.detail.text.trim()
  )
    throw new Error(
      "The canonical structured plan is unavailable. Reopen the current conversation.",
    );
  if (!rows.some((entry) => entry.seq < row.seq && entry.item.type === "user_message"))
    throw new Error("The plan has no canonical conversation request.");
  return { ...row, item: row.item, text: row.item.detail.text };
}

export function syntheticPlanPermissionId(agentId: string, sessionId: string, callId: string) {
  return `paseo-plan-${createHash("sha256")
    .update(JSON.stringify([agentId, sessionId, callId]))
    .digest("hex")}`;
}

export function findCapturedPlan(rows: AgentTimelineRow[], pending: AgentPermissionRequest) {
  const proposal = findPlanProposal(rows, pending.sourcePlanCallId ?? "");
  const captured = pending.input;
  if (
    !captured ||
    typeof captured !== "object" ||
    !("plan" in captured) ||
    captured.plan !== proposal.text ||
    (pending.metadata?.sourcePlanTurnId !== undefined &&
      pending.metadata.sourcePlanTurnId !== proposal.turnId)
  )
    throw new Error(
      "This plan changed after its permission was captured. Reopen the current plan; this stale approval cannot execute it.",
    );
  return proposal;
}
