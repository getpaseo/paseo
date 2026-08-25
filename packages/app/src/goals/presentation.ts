import type { AgentGoal, AgentGoalStatus } from "@getpaseo/protocol/agent-types";

export type GoalAction = "pause" | "resume" | "clear";

export function goalStatusKey(status: AgentGoalStatus): `goals.status.${AgentGoalStatus}` {
  return `goals.status.${status}`;
}

export function formatGoalDuration(timeUsedSeconds: number): string {
  const seconds = Math.max(0, Math.floor(timeUsedSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

export function goalActions(goal: AgentGoal): GoalAction[] {
  if (goal.status === "complete") return ["clear"];
  return goal.status === "paused" ? ["resume", "clear"] : ["pause", "clear"];
}
