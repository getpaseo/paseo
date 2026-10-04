import type { AgentFeature, AgentFeatureToggle, AgentMode } from "@getpaseo/protocol/agent-types";

export const PLAN_MODE_FEATURE_ID = "plan_mode";
export const FAST_MODE_FEATURE_ID = "fast_mode";

export function isPlanningAgentMode(mode: Pick<AgentMode, "id" | "colorTier">): boolean {
  return mode.colorTier === "planning" || mode.id === "plan" || mode.id.endsWith("#plan");
}

export function resolveNonPlanningModeId(
  modes: readonly AgentMode[],
  defaultModeId: string | null,
): string | null {
  const defaultMode = modes.find((mode) => mode.id === defaultModeId);
  if (defaultMode && !isPlanningAgentMode(defaultMode)) {
    return defaultMode.id;
  }
  return modes.find((mode) => !isPlanningAgentMode(mode))?.id ?? null;
}

export function findPlanModeToggle(
  features: readonly AgentFeature[] | undefined,
): AgentFeatureToggle | null {
  const feature = features?.find((entry) => entry.id === PLAN_MODE_FEATURE_ID);
  return feature?.type === "toggle" ? feature : null;
}

/**
 * With a Plan toggle, the provider's planning mode is that toggle, not an access choice. A
 * planning mode that is still selected, such as one saved in a draft, stays visible.
 */
export function resolveAccessModeOptions(
  modes: readonly AgentMode[],
  hasPlanToggle: boolean,
  selectedModeId: string | null | undefined,
): readonly AgentMode[] {
  if (!hasPlanToggle) {
    return modes;
  }
  return modes.filter((mode) => !isPlanningAgentMode(mode) || mode.id === selectedModeId);
}
