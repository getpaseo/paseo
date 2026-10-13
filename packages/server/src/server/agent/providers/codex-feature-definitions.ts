import type { AgentFeature, AgentFeatureToggle } from "../agent-sdk-types.js";

import { z } from "zod";

export const CodexServiceTierSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});
export type CodexServiceTier = z.infer<typeof CodexServiceTierSchema>;

export interface CodexSpeedFeatureGateOptions {
  supportsIndependentSpeedModes?: boolean;
  features?: {
    fast_mode?: boolean;
    ultrafast_mode?: boolean;
  };
}

export function isFastCodexServiceTier(tier: CodexServiceTier): boolean {
  const id = tier.id.toLowerCase();
  const name = tier.name.toLowerCase();
  return id === "priority" || id === "fast" || name === "fast";
}

export function isUltrafastCodexServiceTier(tier: CodexServiceTier): boolean {
  const id = tier.id.toLowerCase();
  const name = tier.name.toLowerCase().replace(/\s+/g, "");
  return id === "ultrafast" || name === "ultrafast";
}

export function filterCodexServiceTiers(
  tiers: CodexServiceTier[],
  gates: CodexSpeedFeatureGateOptions = {},
): CodexServiceTier[] {
  return tiers.filter((tier) => {
    if (isFastCodexServiceTier(tier) && gates.features?.fast_mode === false) {
      return false;
    }
    if (
      isUltrafastCodexServiceTier(tier) &&
      gates.supportsIndependentSpeedModes &&
      gates.features?.ultrafast_mode === false
    ) {
      return false;
    }
    return true;
  });
}

function buildCodexSpeedFeature(tiers: CodexServiceTier[], value: string): AgentFeature[] {
  if (tiers.length === 0) return [];
  return [
    {
      type: "select",
      id: "service_tier",
      label: "Speed",
      description: "Choose processing speed. Faster tiers increase usage.",
      tooltip: "Select speed",
      icon: "zap",
      desktopTrigger: "icon",
      value,
      options: [
        { id: "default", label: "Normal", isDefault: true },
        ...tiers.map((tier) => ({ id: tier.id, label: tier.name })),
      ],
    },
  ];
}

export const CODEX_PLAN_MODE_FEATURE: Omit<AgentFeatureToggle, "value"> = {
  type: "toggle",
  id: "plan_mode",
  label: "Plan",
  description: "Switch Codex into planning-only collaboration mode",
  tooltip: "Toggle plan mode",
  icon: "list-todo",
};

export function buildCodexFeatures(input: {
  serviceTiers: CodexServiceTier[];
  serviceTier: string;
  planModeEnabled: boolean;
  planModeAvailable?: boolean;
}): AgentFeature[] {
  const features = buildCodexSpeedFeature(input.serviceTiers, input.serviceTier);
  if (input.planModeAvailable !== false) {
    features.push({ ...CODEX_PLAN_MODE_FEATURE, value: input.planModeEnabled });
  }
  return features;
}

export function readCodexServiceTier(values: Record<string, unknown> | undefined): string | null {
  const tier = values?.service_tier;
  if (typeof tier === "string") return tier;
  // COMPAT(codexFastPreference): added in v0.10.0, remove after 2027-03-29 once saved Fast preferences have migrated.
  return values?.fast_mode ? "fast" : null;
}
