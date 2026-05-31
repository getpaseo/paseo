export const CLIENT_CAPS = {
  firstClassPlans: "first_class_plans",
  reasoningMergeEnum: "reasoning_merge_enum",
  // COMPAT(customModeIcons): added in v0.1.84. Old clients pin AgentModeIcon to
  // a closed enum and crash rendering unknown values; daemon downgrades icons
  // outside the legacy set to "ShieldCheck" when this cap is absent. Drop the
  // gate when floor >= v0.1.84.
  customModeIcons: "custom_mode_icons",
} as const;

export type ClientCapability = (typeof CLIENT_CAPS)[keyof typeof CLIENT_CAPS];
