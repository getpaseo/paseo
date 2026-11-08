import type { Goal, GoalProgressSummary, GoalSummary } from "./types.js";

/** Task counts for a list row. Cancelled and pending tasks count only toward the total. */
export function summarizeGoalProgress(goal: Goal): GoalProgressSummary {
  let tasksDone = 0;
  let tasksFailed = 0;
  let tasksRunning = 0;
  for (const task of goal.tasks) {
    if (task.status === "succeeded") tasksDone += 1;
    else if (task.status === "failed") tasksFailed += 1;
    else if (task.status === "running") tasksRunning += 1;
  }
  return { tasksTotal: goal.tasks.length, tasksDone, tasksFailed, tasksRunning };
}

/** The shape goal.list and goal.update carry. */
export function toGoalSummary(goal: Goal): GoalSummary {
  return { ...goal, progress: summarizeGoalProgress(goal) };
}
