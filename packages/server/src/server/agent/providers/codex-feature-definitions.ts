import type { AgentOptionControl, AgentOptionToggleControl } from "../agent-sdk-types.js";

import { z } from "zod";

export const CodexServiceTierSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});
export type CodexServiceTier = z.infer<typeof CodexServiceTierSchema>;

/**
 * Codex's slow tier, known to Paseo rather than discovered.
 *
 * Every other speed arrives in the model list's `serviceTiers`, and Codex never lists Flex there:
 * `ModelInfo::supports_service_tier` (codex-rs/protocol/src/openai_models.rs) treats Flex as an
 * API request option that is valid whatever the model advertises. Waiting for the catalog to name
 * it would leave `service_tier = "flex"` — a documented Codex config value — unselectable here.
 */
const CODEX_FLEX_SERVICE_TIER: CodexServiceTier = {
  id: "flex",
  name: "Flex",
  description: "Slower processing, reduced usage",
};

/** The speeds offered for one model: Flex, then whatever tiers the catalog advertises for it. */
export function codexSpeedTiers(catalogTiers: CodexServiceTier[]): CodexServiceTier[] {
  // A catalog that does advertise Flex keeps its own entry, so its name and description draw.
  if (catalogTiers.some((tier) => tier.id === CODEX_FLEX_SERVICE_TIER.id)) return catalogTiers;
  return [CODEX_FLEX_SERVICE_TIER, ...catalogTiers];
}

function buildCodexSpeedControl(tiers: CodexServiceTier[]): AgentOptionControl[] {
  if (tiers.length === 0) return [];
  return [
    {
      type: "select",
      key: "service_tier",
      label: "Speed",
      description: "Choose processing speed. Faster tiers increase usage.",
      tooltip: "Select speed",
      icon: "zap",
      desktopTrigger: "icon",
      defaultValue: "default",
      choices: [
        { value: "default", label: "Normal" },
        ...tiers.map((tier) => ({ value: tier.id, label: tier.name })),
      ],
    },
  ];
}

export const CODEX_PLAN_MODE_CONTROL: AgentOptionToggleControl = {
  type: "toggle",
  key: "plan_mode",
  label: "Plan",
  description: "Switch Codex into planning-only collaboration mode",
  tooltip: "Toggle plan mode",
  icon: "list-todo",
};

/** Build the composer controls from the tiers already offered, Flex included. */
export function buildCodexControls(input: {
  serviceTiers: CodexServiceTier[];
  planModeAvailable?: boolean;
}): AgentOptionControl[] {
  const controls = buildCodexSpeedControl(input.serviceTiers);
  if (input.planModeAvailable !== false) {
    controls.push({ ...CODEX_PLAN_MODE_CONTROL });
  }
  return controls;
}

export function readCodexServiceTier(options: Record<string, unknown> | undefined): string | null {
  const tier = options?.service_tier;
  return typeof tier === "string" ? tier : null;
}
