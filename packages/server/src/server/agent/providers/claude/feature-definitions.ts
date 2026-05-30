import type { AgentFeature, AgentFeatureToggle } from "../../agent-sdk-types.js";

const CLAUDE_FAST_MODE_SUPPORTED_MODEL_PREFIXES = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
] as const;

export const CLAUDE_FAST_MODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "fast_mode",
  label: "Fast",
  description: "Lower latency Opus responses at higher token cost",
  tooltip: "Toggle fast mode",
  icon: "zap",
};

function normalizeClaudeModelId(modelId: string | null | undefined): string | null {
  const normalized = typeof modelId === "string" ? modelId.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

export function claudeModelSupportsFastMode(modelId: string | null | undefined): boolean {
  const normalizedModelId = normalizeClaudeModelId(modelId);
  if (!normalizedModelId) {
    return false;
  }

  return CLAUDE_FAST_MODE_SUPPORTED_MODEL_PREFIXES.some(
    (prefix) => normalizedModelId === prefix || normalizedModelId.startsWith(`${prefix}[`),
  );
}

export function buildClaudeFeatures(input: {
  modelId: string | null | undefined;
  fastModeEnabled: boolean;
}): AgentFeature[] {
  if (!claudeModelSupportsFastMode(input.modelId)) {
    return [];
  }

  return [
    {
      ...CLAUDE_FAST_MODE_FEATURE,
      value: input.fastModeEnabled,
    },
  ];
}
