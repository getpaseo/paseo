import type { DraftAgentControlsProps } from "@/composer/agent-controls";
import type { AgentMode } from "@getpaseo/protocol/agent-types";
import { isPlanningAgentMode } from "@/agent-controls/policy";

export function resolveNextAgentModeId({
  modeOptions,
  selectedMode,
}: {
  modeOptions: readonly AgentMode[];
  selectedMode: string | null | undefined;
}): string | null {
  if (modeOptions.length < 2) return null;

  const selectedIndex = modeOptions.findIndex((mode) => mode.id === selectedMode);
  const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const nextIndex = (currentIndex + 1) % modeOptions.length;
  return modeOptions[nextIndex]?.id ?? null;
}

export type AgentModeCycleStep =
  | { kind: "mode"; modeId: string }
  | { kind: "plan-on" }
  | { kind: "plan-off"; modeId: string };

/**
 * Shift+Tab walks the provider's modes in order. When the agent also has a Plan toggle, the
 * planning mode's stop turns that toggle on and keeps the access mode, and the next stop turns it
 * off on the following mode. Providers without both keep plain mode cycling.
 */
export function resolveAgentModeCycleStep({
  modeOptions,
  selectedMode,
  planEnabled,
}: {
  modeOptions: readonly AgentMode[];
  selectedMode: string | null | undefined;
  /** The Plan toggle's value, or null when the agent has no Plan toggle. */
  planEnabled: boolean | null;
}): AgentModeCycleStep | null {
  const planIndex = modeOptions.findIndex(isPlanningAgentMode);
  if (planEnabled === null || planIndex < 0) {
    const modeId = resolveNextAgentModeId({ modeOptions, selectedMode });
    return modeId ? { kind: "mode", modeId } : null;
  }
  if (modeOptions.length < 2) return null;

  const selectedIndex = modeOptions.findIndex((mode) => mode.id === selectedMode);
  const currentIndex = planEnabled ? planIndex : Math.max(selectedIndex, 0);
  const next = modeOptions[(currentIndex + 1) % modeOptions.length];
  if (!next) return null;
  if (isPlanningAgentMode(next)) {
    return { kind: "plan-on" };
  }
  return planEnabled ? { kind: "plan-off", modeId: next.id } : { kind: "mode", modeId: next.id };
}

export function resolveAgentControlsMode(agentControls?: DraftAgentControlsProps) {
  return agentControls ? "draft" : "ready";
}
