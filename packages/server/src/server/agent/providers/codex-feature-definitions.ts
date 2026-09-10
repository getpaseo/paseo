import type { AgentFeature, AgentFeatureToggle } from "../agent-sdk-types.js";

// Codex Fast is distinct from API Priority processing. Keep model support aligned with
// https://developers.openai.com/codex/speed and https://developers.openai.com/codex/models.
const CODEX_FAST_MODE_SUPPORTED_MODELS = new Set([
  "gpt-6-astra",
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
]);

export const CODEX_FAST_MODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "fast_mode",
  label: "Fast",
  description: "Priority inference at increased usage",
  tooltip: "Toggle fast mode",
  icon: "zap",
};

export const CODEX_PLAN_MODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "plan_mode",
  label: "Plan",
  description: "Switch Codex into planning-only collaboration mode",
  tooltip: "Toggle plan mode",
  icon: "list-todo",
};

function normalizeCodexModelId(modelId: string | null | undefined): string | null {
  const normalized = typeof modelId === "string" ? modelId.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

export function codexModelSupportsFastMode(modelId: string | null | undefined): boolean {
  const normalizedModelId = normalizeCodexModelId(modelId);
  if (!normalizedModelId) {
    return false;
  }
  return CODEX_FAST_MODE_SUPPORTED_MODELS.has(normalizedModelId);
}

export function buildCodexFeatures(input: {
  modelId: string | null | undefined;
  fastModeEnabled: boolean;
  planModeEnabled: boolean;
  planModeAvailable?: boolean;
}): AgentFeature[] {
  const features: AgentFeature[] = [];

  if (codexModelSupportsFastMode(input.modelId)) {
    features.push({
      ...CODEX_FAST_MODE_FEATURE,
      value: input.fastModeEnabled,
    });
  }

  if (input.planModeAvailable !== false) {
    features.push({
      ...CODEX_PLAN_MODE_FEATURE,
      value: input.planModeEnabled,
    });
  }

  return features;
}
