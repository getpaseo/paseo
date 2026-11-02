import type { Goal } from "@getpaseo/protocol/goal/types";
import type { GoalLoadState } from "@/hooks/use-goals";

export type GoalsScreenBodyState =
  | { kind: "no-host" }
  | { kind: "loading" }
  | { kind: "update-host" }
  | { kind: "load-error" }
  | { kind: "empty" }
  | { kind: "content" };

export function resolveGoalsScreenBodyState(input: {
  hasHost: boolean;
  /** `null` until the host has reported its server info. */
  supportsGoals: boolean | null;
  loadState: GoalLoadState<Goal[]>;
  isError: boolean;
}): GoalsScreenBodyState {
  if (!input.hasHost) {
    return { kind: "no-host" };
  }
  if (input.supportsGoals === null) {
    return { kind: "loading" };
  }
  if (!input.supportsGoals) {
    return { kind: "update-host" };
  }
  if (input.loadState.status !== "loaded") {
    return input.isError ? { kind: "load-error" } : { kind: "loading" };
  }
  if (input.loadState.data.length === 0) {
    return { kind: "empty" };
  }
  return { kind: "content" };
}
