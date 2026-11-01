import type { Goal } from "@getpaseo/protocol/goal/types";
import type { GoalFormPrefill } from "./goal-form-model";
import { unmetCriteria } from "./goal-recovery";
import { goalSettingsEditValues } from "./goal-settings-form-model";

/**
 * A follow-up goal can start from a failed managed goal: it builds on what that goal merged, with
 * the same project and settings.
 */
export function canStartFollowUp(goal: Pick<Goal, "status" | "config" | "integration">): boolean {
  return (
    goal.status === "failed" &&
    goal.config !== null &&
    Boolean(goal.integration?.headCommit ?? goal.config.baseCommit)
  );
}

/** The sentences the prefill is worded with, already translated. */
export interface FollowUpCopy {
  /** The follow-up's title for a goal title, such as "<title> — follow-up". */
  title: (title: string) => string;
  /** Opens the objective; the criteria left to meet follow on their own lines. */
  objectiveIntro: string;
  /** Introduces the list of criteria not verified, whether checked and failed or never checked. */
  unmetIntro: string;
}

/** A criterion as one line: a newline inside it would split it into two criteria. */
function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ").trim();
}

/**
 * The follow-up's title. A follow-up of a follow-up keeps one suffix: the title is read without
 * the wording `copy.title` adds before wording it again.
 */
function followUpTitle(title: string, copy: FollowUpCopy): string {
  const marker = "\u0000";
  const [before = "", after = ""] = copy.title(marker).split(marker);
  let base = title.trim();
  if (after && base.endsWith(after)) base = base.slice(0, -after.length).trim();
  if (before && base.startsWith(before)) base = base.slice(before.length).trim();
  return copy.title(base || title.trim());
}

/**
 * The create form's prefill for a follow-up of a failed goal. Its criteria are the ones not
 * verified; when every one was verified and the goal failed for another reason, all of them are
 * asked again. The objective lists the unverified ones as plain text you can edit. The Lead's words stay out of it: you read them in the banner and decide what to ask.
 * It builds on the failed goal's integration head, or the commit that goal started from.
 */
export function buildFollowUpPrefill(goal: Goal, copy: FollowUpCopy): GoalFormPrefill | null {
  const config = goal.config;
  if (!canStartFollowUp(goal) || !config) {
    return null;
  }
  const unmet = unmetCriteria(goal).map((criterion) => oneLine(criterion.text));
  const criteria = unmet.length > 0 ? unmet : goal.criteria.map((c) => oneLine(c.text));
  const objective = [
    copy.objectiveIntro,
    ...(unmet.length > 0 ? ["", copy.unmetIntro, ...unmet.map((text) => `- ${text}`)] : []),
    ...(goal.objective.trim() ? ["", goal.objective.trim()] : []),
  ].join("\n");
  const edit = goalSettingsEditValues(config);
  const commit = goal.integration?.headCommit ?? config.baseCommit ?? "";
  return {
    title: followUpTitle(goal.title, copy),
    objective,
    criteriaText: criteria.join("\n"),
    managed: true,
    cwd: config.cwd,
    leadProvider: config.leadProvider,
    defaultProvider: config.defaultProvider,
    // Every setting is set, empty ones too, so your last goal's remembered ones never fill a gap.
    reviewProvider: config.reviewProvider ?? "",
    leadThinking: config.leadThinking ?? "",
    workerThinking: config.workerThinking ?? "",
    reviewThinking: config.reviewThinking ?? "",
    verifyThinking: config.verifyThinking ?? "",
    testCommand: edit.testCommand,
    allowedProviders: [...(config.allowedProviders ?? [])],
    settings: edit.settings,
    budget: edit.budget,
    baseCommit: {
      commit,
      goalTitle: goal.title,
      branch: goal.integration?.branch ?? null,
    },
  };
}
