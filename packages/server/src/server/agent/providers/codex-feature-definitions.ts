import type { AgentOptionControl, AgentOptionToggleControl } from "../agent-sdk-types.js";

import { z } from "zod";

export const CodexServiceTierSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});
export type CodexServiceTier = z.infer<typeof CodexServiceTierSchema>;

// Which speed applies, for the runtime and for this control: an explicit `service_tier` wins;
// the pre-v0.10 `fast_mode: true` boolean counts only while `service_tier` is absent
// (`readCodexServiceTier`). The control shows it as its default, because a client selects the
// option's value when `service_tier` is set and the default when it is not.
function buildCodexSpeedControl(
  tiers: CodexServiceTier[],
  options: Record<string, unknown> | undefined,
): AgentOptionControl[] {
  if (tiers.length === 0) return [];
  const choices = [
    { value: "default", label: "Normal" },
    ...tiers.map((tier) => ({
      value: tier.id,
      label: tier.name,
      // COMPAT(codexFastPreference): added in v0.10.0, remove after 2027-03-29 once saved Fast preferences have migrated.
      ...(tier.id !== "fast" && tier.name.toLowerCase() === "fast" ? { aliases: ["fast"] } : {}),
    })),
  ];
  const implied = options?.service_tier === undefined ? readCodexServiceTier(options) : null;
  const defaultChoice = choices.find(
    (choice) => choice.value === implied || choice.aliases?.includes(implied ?? ""),
  );
  return [
    {
      type: "select",
      key: "service_tier",
      label: "Speed",
      description: "Choose processing speed. Faster tiers increase usage.",
      tooltip: "Select speed",
      icon: "zap",
      desktopTrigger: "icon",
      defaultValue: defaultChoice?.value ?? "default",
      choices,
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

export function buildCodexControls(input: {
  serviceTiers: CodexServiceTier[];
  options?: Record<string, unknown>;
  planModeAvailable?: boolean;
}): AgentOptionControl[] {
  const controls = buildCodexSpeedControl(input.serviceTiers, input.options);
  if (input.planModeAvailable !== false) {
    controls.push({ ...CODEX_PLAN_MODE_CONTROL });
  }
  return controls;
}

export function readCodexServiceTier(options: Record<string, unknown> | undefined): string | null {
  const tier = options?.service_tier;
  if (typeof tier === "string") return tier;
  // COMPAT(codexFastPreference): added in v0.10.0, remove after 2027-03-29 once saved Fast preferences have migrated.
  return options?.fast_mode ? "fast" : null;
}
