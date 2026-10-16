import type {
  ProviderSubagentStatus,
  ProviderSubagentWorkflowAgent,
} from "../../../provider-subagents/store.js";

/**
 * Claude Code reports a workflow's agents as `workflow_agent` entries, alongside
 * `workflow_phase` markers. The live stream carries them on `task_progress` as
 * `workflow_progress`, a field the SDK types omit; the persisted run summary carries the same
 * entries as `workflowProgress`. Both hold the whole list, already in launch order.
 *
 * Verified on Claude Code 2.1.286: an agent is `start` while it waits for a concurrency slot,
 * keeps `start` with a `startedAt` once it has one, reports `progress` while it works, and ends
 * `done`, `error` or `cancelled`. Claude's own desktop app draws the same split.
 */
export function readClaudeWorkflowAgents(
  progress: unknown,
): ProviderSubagentWorkflowAgent[] | undefined {
  if (!Array.isArray(progress)) return undefined;
  const agents: ProviderSubagentWorkflowAgent[] = [];
  for (const value of progress) {
    const entry = toRecord(value);
    if (entry?.type !== "workflow_agent") continue;
    agents.push({
      status: mapWorkflowAgentState(entry.state, entry.startedAt !== undefined),
      label: readString(entry.label),
      lastProgressAt: typeof entry.lastProgressAt === "number" ? entry.lastProgressAt : null,
    });
  }
  return agents;
}

/** Equal lists produce no upsert: some progress frames only move an agent's tool counter. */
export function workflowAgentsEqual(
  left: readonly ProviderSubagentWorkflowAgent[] | undefined,
  right: readonly ProviderSubagentWorkflowAgent[],
): boolean {
  if (!left || left.length !== right.length) return false;
  return left.every((agent, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      agent.status === other.status &&
      agent.label === other.label &&
      agent.lastProgressAt === other.lastProgressAt
    );
  });
}

/**
 * A finished workflow has no agent left working, but a killed run stops reporting with agents
 * mid-state. One still queued never ran; one still running finished with the run or was stopped
 * by it.
 */
export function settleWorkflowAgents(
  agents: readonly ProviderSubagentWorkflowAgent[],
  workflowStatus: Exclude<ProviderSubagentStatus, "running">,
): ProviderSubagentWorkflowAgent[] {
  return agents.map((agent) => {
    if (agent.status === "queued") return { ...agent, status: "canceled" };
    if (agent.status !== "running") return agent;
    return { ...agent, status: workflowStatus === "completed" ? "completed" : "canceled" };
  });
}

function mapWorkflowAgentState(
  state: unknown,
  started: boolean,
): ProviderSubagentWorkflowAgent["status"] {
  switch (state) {
    case "start":
    case "pending":
    case "queued":
      return started ? "running" : "queued";
    case "done":
    case "completed":
      return "completed";
    case "error":
    case "failed":
      return "failed";
    case "cancelled":
    case "canceled":
    case "killed":
    case "stopped":
      return "canceled";
    default:
      return "running";
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
