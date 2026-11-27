import type { ChangeSet, ChangeSetStatus, Goal, Task } from "@getpaseo/protocol/goal/types";

export type GoalTaskGroupId = "attention" | "running" | "pending" | "done";

export interface GoalTaskGroup {
  id: GoalTaskGroupId;
  tasks: Task[];
}

const GROUP_ORDER: readonly GoalTaskGroupId[] = ["attention", "running", "pending", "done"];

function groupOf(task: Task): GoalTaskGroupId {
  switch (task.status) {
    case "failed":
      return "attention";
    case "running":
      return "running";
    case "pending":
      return "pending";
    case "succeeded":
    case "cancelled":
      return "done";
  }
}

/** Tasks by what they need from you, in plan order within each group. Empty groups are left out. */
export function groupGoalTasks(goal: Pick<Goal, "tasks">): GoalTaskGroup[] {
  return GROUP_ORDER.map((id) => ({
    id,
    tasks: goal.tasks.filter((task) => groupOf(task) === id),
  })).filter((group) => group.tasks.length > 0);
}

export interface GoalAgentTarget {
  agentId: string;
  workspaceId: string | null;
}

/** The agent of the task's latest run that has one: the one running now, or the last to run. */
export function latestTaskAgent(goal: Pick<Goal, "runs">, taskId: string): GoalAgentTarget | null {
  for (let index = goal.runs.length - 1; index >= 0; index -= 1) {
    const run = goal.runs[index];
    if (run?.taskId === taskId && run.agentId) {
      return { agentId: run.agentId, workspaceId: run.workspaceId };
    }
  }
  return null;
}

/**
 * The thinking level the task's latest run started with: the one asked for, or the provider's
 * default when it reports one. Null when no run recorded one, as with daemons before goal thinking.
 */
export function latestTaskThinking(goal: Pick<Goal, "runs">, taskId: string): string | null {
  for (let index = goal.runs.length - 1; index >= 0; index -= 1) {
    const run = goal.runs[index];
    if (run?.taskId === taskId) {
      return run.thinking ?? null;
    }
  }
  return null;
}

const CHANGE_SET_ORDER: Partial<Record<ChangeSetStatus, number>> = {
  awaiting_human: 0,
  conflicted: 1,
  test_failed: 1,
  changes_requested: 1,
  in_review: 2,
  captured: 2,
  approved: 3,
  integrating: 3,
};
const SETTLED_ORDER = 4;

/** Change sets worth showing: superseded rounds are dropped, ones waiting on you come first. */
export function visibleChangeSets(goal: Pick<Goal, "changeSets">): ChangeSet[] {
  return goal.changeSets
    .filter((changeSet) => changeSet.status !== "superseded")
    .sort((a, b) => {
      const order =
        (CHANGE_SET_ORDER[a.status] ?? SETTLED_ORDER) -
        (CHANGE_SET_ORDER[b.status] ?? SETTLED_ORDER);
      return order !== 0 ? order : Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    });
}
