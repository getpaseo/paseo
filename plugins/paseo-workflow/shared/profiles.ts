import type { AgentProfile } from "@getpaseo/protocol/messages";

export const roles = [
  "router",
  "planner",
  "plan-reviewer",
  "executor-standard",
  "executor-advanced",
  "final-review",
  "audit-economic",
  "audit-deep",
  "audit-security",
] as const;
export type Role = (typeof roles)[number];
export const profileId = (role: Role) => `paseo-workflow-${role}`;

const defaults: Record<Role, { model: string; thinkingOptionId: string }> = {
  router: { model: "gpt-5.6-luna", thinkingOptionId: "low" },
  planner: { model: "gpt-6-astra", thinkingOptionId: "high" },
  "plan-reviewer": { model: "gpt-6-astra", thinkingOptionId: "high" },
  "executor-standard": { model: "gpt-5.6-sol", thinkingOptionId: "medium" },
  "executor-advanced": { model: "gpt-6-astra", thinkingOptionId: "high" },
  "final-review": { model: "gpt-6-astra", thinkingOptionId: "high" },
  "audit-economic": { model: "gpt-5.6-luna", thinkingOptionId: "low" },
  "audit-deep": { model: "gpt-6-astra", thinkingOptionId: "high" },
  "audit-security": { model: "gpt-6-astra", thinkingOptionId: "xhigh" },
};

export const profiles: AgentProfile[] = roles.map((role) => {
  const { model, thinkingOptionId } = defaults[role];
  const profile: AgentProfile = {
    id: profileId(role),
    name: `Workflow · ${role}`,
    provider: "codex",
    model,
    modeId: "auto",
    thinkingOptionId,
  };
  if (role === "planner") {
    profile.featureValues = { plan_mode: true };
    profile.postApprovalModeId = "auto";
  }
  return profile;
});
