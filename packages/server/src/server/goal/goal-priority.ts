import type { Goal, GoalPriority } from "@getpaseo/protocol/goal/types";

const PRIORITY_RANK: Record<GoalPriority, number> = { high: 0, normal: 1, low: 2 };

/** A goal without a priority is "normal". */
export function goalPriority(goal: Pick<Goal, "priority">): GoalPriority {
  return goal.priority ?? "normal";
}

/**
 * Higher priority first, then older first. Uses only recorded state, so the same
 * goals always come out in the same order.
 */
export function sortGoalsByPriority<T extends Pick<Goal, "priority" | "createdAt" | "id">>(
  goals: readonly T[],
): T[] {
  return [...goals].sort(
    (a, b) =>
      PRIORITY_RANK[goalPriority(a)] - PRIORITY_RANK[goalPriority(b)] ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}
