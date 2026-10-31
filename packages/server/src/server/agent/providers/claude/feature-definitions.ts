import type {
  AgentFeature,
  AgentFeatureSelect,
  AgentFeatureToggle,
} from "../../agent-sdk-types.js";
import {
  claudeManifestModelSupportsFastMode,
  claudeModelSupportsUltracode,
} from "./model-manifest.js";

export const CLAUDE_FAST_MODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "fast_mode",
  label: "Fast",
  description: "Lower latency Opus responses at higher token cost",
  tooltip: "Toggle fast mode",
  icon: "zap",
};

export const CLAUDE_ULTRACODE_FEATURE_ID = "ultracode";
export const CLAUDE_ULTRACODE_ON = "on";
export const CLAUDE_ULTRACODE_OFF = "off";

// A labeled select rather than a toggle: the toolbar shows the state in words, the way the
// effort and mode selectors do, instead of relying on the icon color alone.
export const CLAUDE_ULTRACODE_FEATURE: Omit<AgentFeatureSelect, "value"> = {
  type: "select",
  id: CLAUDE_ULTRACODE_FEATURE_ID,
  label: "Ultracode",
  description: "Plan a dynamic workflow for each substantive task, at any effort level",
  tooltip: "Select Ultracode",
  icon: "workflow",
  options: [
    { id: CLAUDE_ULTRACODE_OFF, label: "Ultracode off", isDefault: true },
    { id: CLAUDE_ULTRACODE_ON, label: "Ultracode on" },
  ],
};

export function claudeModelSupportsFastMode(modelId: string | null | undefined): boolean {
  return claudeManifestModelSupportsFastMode(modelId);
}

export { claudeModelSupportsUltracode };

export function buildClaudeFeatures(input: {
  modelId: string | null | undefined;
  fastModeEnabled: boolean;
  ultracodeEnabled: boolean;
}): AgentFeature[] {
  const features: AgentFeature[] = [];
  if (claudeModelSupportsFastMode(input.modelId)) {
    features.push({
      ...CLAUDE_FAST_MODE_FEATURE,
      value: input.fastModeEnabled,
    });
  }
  if (claudeModelSupportsUltracode(input.modelId)) {
    features.push({
      ...CLAUDE_ULTRACODE_FEATURE,
      value: input.ultracodeEnabled ? CLAUDE_ULTRACODE_ON : CLAUDE_ULTRACODE_OFF,
    });
  }
  return features;
}
