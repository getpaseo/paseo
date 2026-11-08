import type { AgentFeature, AgentFeatureToggle } from "../agent-sdk-types.js";

import { z } from "zod";

export const CodexServiceTierSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});
export type CodexServiceTier = z.infer<typeof CodexServiceTierSchema>;

export function normalizeCodexServiceTiers(model: {
  serviceTiers?: unknown;
  additionalSpeedTiers?: unknown;
}): CodexServiceTier[] {
  const tiers = new Map<string, CodexServiceTier>();
  for (const field of [model.serviceTiers, model.additionalSpeedTiers]) {
    let entries: unknown[] = [];
    if (Array.isArray(field)) {
      entries = field;
    } else if (typeof field === "string") {
      entries = field
        .split(",")
        .map((tier) => tier.trim())
        .filter(Boolean);
    }
    for (const entry of entries) {
      const record =
        typeof entry === "object" && entry !== null && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : null;
      const id = typeof entry === "string" ? entry : record?.id;
      if (typeof id !== "string" || !id.trim() || id === "default" || tiers.has(id)) {
        continue;
      }
      tiers.set(id, {
        id,
        name: typeof record?.name === "string" && record.name.trim() ? record.name : id,
        description: typeof record?.description === "string" ? record.description : "",
      });
    }
  }
  return [...tiers.values()];
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
  if (values && Object.prototype.hasOwnProperty.call(values, "service_tier")) return null;
  // COMPAT(codexFastPreference): added in v0.10.0, remove after 2027-03-29 once saved Fast preferences have migrated.
  return values?.fast_mode === true ? "fast" : null;
}
