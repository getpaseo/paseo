import type { TFunction } from "i18next";
import type { Goal } from "@getpaseo/protocol/goal/types";
import { describeGoalWaitingOn } from "@getpaseo/protocol/goal/waiting-on";

/**
 * What a live goal waits on, in the app's language. The protocol names the phrase with a
 * `goals.waitingOn.*` key and its params (`count` picks the plural form); its English label is
 * the fallback for a key this build has no translation for. Null for an ended goal.
 */
export function goalWaitingOnText(t: TFunction, goal: Goal): string | null {
  const waiting = describeGoalWaitingOn(goal);
  if (!waiting) {
    return null;
  }
  return t(waiting.key, { ...waiting.params, defaultValue: waiting.label });
}

/**
 * The waiting phrase only when it names tasks or changes. The detail banner already explains
 * the phase, so a fixed phrase such as "Paused until you resume it" would repeat it.
 */
export function goalWaitingOnDetail(t: TFunction, goal: Goal): string | null {
  const waiting = describeGoalWaitingOn(goal);
  if (!waiting || waiting.params.count === undefined || waiting.params.count === 0) {
    return null;
  }
  return t(waiting.key, { ...waiting.params, defaultValue: waiting.label });
}
