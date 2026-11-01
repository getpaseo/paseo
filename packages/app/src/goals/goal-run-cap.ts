import { GOAL_DAEMON_BOUNDS } from "@getpaseo/protocol/goal/config-bounds";
import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@getpaseo/protocol/messages";
import { plainNumberFormat } from "@/utils/scrub-number";
import type { GoalNumberField } from "./goal-number-fields";

const BOUND = GOAL_DAEMON_BOUNDS.maxConcurrentRuns;

export const GOAL_RUN_CAP_DEFAULT = BOUND.default;

/** The daemon-wide cap on worker runs across all goals, typed, shown and scrubbed as a count. */
export const GOAL_RUN_CAP_FIELD: GoalNumberField = {
  scale: { min: BOUND.min, max: BOUND.max, step: 1, fineStep: 1 },
  format: plainNumberFormat({ integer: true }),
  inputMode: "numeric",
};

/** The cap the host runs with: its configured value, or the daemon default when unset. */
export function goalRunCapOf(config: Pick<MutableDaemonConfig, "goals"> | null): number {
  return config?.goals?.maxConcurrentRuns ?? GOAL_RUN_CAP_DEFAULT;
}

/** The patch that saves `draft`, or null when there is nothing to save or it is out of range. */
export function goalRunCapPatch(
  config: Pick<MutableDaemonConfig, "goals"> | null,
  draft: number,
): MutableDaemonConfigPatch | null {
  if (!Number.isInteger(draft) || draft < BOUND.min || draft > BOUND.max) return null;
  if (draft === goalRunCapOf(config)) return null;
  return { goals: { maxConcurrentRuns: draft } };
}
