import type { AgentOptionControl, AgentOptionToggleControl } from "../agent-sdk-types.js";

import { z } from "zod";

export const CodexServiceTierSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
});
export type CodexServiceTier = z.infer<typeof CodexServiceTierSchema>;

// Newer Codex versions accept Flex as a request option without advertising it per model.
const CODEX_FLEX_SERVICE_TIER: CodexServiceTier = {
  id: "flex",
  name: "Flex",
  description: "Slower processing, reduced usage",
};

export function codexSpeedTiers(
  catalogTiers: CodexServiceTier[],
  supportsUnadvertisedFlex: boolean,
): CodexServiceTier[] {
  if (
    !supportsUnadvertisedFlex ||
    catalogTiers.some((tier) => tier.id === CODEX_FLEX_SERVICE_TIER.id)
  ) {
    return catalogTiers;
  }
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

/** What `model/list` says a model accepts as a turn's `cyberAccessProgram`, for this account. */
export const CodexAccessProgramsSchema = z.object({
  cyber: z.array(z.string()).optional(),
});
export type CodexAccessPrograms = z.infer<typeof CodexAccessProgramsSchema>;

// Codex asks for Blue when a model offers both (`ModelAccessPrograms::daybreak` in codex-rs).
const CODEX_DAYBREAK_PROGRAMS = ["daybreakBlue", "daybreakRed"];

export const CODEX_DAYBREAK_CONTROL: AgentOptionToggleControl = {
  type: "toggle",
  key: "daybreak",
  label: "Daybreak",
  description: "Run turns under your account's Daybreak access for security work",
  tooltip: "Toggle Daybreak",
  icon: "sun",
};

export function codexOffersDaybreak(programs: string[]): boolean {
  return CODEX_DAYBREAK_PROGRAMS.some((program) => programs.includes(program));
}

/**
 * The `cyberAccessProgram` a turn asks for, chosen the way Codex's own clients choose it: on asks
 * for the model's Daybreak program, off asks for `standard`, and unset sends nothing so Codex
 * keeps its automatic treatment. A program the model does not offer is never sent, because
 * Codex fails the whole turn over it.
 */
export function codexCyberAccessProgram(input: {
  programs: string[];
  daybreak: boolean | null;
}): string | null {
  const { programs, daybreak } = input;
  if (daybreak === null) return null;
  if (!daybreak) return programs.includes("standard") ? "standard" : null;
  return CODEX_DAYBREAK_PROGRAMS.find((program) => programs.includes(program)) ?? null;
}

export function readCodexDaybreak(options: Record<string, unknown> | undefined): boolean | null {
  const daybreak = options?.daybreak;
  return typeof daybreak === "boolean" ? daybreak : null;
}

export function buildCodexControls(input: {
  serviceTiers: CodexServiceTier[];
  planModeAvailable?: boolean;
  daybreakAvailable?: boolean;
}): AgentOptionControl[] {
  const controls = buildCodexSpeedControl(input.serviceTiers);
  if (input.planModeAvailable !== false) {
    controls.push({ ...CODEX_PLAN_MODE_CONTROL });
  }
  if (input.daybreakAvailable) {
    controls.push({ ...CODEX_DAYBREAK_CONTROL });
  }
  return controls;
}

export function readCodexServiceTier(options: Record<string, unknown> | undefined): string | null {
  const tier = options?.service_tier;
  return typeof tier === "string" ? tier : null;
}
