import type { AgentFeature, AgentFeatureToggle } from "../agent-sdk-types.js";

// Fallback for models the app-server catalog does not describe (custom
// endpoints, catalog fetch failures). Catalog speed tiers win when present.
const CODEX_FAST_MODE_SUPPORTED_MODEL_PREFIXES = ["gpt-5", "gpt-4.1", "o3", "o4-mini"] as const;

export const CODEX_FAST_SPEED_TIER = "fast";

export interface CodexModelServiceTier {
  id: string;
  name?: string;
  description?: string;
}

export interface CodexModelSpeedInfo {
  additionalSpeedTiers: string[];
  serviceTiers: CodexModelServiceTier[];
}

export interface CodexFastModeAvailability {
  available: boolean;
  description?: string;
}

export const CODEX_FAST_MODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "fast_mode",
  label: "Fast",
  description: "Priority inference at 2x usage",
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

export const CODEX_CONTEXT_NOTES_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "context_notes",
  label: "Notes",
  description: "Keep notes across context windows (experimental)",
  tooltip: "Toggle context notes",
  icon: "notebook-pen",
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
  return CODEX_FAST_MODE_SUPPORTED_MODEL_PREFIXES.some(
    (prefix) => normalizedModelId === prefix || normalizedModelId.startsWith(prefix),
  );
}

export function resolveCodexFastModeAvailability(
  modelId: string | null | undefined,
  speedInfo: CodexModelSpeedInfo | undefined,
): CodexFastModeAvailability {
  if (!speedInfo) {
    return { available: codexModelSupportsFastMode(modelId) };
  }
  const available = speedInfo.additionalSpeedTiers.includes(CODEX_FAST_SPEED_TIER);
  if (!available) {
    return { available: false };
  }
  const description = speedInfo.serviceTiers.find(
    (tier) => tier.id === "priority" || tier.name === "Fast",
  )?.description;
  return description ? { available, description } : { available };
}

export function buildCodexFeatures(input: {
  fastMode: CodexFastModeAvailability;
  fastModeEnabled: boolean;
  planModeEnabled: boolean;
  contextNotesEnabled: boolean;
  planModeAvailable?: boolean;
}): AgentFeature[] {
  const features: AgentFeature[] = [];

  if (input.fastMode.available) {
    features.push({
      ...CODEX_FAST_MODE_FEATURE,
      ...(input.fastMode.description ? { description: input.fastMode.description } : {}),
      value: input.fastModeEnabled,
    });
  }

  if (input.planModeAvailable !== false) {
    features.push({
      ...CODEX_PLAN_MODE_FEATURE,
      value: input.planModeEnabled,
    });
  }

  features.push({
    ...CODEX_CONTEXT_NOTES_FEATURE,
    value: input.contextNotesEnabled,
  });

  return features;
}
