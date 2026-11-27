import type { LeadIntervention } from "./types.js";

/** The trigger of a check-in on a running task. */
export const CHECK_IN_TRIGGER = "watch";

/** The failure wake-up about a task's last attempt; exempt from the per-task cap. */
export const LAST_ATTEMPT_TRIGGER = "attempts_exhausted";

/** Triggers of a wake-up after a failed run, in the order the Manager checks them. */
export const FAILURE_TRIGGERS = [
  LAST_ATTEMPT_TRIGGER,
  // The worker ended with `TASK_STATUS: blocked`. An older daemon does not know it and sets
  // aside a log that holds one.
  "worker_blocked",
  "lead_stopped",
  "timeout",
  "repeated_failure",
] as const;
export type FailureTrigger = (typeof FAILURE_TRIGGERS)[number];

/** The trigger of the Lead's decision about recovering a failed goal. */
export const RECOVERY_TRIGGER = "recovery";

/** Which rules and caps apply to an intervention. */
export type InterventionClass = "check_in" | "failure" | "recovery";

/** The class of a trigger, or null for one this version does not know. */
export function interventionClass(
  intervention: Pick<LeadIntervention, "trigger">,
): InterventionClass | null {
  if (intervention.trigger === CHECK_IN_TRIGGER) return "check_in";
  if (intervention.trigger === RECOVERY_TRIGGER) return "recovery";
  return (FAILURE_TRIGGERS as readonly string[]).includes(intervention.trigger) ? "failure" : null;
}

/** Caps on the text an intervention records; longer text is cut. */
export const MAX_WORK_SUMMARY_CHARS = 4000;
export const MAX_INTERVENTION_ERROR_CHARS = 4000;
export const MAX_DECISION_REASON_CHARS = 2000;
export const MAX_NUDGE_CHARS = 2000;

/** Longest piece of a person's guidance: the goal's, or one task's. Longer is refused. */
export const MAX_GUIDANCE_CHARS = 4000;
/** Longest piece of the Lead's advice for one task's worker. Longer is refused. */
export const MAX_LEAD_HINT_CHARS = 1000;

/** Recoveries a goal may count over its life: those the Lead decided, applied or not. */
export const MAX_RECOVERIES = 3;

/** How long the Lead of a recovery has to decide before the Manager retries without it. */
export const RECOVERY_DECISION_MS = 20 * 60_000;

/** Text cut to `max` characters, marked when cut. */
export function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
