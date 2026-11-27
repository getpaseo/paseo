import type { GoalEvent, GoalStatus } from "@getpaseo/protocol/goal/types";
import type { StatusBadgeVariant } from "@/components/ui/status-badge";

const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

export const GOAL_STATUS_BADGE: Record<GoalStatus, StatusBadgeVariant> = {
  planning: "running",
  awaiting_plan_approval: "warning",
  executing: "running",
  completed: "success",
  failed: "error",
  cancelled: "muted",
};

export function isGoalTerminal(status: GoalStatus): boolean {
  return TERMINAL_GOAL_STATUSES.has(status);
}

export function canApproveGoalPlan(status: GoalStatus): boolean {
  return status === "awaiting_plan_approval";
}

/** The id or reason an event is about, shown next to its raw type in the history list. */
export function goalEventSubject(event: GoalEvent): string | null {
  switch (event.type) {
    case "task.started":
    case "task.succeeded":
    case "task.retried":
    case "task.cancelled":
      return event.taskId;
    case "task.failed":
      return `${event.taskId}: ${event.error}`;
    case "criterion.verified":
      return event.criterionId;
    case "plan.rejected":
    case "goal.failed":
      return event.reason;
    case "plan.proposed":
      return event.tasks.map((task) => task.id).join(", ");
    default:
      return null;
  }
}
