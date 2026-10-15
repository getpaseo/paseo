import type { AgentFeature, AgentMode } from "@getpaseo/protocol/agent-types";

export const PLAN_MODE_FEATURE_ID = "plan_mode";
export const FAST_MODE_FEATURE_ID = "fast_mode";
export const SPEED_FEATURE_ID = "service_tier";

export function isPlanningAgentMode(mode: Pick<AgentMode, "id" | "colorTier">): boolean {
  return mode.colorTier === "planning" || mode.id === "plan" || mode.id.endsWith("#plan");
}

export function isPlanModeActive({
  features,
  modes,
  selectedModeId,
}: {
  features?: readonly AgentFeature[];
  modes?: readonly AgentMode[];
  selectedModeId?: string | null;
}): boolean {
  const planToggle = features?.find(
    (feature) => feature.id === PLAN_MODE_FEATURE_ID && feature.type === "toggle",
  );
  if (planToggle) return planToggle.value === true;

  const selectedMode = modes?.find((mode) => mode.id === selectedModeId);
  return selectedMode ? isPlanningAgentMode(selectedMode) : false;
}

export function resolvePlanModeTarget(
  modes: readonly AgentMode[],
  selectedModeId: string | null | undefined,
): string | null {
  const planMode = modes.find(isPlanningAgentMode);
  if (!planMode) return null;
  return selectedModeId === planMode.id ? resolveNonPlanningModeId(modes, null) : planMode.id;
}

export function resolveNonPlanningModeId(
  modes: readonly AgentMode[],
  defaultModeId: string | null,
): string | null {
  const defaultMode = modes.find((mode) => mode.id === defaultModeId);
  if (defaultMode && !isPlanningAgentMode(defaultMode)) {
    return defaultMode.id;
  }
  return (
    modes.find((mode) => mode.isUnattended && !isPlanningAgentMode(mode))?.id ??
    modes.find((mode) => !isPlanningAgentMode(mode))?.id ??
    null
  );
}
