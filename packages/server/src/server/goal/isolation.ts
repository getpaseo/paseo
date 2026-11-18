import type { Goal } from "@getpaseo/protocol/goal/types";

/**
 * "reference" runs agents in the repository checkout itself. Only a goal created with
 * isolation "workspace" asks for it; every other goal cuts a worktree per agent.
 */
export function isolationOf(goal: Goal): "reference" | "worktree" {
  return goal.config?.isolation === "workspace" ? "reference" : "worktree";
}
