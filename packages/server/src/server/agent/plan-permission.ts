import { createHash } from "node:crypto";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

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
