import type { GoalFormPrefill } from "./goal-form-model";
import type { GoalPresetId } from "./goal-settings";

export type GoalTemplateId = "fix_bug" | "feature_with_tests" | "refactor_review" | "update_docs";

export interface GoalTemplate {
  id: GoalTemplateId;
  /** The settings that suit the work: a careful refactor, a quick docs pass. */
  preset: GoalPresetId;
}

export const GOAL_TEMPLATES: readonly GoalTemplate[] = [
  { id: "fix_bug", preset: "balanced" },
  { id: "feature_with_tests", preset: "balanced" },
  { id: "refactor_review", preset: "careful" },
  { id: "update_docs", preset: "turbo" },
];

export interface GoalTemplateText {
  objective: string;
  /** One criterion per line. */
  criteria: string;
}

/** The form seeded from a template, on top of what the form would start with anyway. */
export function buildTemplatePrefill(
  template: GoalTemplate,
  text: GoalTemplateText,
  base: GoalFormPrefill,
): GoalFormPrefill {
  return {
    ...base,
    managed: true,
    objective: text.objective,
    criteriaText: text.criteria,
    preset: template.preset,
  };
}
